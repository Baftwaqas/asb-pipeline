// ============================================================================
// Phase 1 hardening: immutable intake facts, audit-only payloads, operator
// tools, deactivation guards, safety mode, rehearsal guards, and the known
// Phase-2 blocker recorded as a TODO test.
// ============================================================================

"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const net = require("net");
const { spawn } = require("child_process");
const { Pool } = require("pg");
const H = require("./support/harness");

const ROOT = path.join(__dirname, "..");
let db, server, base, sent, worker, registry, registryScript, review, rehearsal;
let orderSeq = 7700000000000;
let hookSeq = 0;
const nextHook = () => `hard-hook-${process.pid}-${++hookSeq}`;

async function loadSnapshot(q) {
  const snap = JSON.parse(fs.readFileSync(path.join(ROOT, "db/community/registry-snapshot-2026-10-08.json"), "utf8"));
  await registryScript.bootstrapSnapshot(q, snap.products, { file: "registry-snapshot-2026-10-08.json", apply: true });
}

before(async () => {
  const url = await H.createDatabase("asb_t_hardening", ROOT);
  H.setEnv(url);
  sent = H.stubOutside(ROOT);
  const mod = require(path.join(ROOT, "server.js"));
  db = require(path.join(ROOT, "db"));
  worker = require(path.join(ROOT, "community", "worker.js"));
  registry = require(path.join(ROOT, "community", "registry.js"));
  registryScript = require(path.join(ROOT, "scripts", "community-registry.js"));
  review = require(path.join(ROOT, "scripts", "community-review.js"));
  rehearsal = require(path.join(ROOT, "scripts", "community-rehearsal.js"));
  await require(path.join(ROOT, "productSync.js")).ensureSchema(db);
  await db.query(H.FIXTURE_SQL);
  await loadSnapshot(db);
  server = mod.app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await db?.shutdown();
});

async function sendOrder(lines, extra = {}, hook = nextHook()) {
  const id = extra.id || ++orderSeq;
  const order = H.shopifyOrder({ id, name: `#H${id % 100000}`, lines, currency: "PKR", ...extra });
  order.currency = "PKR";
  const body = Buffer.from(JSON.stringify(order));
  const status = await H.postShopify(base, order, { id: hook });
  await H.waitWebhookDone(db, "shopify", hook);
  return { id, order, hook, status, sha: crypto.createHash("sha256").update(body).digest("hex") };
}
const intakeFor = async (orderId) =>
  (await db.query(`SELECT * FROM community_intake WHERE shopify_order_id = $1 ORDER BY id`, [String(orderId)])).rows;

// ---------------------------------------------------------------------------
// 1. Durable, immutable order-time facts
// ---------------------------------------------------------------------------

test("intake keeps every order-time fact Phase 2 needs, self-contained", async () => {
  const line = H.line({ ...H.COMMUNITY.onion5Draft }, 1);
  const { id, order, hook, sha } = await sendOrder([line]);
  const [r] = await intakeFor(id);
  const ev = (await db.query(`SELECT id, payload FROM webhook_events WHERE event_id = $1`, [hook])).rows[0];
  assert.equal(r.shop, H.SHOP);
  assert.equal(r.shopify_order_id, String(id));
  assert.equal(r.shopify_line_item_id, String(line.id));
  assert.equal(r.shopify_order_name, order.name);
  assert.equal(r.shopify_product_id, "10341692014850");
  assert.equal(r.shopify_variant_id, "50595473817858");
  assert.equal(r.quantity, 1);
  assert.equal(r.sku, "ASB-COM-DEMO-ONION-5KG");
  assert.equal(r.variant_title, "5 kg");
  assert.equal(Number(r.unit_price), 700);
  assert.equal(r.currency, "PKR");
  assert.equal(new Date(r.order_created_at).toISOString(), new Date(order.created_at).toISOString());
  assert.deepEqual(r.line_payload, line);
  assert.deepEqual(r.order_payload, order, "the whole order as received, inside the intake row itself");
  assert.equal(r.order_raw, JSON.stringify(order), "the request body, byte for byte");
  assert.equal(r.order_payload_sha256, sha, "fingerprint of the raw bytes Shopify sent");
  assert.equal(crypto.createHash("sha256").update(r.order_raw, "utf8").digest("hex"), r.order_payload_sha256,
               "the fingerprint can be re-verified from stored data alone");
  assert.equal(r.webhook_event_id, ev.id);
  assert.deepEqual(ev.payload, order);
});

test("captured facts are immutable, rows cannot be deleted, illegal transitions refused", async () => {
  const { id } = await sendOrder([H.line(H.COMMUNITY.tomato10Draft, 1)]);
  const [r] = await intakeFor(id);
  await assert.rejects(db.query(`UPDATE community_intake SET sku = 'X' WHERE id = $1`, [r.id]), /immutable/);
  await assert.rejects(db.query(`UPDATE community_intake SET order_payload = '{}' WHERE id = $1`, [r.id]), /immutable/);
  await assert.rejects(db.query(`UPDATE community_intake SET quantity = 1, shopify_variant_id = '1' WHERE id = $1`, [r.id]), /immutable/);
  await assert.rejects(db.query(`UPDATE community_intake SET order_raw = '{}' WHERE id = $1`, [r.id]), /immutable/);
  await assert.rejects(db.query(`UPDATE community_intake SET id = id + 100000 WHERE id = $1`, [r.id]), /immutable/);
  await assert.rejects(db.query(`DELETE FROM community_intake WHERE id = $1`, [r.id]), /never deleted/);
  await assert.rejects(db.query(`UPDATE community_intake SET resolved_variant_gid = 'x' WHERE id = $1`, [r.id]),
                       /community_intake_unresolved_chk/, "no resolution on an unresolved row");
  await worker.runOnce(db);
  const [done] = await intakeFor(id);
  assert.equal(done.status, "resolved");
  await assert.rejects(db.query(`UPDATE community_intake SET status = 'received' WHERE id = $1`, [r.id]), /cannot move resolved -> received/);
  await assert.rejects(db.query(`UPDATE community_intake SET status = 'review', review_reason = 'x' WHERE id = $1`, [r.id]), /cannot move/);
  await assert.rejects(db.query(`UPDATE community_intake SET resolved_variant_gid = 'gid://other' WHERE id = $1`, [r.id]), /is final/);
  for (const t of ["community_intake", "community_audit", "community_products", "community_variants"]) {
    await assert.rejects(db.query(`TRUNCATE ${t} CASCADE`), /cannot be truncated/, t);
  }
  await assert.rejects(db.query(`TRUNCATE webhook_events CASCADE`), /cannot be truncated/);
  await assert.rejects(db.query(`DELETE FROM community_variants WHERE shopify_variant_id = '50595474014466'`), /never deleted/);
  // The webhook event an intake row points at cannot be deleted either.
  await assert.rejects(db.query(`DELETE FROM webhook_events WHERE id = $1`, [r.webhook_event_id]), /foreign key/);
});

test("a later delivery of the same order never rewrites the first capture", async () => {
  const line = H.line(H.COMMUNITY.onion5Draft, 1);
  const first = await sendOrder([line]);
  const [before] = await intakeFor(first.id);
  const changed = { ...first.order, note: "edited later", line_items: [{ ...line, quantity: 3 }] };
  const hook2 = nextHook();
  assert.equal(await H.postShopify(base, changed, { id: hook2, topic: "orders/create" }), 200);
  await H.waitWebhookDone(db, "shopify", hook2);
  const rows = await intakeFor(first.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].quantity, 1);
  assert.deepEqual(rows[0].order_payload, before.order_payload);
  assert.equal(rows[0].webhook_event_id, before.webhook_event_id);
});

// ---------------------------------------------------------------------------
// 2. The full original payload is audit-only
// ---------------------------------------------------------------------------

test("tripwire: no code reads orders.source_payload or Shopify webhook payloads back", () => {
  const files = [];
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      if (["node_modules", ".git", "test"].includes(f.name)) continue;
      const p = path.join(d, f.name);
      if (f.isDirectory()) walk(p);
      else if (/\.(js|sql|html)$/.test(f.name)) files.push(p);
    }
  };
  walk(ROOT);
  const hits = [];
  for (const f of files) {
    const rel = path.relative(ROOT, f);
    fs.readFileSync(f, "utf8").split("\n").forEach((line, i) => {
      if (/source_payload/.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim()}`);
      if (/order_payload|line_payload/.test(line) && !/^db\/migrations\/016|^community\/intake\.js|^scripts\/community-/.test(rel)) {
        hits.push(`${rel}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  // Allowed: the column definition, the one INSERT in the bag writer, comments.
  const allowed = hits.filter((h) =>
    /^db\/migrations\/001_init\.sql:\d+: source_payload\s+JSONB/.test(h) ||
    /^grocery\/write\.js:\d+:\s+source_payload, placed_at\)/.test(h) ||
    /^(server\.js|grocery\/write\.js|community\/sanitize\.js):\d+: \/\//.test(h) ||
    // the split marker's explanatory text (a string literal, not a read)
    /^community\/sanitize\.js:\d+: "Original order:/.test(h) ||
    // the rehearsal tool reads it only to VERIFY sanitization on a staging copy
    /^scripts\/community-rehearsal\.js:/.test(h));
  assert.deepEqual(hits.filter((h) => !allowed.includes(h)), [],
    "a new reader of a raw/original payload appeared - grocery logic must only use sanitized lines");
  assert.ok(allowed.some((h) => h.startsWith("grocery/write.js")), "the INSERT is still the only writer");
});

test("sanitized grocery view is an allow-list and the backstop rejects any Community line in it", async () => {
  const { groceryOnlyOrder, GROCERY_ORDER_FIELDS } = require(path.join(ROOT, "community", "sanitize.js"));
  const raw = H.shopifyOrder({ id: 1, name: "#S", lines: [H.line(H.GROCERY.aloo, 1), H.line(H.COMMUNITY.onion5Draft, 1)] });
  Object.assign(raw, { total_price: "850", refunds: [{ refund_line_items: [{ line_item: raw.line_items[1] }] }],
                       fulfillments: [{ line_items: raw.line_items }], discount_applications: [{ value: "10" }] });
  const v = groceryOnlyOrder(raw, { groceryLines: [raw.line_items[0]],
                                    communityLines: [{ line: raw.line_items[1], intakeId: 9 }], eventRowId: 5 });
  assert.deepEqual(Object.keys(v).sort(), [...GROCERY_ORDER_FIELDS.filter((k) => k in raw), "line_items", "asb_community_split"].sort());
  assert.doesNotMatch(JSON.stringify(v), /ASB-COM-|50595473817858/);
  // Even if a future caller passed the RAW order to the grocery writer, it is refused whole.
  const { persistOrder } = require(path.join(ROOT, "server.js"));
  await assert.rejects(persistOrder(raw, "923001234567"), /Community line/);
});

// ---------------------------------------------------------------------------
// 3. Operator review tool
// ---------------------------------------------------------------------------

test("community:review lists rows needing attention with order, line, variant, state, reason, retries, times", async () => {
  const { id } = await sendOrder([H.line(H.COMMUNITY.onion5Draft, 2)]);           // -> review quantity_not_one
  await worker.runOnce(db);
  const rows = await review.attentionRows(db, { order: String(id) });
  assert.equal(rows.length, 1);
  const r = rows[0];
  for (const k of ["id", "order_name", "order_id", "line_id", "variant_id", "sku", "item", "quantity", "status",
                   "reason", "attempts", "order_created_at", "received_at", "updated_at"]) {
    assert.ok(k in r, `column ${k}`);
  }
  assert.equal(r.status, "review");
  assert.equal(r.reason, "quantity_not_one");
  assert.equal(r.attempts, 1);
  const sum = await review.summary(db);
  assert.ok(sum.intake.some((s) => s.status === "review" && s.reason === "quantity_not_one"));
  assert.equal(sum.registry.variants, 28);
  // Resolved rows are not "attention" by default.
  const all = await review.attentionRows(db, { all: true });
  assert.ok(all.length > (await review.attentionRows(db)).length);
});

test("requeue is guarded, audited, and only sends a review row back to the Community worker", async () => {
  const { id } = await sendOrder([H.line(H.COMMUNITY.onion5Draft, 2)]);
  await worker.runOnce(db);
  const [r] = await intakeFor(id);
  await assert.rejects(review.requeue(db, { id: r.id, actor: "Waqas", reason: "" }), /reason/);
  const dry = await review.requeue(db, { id: r.id, actor: "Waqas", reason: "checking the qty rule" });
  assert.equal(dry.applied, false);
  assert.equal((await intakeFor(id))[0].status, "review", "dry run changed nothing");
  const before = await db.query(`SELECT count(*)::int AS n FROM order_items`);
  await review.requeue(db, { id: r.id, actor: "Waqas", reason: "checking the qty rule", apply: true });
  const aud = (await db.query(`SELECT * FROM community_audit WHERE target_type='intake' AND target_id=$1`, [String(r.id)])).rows;
  assert.equal(aud.length, 1);
  assert.equal(aud[0].actor, "Waqas");
  await worker.runOnce(db);
  const [again] = await intakeFor(id);
  assert.equal(again.status, "review", "cause not fixed -> back to review, never grocery");
  assert.equal(again.attempts, 1, "re-queue restarts the retry budget (old count kept in the audit row)");
  assert.equal(aud[0].before.attempts, 1);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM order_items`)).rows[0].n, before.rows[0].n);
  // Only review rows can be re-queued.
  const { id: id2 } = await sendOrder([H.line(H.COMMUNITY.tomato10Draft, 1)]);
  await worker.runOnce(db);
  const [res] = await intakeFor(id2);
  await assert.rejects(review.requeue(db, { id: res.id, actor: "Waqas", reason: "should be refused", apply: true }), /only 'review'/);
  await assert.rejects(db.query(`UPDATE community_audit SET reason = 'x'`), /append-only/);
});

// ---------------------------------------------------------------------------
// 4. Guarded deactivation
// ---------------------------------------------------------------------------

test("deactivation is refused while Shopify still marks the product Community", async () => {
  await assert.rejects(
    registry.deactivateProduct(db, { productId: "10341692080386", actor: "Waqas", reason: "registered by mistake", apply: true }),
    /still marked Community in Shopify/);
  await assert.rejects(registry.deactivateProduct(db, { productId: "10341692080386", actor: "", reason: "registered by mistake" }), /--by/);
  const p = (await db.query(`SELECT is_active FROM community_products WHERE shopify_product_id = '10341692080386'`)).rows[0];
  assert.equal(p.is_active, true);
});

test("deactivation after the Shopify fix: guarded, audited, never converts captured rows to grocery", async () => {
  // A line captured while the product is still Community, not yet processed.
  const aloo5 = { variant_id: 50595473916162, product_id: 10341692080386, sku: "ASB-COM-DEMO-POTATO-5KG",
                  title: "Aloo White — Community Deal", variant_title: "5 kg", price: "190.00" };
  const pending = await sendOrder([H.line(aloo5, 1)]);
  // The operator fixes Shopify: no Community type, tag or SKU any more.
  const fixed = { id: 10341692080386, title: "Aloo White", status: "active", product_type: "Vegetables",
                  vendor: "Apna Sasta Bazaar", tags: "",
                  variants: [{ id: 50595473916162, sku: "ASB-VEG-ALOO-5KG", title: "5 kg", price: "190.00" },
                             { id: 50595473948930, sku: "ASB-VEG-ALOO-10KG", title: "10 kg", price: "330.00" }] };
  const hook = nextHook();
  await H.postShopify(base, fixed, { id: hook, topic: "products/update" });
  await H.waitWebhookDone(db, "shopify", hook);
  const intakeBefore = (await db.query(`SELECT id, status, sku, order_payload FROM community_intake ORDER BY id`)).rows;

  const dry = await registry.deactivateProduct(db, { productId: "10341692080386", actor: "Waqas", reason: "grocery potato, not a Community pack" });
  assert.equal(dry.applied, false);
  assert.equal(dry.plan.intake_rows_unchanged.received, 1);
  const r = await registry.deactivateProduct(db, { productId: "10341692080386", actor: "Waqas",
                                                   reason: "grocery potato, not a Community pack", apply: true });
  assert.equal(r.applied, true);
  const aud = (await db.query(`SELECT action, actor FROM community_audit WHERE target_id = '10341692080386'`)).rows;
  assert.deepEqual(aud, [{ action: "deactivate_product", actor: "Waqas" }]);

  // Captured rows: untouched by the deactivation itself...
  const intakeAfter = (await db.query(`SELECT id, status, sku, order_payload FROM community_intake ORDER BY id`)).rows;
  assert.deepEqual(intakeAfter, intakeBefore);
  // ...and the pending one goes to REVIEW, not grocery.
  await worker.runOnce(db);
  const [p] = await intakeFor(pending.id);
  assert.equal(p.status, "review");
  assert.equal(p.review_reason, "product_deactivated");
  assert.equal((await db.query(`SELECT 1 FROM orders WHERE shopify_order_id = $1`, [String(pending.id)])).rows.length, 0);

  // A NEW line for the corrected product (no Community signal left) is grocery now.
  const fresh = await sendOrder([H.line({ variant_id: 50595473916162, product_id: 10341692080386, sku: "ASB-VEG-ALOO-5KG",
                                          title: "Aloo White", price: "190.00" }, 1)]);
  assert.equal((await intakeFor(fresh.id)).length, 0);
  // A stray old Community SKU on that variant would still be diverted (fail closed).
  const stray = await sendOrder([H.line(aloo5, 1)]);
  assert.equal((await intakeFor(stray.id))[0].classification, "suspect");
});

test("Shopify marking a deactivated product Community again re-activates it (audited)", async () => {
  const back = { id: 10341692080386, title: "Aloo White — Community Deal", status: "draft", product_type: "Community Internal",
                 vendor: "Apna Sasta Bazaar", tags: "asb-community-internal",
                 variants: [{ id: 50595473916162, sku: "ASB-COM-DEMO-POTATO-5KG", title: "5 kg", price: "190.00" }] };
  const hook = nextHook();
  await H.postShopify(base, back, { id: hook, topic: "products/update" });
  await H.waitWebhookDone(db, "shopify", hook);
  const p = (await db.query(`SELECT is_active FROM community_products WHERE shopify_product_id = '10341692080386'`)).rows[0];
  assert.equal(p.is_active, true);
  const aud = (await db.query(`SELECT action, actor FROM community_audit WHERE target_id = '10341692080386' ORDER BY id`)).rows;
  assert.equal(aud.at(-1).action, "auto_reactivate_product");
  assert.equal(aud.at(-1).actor, "system");
});

test("variant deactivation keeps its lines Community and sends them to review", async () => {
  await registry.deactivateVariant(db, { variantId: "50595475587330", actor: "Waqas", reason: "5 kg boneless pack withdrawn", apply: true });
  const boneless5 = { variant_id: 50595475587330, product_id: 10341692276994, sku: "ASB-COM-DEMO-BONELESS-5KG",
                      title: "Chicken Boneless — Community Deal", price: "3900.00" };
  const { id } = await sendOrder([H.line(boneless5, 1)]);
  const [r] = await intakeFor(id);
  assert.equal(r.classification, "suspect");
  await worker.runOnce(db);
  const [r2] = await intakeFor(id);
  assert.equal(r2.review_reason, "variant_deactivated");
  await assert.rejects(registry.deactivateVariant(db, { variantId: "50595475587330", actor: "Waqas", reason: "again, should refuse", apply: true }),
                       /already deactivated/);
  await registry.reactivate(db, { kind: "variant", id: "50595475587330", actor: "Waqas", reason: "pack back on sale", apply: true });
});

// ---------------------------------------------------------------------------
// 5. Safety mode: worker off
// ---------------------------------------------------------------------------

test("safety mode: worker OFF still isolates and captures; lines wait, never become grocery", async () => {
  assert.equal(process.env.COMMUNITY_INTAKE_WORKER, "off");
  const before = (await db.query(`SELECT (SELECT count(*) FROM orders)::int AS o, (SELECT count(*) FROM order_items)::int AS i`)).rows[0];
  const { id } = await sendOrder([H.line(H.COMMUNITY.onion5Draft, 1), H.line(H.GROCERY.mango, 1)], { phone: "+92 345 1010101" });
  worker.kick(db);                                   // a no-op in safety mode
  await new Promise((r) => setTimeout(r, 300));
  const [r] = await intakeFor(id);
  assert.equal(r.status, "received", "nothing processed it");
  const after = (await db.query(`SELECT (SELECT count(*) FROM orders)::int AS o, (SELECT count(*) FROM order_items)::int AS i`)).rows[0];
  assert.deepEqual(after, { o: before.o + 1, i: before.i + 1 }, "only the grocery line reached grocery");
  // The operator sees it once it has waited past the threshold.
  const att = await review.attentionRows(db, { order: String(id), stuckMin: 0 });
  assert.equal(att.length, 1);
  assert.equal(worker.start(db), null, "sweeper refuses to start in safety mode");
});

// ---------------------------------------------------------------------------
// 6. Former Phase-2 blocker - fixed by migration 017 (shopify_order_sources)
// ---------------------------------------------------------------------------

test("017: same order under a NEW delivery id does not double grocery qty or re-bill",
  async () => {
    const lines = [H.line(H.GROCERY.aloo, 2)];
    const first = await sendOrder(lines, { phone: "+92 345 2020202" });
    const sendsBefore = sent.length;
    const hook2 = nextHook();
    await H.postShopify(base, first.order, { id: hook2 });
    await H.waitWebhookDone(db, "shopify", hook2);
    const q = (await db.query(`SELECT oi.qty_ordered::float AS q FROM order_items oi JOIN orders o ON o.id = oi.order_id
                                WHERE o.shopify_order_id = $1`, [String(first.id)])).rows;
    assert.deepEqual(q, [{ q: 2 }], "quantity doubled");
    assert.equal(sent.length, sendsBefore, "a second bill was sent");
  });

// ---------------------------------------------------------------------------
// 7. Rehearsal script: refuses production-like targets, passes on a staging copy
// ---------------------------------------------------------------------------

function poolDb(url) {
  const pool = new Pool({ connectionString: url, max: 3 });
  return {
    pool,
    query: (t, p) => pool.query(t, p),
    tx: async (fn) => {
      const c = await pool.connect();
      try { await c.query("BEGIN"); const r = await fn(c); await c.query("COMMIT"); return r; }
      catch (e) { await c.query("ROLLBACK"); throw e; }
      finally { c.release(); }
    },
  };
}

test("rehearsal refuses a database without the rehearsal marker (i.e. production)", async () => {
  await assert.rejects(rehearsal.guard(db, base), /not marked as a rehearsal copy/);
});

test("rehearsal passes end-to-end against a staging copy running the real server", { timeout: 120000 }, async () => {
  const url = await H.createDatabase("asb_t_rehearsal", ROOT);
  const sdb = poolDb(url);
  let child;
  try {
    await sdb.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS meta_retailer_id TEXT`);
    await sdb.query(H.FIXTURE_SQL);
    await loadSnapshot(sdb);
    await sdb.query(`INSERT INTO app_settings (key, value) VALUES ('asb_environment', 'rehearsal')`);
    const port = await new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
    const env = { ...process.env, DATABASE_URL: url, PORT: String(port), SHOPIFY_WEBHOOK_SECRET: "staging-secret",
                  META_APP_SECRET: "x", COMMUNITY_INTAKE_WORKER: "on", COMMUNITY_INTAKE_SWEEP_MS: "300" };
    delete env.WHATSAPP_TOKEN;
    child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env, stdio: "ignore" });
    const sbase = `http://127.0.0.1:${port}`;
    await H.waitFor(async () => { try { return (await fetch(sbase + "/")).ok; } catch { return false; } }, { timeoutMs: 15000 });
    const out = [];
    const r = await rehearsal.rehearse({ db: sdb, base: sbase, secret: "staging-secret", log: (l) => out.push(l) });
    assert.equal(r.failed, 0, out.join("\n"));
    assert.ok(r.results.length >= 14);
  } finally {
    child?.kill("SIGTERM");
    await sdb.pool.end();
  }
});


// ---------------------------------------------------------------------------
// Second review pass fixes
// ---------------------------------------------------------------------------

test("a line already in intake stays Community on later deliveries, even after the registry changes", async () => {
  const p = { id: 10377777777777, title: "Kaddu — Community Deal", status: "draft", product_type: "Community Internal",
              vendor: "Apna Sasta Bazaar", tags: "asb-community-internal",
              variants: [{ id: 50577777777771, sku: "ASB-COM-KADDU-5KG", title: "5 kg", price: "500.00" }] };
  await registry.upsertProduct(db, p, "webhook");
  const line = H.line({ variant_id: 50577777777771, product_id: 10377777777777, sku: "ASB-COM-KADDU-5KG",
                        title: "Kaddu — Community Deal", price: "500.00" }, 1);
  const first = await sendOrder([line]);
  assert.equal((await intakeFor(first.id)).length, 1);
  // Shopify is "fixed" and the product deactivated: no registry or SKU signal left.
  await registry.upsertProduct(db, { ...p, product_type: "Vegetables", tags: "",
                                     variants: [{ id: 50577777777771, sku: "ASB-VEG-KADDU", title: "5 kg", price: "500.00" }] }, "webhook");
  await registry.deactivateProduct(db, { productId: "10377777777777", actor: "Waqas", reason: "test: kaddu is grocery now", apply: true });
  const before = (await db.query(`SELECT count(*)::int AS n FROM order_items`)).rows[0].n;
  const updated = { ...first.order, line_items: [{ ...line, sku: "ASB-VEG-KADDU" }] };
  const hook = nextHook();
  assert.equal(await H.postShopify(base, updated, { id: hook, topic: "orders/create" }), 200);
  await H.waitWebhookDone(db, "shopify", hook);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM order_items`)).rows[0].n, before, "never grocery");
  assert.equal((await db.query(`SELECT 1 FROM orders WHERE shopify_order_id = $1`, [String(first.id)])).rows.length, 0);
});

test("registry changes between capture and persist: the line is re-captured, grocery continues, nothing lost", async () => {
  const intakeMod = require(path.join(ROOT, "community", "intake.js"));
  const original = intakeMod.captureWebhook;
  const newPack = { id: 10366666666666, title: "Bhindi — Community Deal", status: "draft", product_type: "Community Internal",
                    vendor: "Apna Sasta Bazaar", tags: "asb-community-internal",
                    variants: [{ id: 50566666666661, sku: "ASB-VEG-066", title: "3 kg", price: "450.00" }] };
  // The race: the registry learns about this product right AFTER the
  // pre-200 capture classified its line as grocery.
  intakeMod.captureWebhook = async (...a) => {
    const r = await original(...a);
    if (r.kind === "order" && r.groceryLines.some((l) => String(l.variant_id) === "50566666666661")) {
      await registry.upsertProduct(db, newPack, "webhook");
    }
    return r;
  };
  try {
    const sendsBefore = sent.length;
    const racer = H.line({ variant_id: 50566666666661, product_id: 10366666666666, sku: "ASB-VEG-066",
                           title: "Bhindi — Community Deal", price: "450.00" }, 1);
    const { id, hook } = await sendOrder([H.line(H.GROCERY.mango, 1), racer], { phone: "+92 345 3030303" });
    assert.equal((await db.query(`SELECT status FROM webhook_events WHERE event_id = $1`, [hook])).rows[0].status, "processed");
    const rows = await intakeFor(id);
    assert.equal(rows.length, 1, "the late Community line was captured, not lost");
    assert.equal(rows[0].shopify_variant_id, "50566666666661");
    const items = (await db.query(`SELECT p.sku FROM order_items oi JOIN orders o ON o.id = oi.order_id
                                     JOIN products p ON p.id = oi.product_id WHERE o.shopify_order_id = $1`, [String(id)])).rows;
    assert.deepEqual(items, [{ sku: "ASB-FRT-001" }], "grocery continued with the grocery line only");
    assert.equal(sent.length, sendsBefore + 1, "one grocery bill");
    assert.equal((await db.query(`SELECT 1 FROM products WHERE shopify_variant_id = '50566666666661'`)).rows.length, 0, "no stub");
  } finally {
    intakeMod.captureWebhook = original;
  }
});

test("inbox orders use the classifier's rule (registered PRODUCT is enough)", async () => {
  // A products row for an unregistered variant of a registered Community product
  // (the shape of the 4-5 Oct stubs), category NOT community-excluded.
  await db.query(`INSERT INTO products (sku, name_en, category, unit, shopify_product_id, shopify_variant_id, is_active, asb_price)
                  VALUES ('SHP-50595499999999', 'Payaz pack stub', 'sabziyaan', 'kg', '10341692014850', '50595499999999', true, 700)`);
  const orders = require(path.join(ROOT, "orders.js"));
  await assert.rejects(db.tx((c) => orders.saveInboxOrder(c, {
    phone: "923009990001", name: "Inbox", orderedAt: new Date("2026-10-08T05:00:00Z"),
    lines: [{ sku: "SHP-50595499999999", packs: 1 }], enteredBy: "test" })), /Community pack/);
});

test("operator deactivation and a webhook re-registration serialise (no interleaving)", async () => {
  const p = { id: 10355555555555, title: "Arvi — Community Deal", status: "draft", product_type: "Community Internal",
              vendor: "Apna Sasta Bazaar", tags: "asb-community-internal",
              variants: [{ id: 50555555555551, sku: "ASB-COM-ARVI-5KG", title: "5 kg", price: "600.00" }] };
  await registry.upsertProduct(db, p, "webhook");
  const plain = { ...p, product_type: "Vegetables", tags: "", variants: [{ ...p.variants[0], sku: "ASB-VEG-ARVI" }] };
  await registry.upsertProduct(db, plain, "webhook");                 // signals lost -> deactivatable
  const c = await db.pool.connect();
  try {
    await c.query("BEGIN");
    await registry.upsertProduct(c, p, "webhook");                     // Shopify marks it Community again (locks the row)
    const op = registry.deactivateProduct(db, { productId: "10355555555555", actor: "Waqas",
                                                reason: "racing the webhook on purpose", apply: true });
    await new Promise((r) => setTimeout(r, 250));
    await c.query("COMMIT");
    await assert.rejects(op, /still marked Community/, "the operator sees the committed webhook, not a stale row");
  } finally {
    c.release();
  }
  const row = (await db.query(`SELECT is_active, signals_ok FROM community_products WHERE shopify_product_id = '10355555555555'`)).rows[0];
  assert.deepEqual(row, { is_active: true, signals_ok: true });
});

test("community:review tolerates odd --stuck-min / --limit input", async () => {
  await review.attentionRows(db, { stuckMin: "2.5", limit: "abc" });
  await review.attentionRows(db, { stuckMin: "x" });
});
