// ============================================================================
// Phase 1 — Community isolation + durable intake.
// Real Postgres, real migrations, real Express routes; Meta/Shopify stubbed.
//
//   npm test        (needs a scratch Postgres; see test/support/harness.js)
// ============================================================================

"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const H = require("./support/harness");

const ROOT = path.join(__dirname, "..");
let db, server, base, sent, worker, registryScript, persistOrder;
let orderSeq = 7600000000000;
let hookSeq = 0;
const nextHook = () => `test-hook-${process.pid}-${++hookSeq}`;

before(async () => {
  const url = await H.createDatabase("asb_t_phase1", ROOT);
  H.setEnv(url);
  sent = H.stubOutside(ROOT);
  const mod = require(path.join(ROOT, "server.js"));
  persistOrder = mod.persistOrder;
  db = require(path.join(ROOT, "db"));
  worker = require(path.join(ROOT, "community", "worker.js"));
  registryScript = require(path.join(ROOT, "scripts", "community-registry.js"));
  await require(path.join(ROOT, "productSync.js")).ensureSchema(db);
  await db.query(H.FIXTURE_SQL);
  // Bootstrap the registry from the checked-in snapshot, exactly as production would.
  const snap = JSON.parse(fs.readFileSync(path.join(ROOT, "db/community/registry-snapshot-2026-10-08.json"), "utf8"));
  await registryScript.apply(db, snap.products, "snapshot");
  server = mod.app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await db?.shutdown();
});

/** Everything the grocery pipeline owns, counted. */
async function groceryCounts() {
  const { rows } = await db.query(`
    SELECT (SELECT count(*) FROM products)::int                 AS products,
           (SELECT count(*) FROM customers)::int                AS customers,
           (SELECT count(*) FROM orders)::int                   AS orders,
           (SELECT count(*) FROM order_items)::int              AS order_items,
           (SELECT count(*) FROM cycle_prices)::int             AS cycle_prices,
           (SELECT coalesce(sum(total_qty_ordered),0)::float FROM v_cycle_procurement) AS procurement_units,
           (SELECT count(*) FROM v_packing_queue)::int          AS packing_rows,
           (SELECT count(*) FROM whatsapp_messages)::int        AS wa_messages`);
  return { ...rows[0], sends: sent.length };
}

/** No row of any grocery table may mention a Community variant or SKU. */
async function assertNoCommunityInGrocery() {
  const { rows } = await db.query(`
    SELECT 'products' AS t, count(*)::int AS n FROM products
     WHERE (sku LIKE 'ASB-COM-%' OR shopify_variant_id IN (SELECT shopify_variant_id FROM community_variants))
       AND sku <> 'SHP-50595473817858'   -- the pre-existing legacy fixture row
    UNION ALL
    SELECT 'order_items', count(*)::int FROM order_items oi JOIN products p ON p.id = oi.product_id
     WHERE p.sku LIKE 'ASB-COM-%' OR p.category = 'community-excluded'
        OR p.shopify_variant_id IN (SELECT shopify_variant_id FROM community_variants)
    UNION ALL
    SELECT 'cycle_prices', count(*)::int FROM cycle_prices cp JOIN products p ON p.id = cp.product_id
     WHERE p.sku LIKE 'ASB-COM-%' OR p.category = 'community-excluded'
        OR p.shopify_variant_id IN (SELECT shopify_variant_id FROM community_variants)
    UNION ALL
    SELECT 'procurement', count(*)::int FROM v_cycle_procurement v
     WHERE v.sku LIKE 'ASB-COM-%' OR v.product_id IN (SELECT id FROM products WHERE category = 'community-excluded')`);
  for (const r of rows) assert.equal(r.n, 0, `Community data leaked into ${r.t}`);
}

async function sendOrder(lines, extra = {}) {
  const id = ++orderSeq;
  const order = H.shopifyOrder({ id, name: `#T${id % 100000}`, lines, ...extra });
  const hook = nextHook();
  const status = await H.postShopify(base, order, { id: hook });
  return { id, order, hook, status };
}

const intakeFor = async (orderId) =>
  (await db.query(`SELECT * FROM community_intake WHERE shopify_order_id = $1 ORDER BY id`, [String(orderId)])).rows;

// ---------------------------------------------------------------------------

test("registry bootstrap: 8 products, 28 variants, archived product kept", async () => {
  const { rows } = await db.query(`
    SELECT (SELECT count(*) FROM community_products)::int AS p,
           (SELECT count(*) FROM community_variants)::int AS v,
           (SELECT shopify_status FROM community_products WHERE shopify_product_id = '10341680578818') AS archived`);
  assert.deepEqual(rows[0], { p: 8, v: 28, archived: "archived" });
});

test("ordinary grocery order: one order, grocery rows, one bill, no intake", async () => {
  const before = await groceryCounts();
  const { id, hook, status } = await sendOrder([H.line(H.GROCERY.aloo, 2), H.line(H.GROCERY.mango, 1)]);
  assert.equal(status, 200);
  assert.equal(await H.waitWebhookDone(db, "shopify", hook), "processed");
  const now = await groceryCounts();
  assert.equal(now.orders, before.orders + 1);
  assert.equal(now.order_items, before.order_items + 2);
  assert.equal(now.sends, before.sends + 1);
  assert.equal((await intakeFor(id)).length, 0);
  const o = (await db.query(`SELECT source_payload FROM orders WHERE shopify_order_id = $1`, [String(id)])).rows[0];
  assert.equal(o.source_payload.line_items.length, 2);
});

test("Community-only order: intake row, NO grocery order, NO bill, zero grocery rows", async () => {
  const before = await groceryCounts();
  const { id, hook, status } = await sendOrder([H.line(H.COMMUNITY.onion5Draft, 1)]);
  assert.equal(status, 200);
  // The intake row exists the moment the 200 is returned (captured pre-200).
  const rows = await intakeFor(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "received");
  assert.equal(rows[0].classification, "registered");
  assert.deepEqual(rows[0].signals, ["registered_variant", "registered_product", "sku_prefix"]);
  assert.equal(rows[0].shop, H.SHOP);
  assert.equal(rows[0].customer_phone, "923001234567");
  assert.equal(await H.waitWebhookDone(db, "shopify", hook), "processed");
  assert.deepEqual(await groceryCounts(), before, "grocery tables and sends must not change");
  await assertNoCommunityInGrocery();

  await worker.runOnce(db);
  const [r] = await intakeFor(id);
  assert.equal(r.status, "resolved");
  assert.equal(r.resolved_variant_gid, "gid://shopify/ProductVariant/50595473817858");
  assert.equal(r.resolved_product_id, "10341692014850");
});

test("mixed cart: grocery lines continue, Community line isolated, bill shows grocery only", async () => {
  const before = await groceryCounts();
  const { id, hook } = await sendOrder([H.line(H.GROCERY.aloo, 3), H.line(H.COMMUNITY.tomato10Draft, 1)],
                                       { phone: "+92 333 7654321", first: "Mixed" });
  assert.equal(await H.waitWebhookDone(db, "shopify", hook), "processed");
  const now = await groceryCounts();
  assert.equal(now.orders, before.orders + 1);
  assert.equal(now.order_items, before.order_items + 1, "only the grocery line");
  assert.equal(now.sends, before.sends + 1);
  const msg = sent.at(-1);
  const text = msg.text || JSON.stringify(msg.params);
  assert.match(text, /آلو.*3 kg/);                          // the grocery line, as the bill names it
  assert.match(text, /Rs 150/);                               // grocery-only total
  assert.doesNotMatch(text, /Tamatar|ٹماٹر|Community|1,?300|1,?450/);
  const items = (await db.query(
    `SELECT oi.name_snapshot, oi.qty_ordered::float AS q FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE o.shopify_order_id = $1`, [String(id)])).rows;
  assert.deepEqual(items, [{ name_snapshot: H.GROCERY.aloo.title, q: 3 }]);
  // The grocery order stores ONLY the sanitized grocery view: no Community
  // line, no Shopify totals (they included the pack), a split marker.
  const o = (await db.query(`SELECT source_payload FROM orders WHERE shopify_order_id = $1`, [String(id)])).rows[0];
  const sp = o.source_payload;
  assert.deepEqual(sp.line_items.map((l) => l.sku), ["ASB-VEG-001"]);
  for (const k of ["total_price", "subtotal_price", "total_line_items_price", "refunds", "fulfillments"]) {
    assert.ok(!(k in sp), `${k} must not be stored on a mixed grocery order`);
  }
  assert.doesNotMatch(JSON.stringify(sp), /ASB-COM-|50595474014466|10341692113154/,
                     "no Community identity anywhere in source_payload");
  assert.equal(sp.asb_community_split.removed_line_item_ids.length, 1);
  assert.equal(sp.asb_community_split.community_intake_ids.length, 1);
  const intake = await intakeFor(id);
  assert.equal(intake.length, 1);
  assert.equal(intake[0].sku, "ASB-COM-DEMO-TOMATO-10KG");
  await assertNoCommunityInGrocery();
});

test("Community SKU with unknown variant id -> suspect -> review, never grocery", async () => {
  const before = await groceryCounts();
  const ghost = { variant_id: 59999999999999, product_id: 19999999999999, sku: "ASB-COM-DEMO-ONION-5KG",
                  title: "Payaz — Community Deal", price: "700.00" };
  const { id, hook } = await sendOrder([H.line(ghost, 1)]);
  assert.equal(await H.waitWebhookDone(db, "shopify", hook), "processed");
  const [r] = await intakeFor(id);
  assert.equal(r.classification, "suspect");
  assert.deepEqual(r.signals, ["sku_prefix"]);
  await worker.runOnce(db);
  const [r2] = await intakeFor(id);
  assert.equal(r2.status, "review");
  assert.equal(r2.review_reason, "unknown_variant_with_community_sku");
  assert.equal(r2.resolved_variant_gid, null, "a SKU must never resolve a pack");
  assert.deepEqual(await groceryCounts(), before);
  await assertNoCommunityInGrocery();
});

test("duplicate delivery: same webhook id twice -> one intake row, one order, one bill", async () => {
  const lines = [H.line(H.GROCERY.mango, 1), H.line(H.COMMUNITY.onion5Draft, 1)];
  const id = ++orderSeq;
  const order = H.shopifyOrder({ id, name: "#DUP1", lines, phone: "+92 321 1112223" });
  const before = await groceryCounts();
  const hook = nextHook();
  assert.equal(await H.postShopify(base, order, { id: hook }), 200);
  assert.equal(await H.waitWebhookDone(db, "shopify", hook), "processed");
  assert.equal(await H.postShopify(base, order, { id: hook }), 200);           // exact redelivery
  const now = await groceryCounts();
  assert.equal(now.orders, before.orders + 1);
  assert.equal(now.order_items, before.order_items + 1);
  assert.equal(now.sends, before.sends + 1);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM webhook_events WHERE event_id = $1`, [hook])).rows[0].n, 1);
  // Same order under a NEW delivery id: the intake unique key (shop + order +
  // line item) still holds. (The grocery side of a re-sent order under a new
  // delivery id is a pre-existing behaviour, not changed in Phase 1.)
  const hook2 = nextHook();
  assert.equal(await H.postShopify(base, order, { id: hook2 }), 200);
  await H.waitWebhookDone(db, "shopify", hook2);
  assert.equal((await intakeFor(id)).length, 1);
});

test("Community line quantity 2 -> review (fail closed)", async () => {
  const { id, hook } = await sendOrder([H.line(H.COMMUNITY.onion5Draft, 2)]);
  await H.waitWebhookDone(db, "shopify", hook);
  await worker.runOnce(db);
  const [r] = await intakeFor(id);
  assert.equal(r.quantity, 2);
  assert.equal(r.status, "review");
  assert.equal(r.review_reason, "quantity_not_one");
});

test("archived / duplicate-SKU variants: exact variant id decides; archived -> review", async () => {
  const before = await groceryCounts();
  const { id, hook } = await sendOrder([
    H.line(H.COMMUNITY.onion5Archived, 1),   // same SKU as the Draft variant, archived product
    H.line(H.COMMUNITY.onion5Draft, 1),      // the live (Draft) variant
  ]);
  await H.waitWebhookDone(db, "shopify", hook);
  await worker.runOnce(db);
  const rows = await intakeFor(id);
  const archived = rows.find((r) => r.shopify_variant_id === "50595412640002");
  const draft = rows.find((r) => r.shopify_variant_id === "50595473817858");
  assert.equal(archived.status, "review");
  assert.equal(archived.review_reason, "product_archived");
  assert.equal(draft.status, "resolved");
  assert.equal(draft.resolved_variant_gid, "gid://shopify/ProductVariant/50595473817858");
  assert.deepEqual(await groceryCounts(), before);
  await assertNoCommunityInGrocery();
});

test("worker failure -> retryable_error with backoff -> retried -> resolved", async () => {
  const { id, hook } = await sendOrder([H.line(H.COMMUNITY.tomato10Draft, 1)], { phone: "+92 345 0000001" });
  await H.waitWebhookDone(db, "shopify", hook);
  const [row] = await intakeFor(id);
  const boom = async () => { throw new Error("simulated outage"); };
  assert.equal(await worker.processOne(db, row.id, { resolve: boom }), "retryable_error");
  let [r] = await intakeFor(id);
  assert.equal(r.attempts, 1);
  assert.equal(r.last_error, "simulated outage");
  assert.ok(new Date(r.next_attempt_at) > new Date(), "backoff pushes the next attempt into the future");
  // Not due yet: a sweep leaves it alone.
  await worker.runOnce(db);
  [r] = await intakeFor(id);
  assert.equal(r.status, "retryable_error");
  // Due now: the sweep retries and resolves it.
  await db.query(`UPDATE community_intake SET next_attempt_at = now() WHERE id = $1`, [row.id]);
  await worker.runOnce(db);
  [r] = await intakeFor(id);
  assert.equal(r.status, "resolved");
  assert.equal(r.attempts, 2);
});

test("worker gives up after MAX_ATTEMPTS -> review, never resolved silently", async () => {
  const { id, hook } = await sendOrder([H.line(H.COMMUNITY.onion5Draft, 1)], { phone: "+92 345 0000002" });
  await H.waitWebhookDone(db, "shopify", hook);
  const [row] = await intakeFor(id);
  const boom = async () => { throw new Error("still down"); };
  for (let i = 0; i < worker.MAX_ATTEMPTS; i++) {
    await db.query(`UPDATE community_intake SET next_attempt_at = now() WHERE id = $1`, [row.id]);
    await worker.processOne(db, row.id, { resolve: boom });
  }
  const [r] = await intakeFor(id);
  assert.equal(r.status, "review");
  assert.equal(r.review_reason, "max_attempts_exceeded");
  assert.equal(r.attempts, worker.MAX_ATTEMPTS);
});

test("capture failure before the 200 -> 503, nothing half-written, retry succeeds", async () => {
  await db.query(`ALTER TABLE community_intake RENAME TO community_intake_hidden`);
  const id = ++orderSeq;
  const order = H.shopifyOrder({ id, name: "#FAIL1", lines: [H.line(H.COMMUNITY.onion5Draft, 1)] });
  const hook = nextHook();
  let status;
  try {
    status = await H.postShopify(base, order, { id: hook });
  } finally {
    await db.query(`ALTER TABLE community_intake_hidden RENAME TO community_intake`);
  }
  assert.equal(status, 503);
  const ev = await db.query(`SELECT count(*)::int AS n FROM webhook_events WHERE event_id = $1`, [hook]);
  assert.equal(ev.rows[0].n, 0, "the dedupe row rolled back with the failed capture");
  // Shopify retries the same delivery: now it is captured.
  assert.equal(await H.postShopify(base, order, { id: hook }), 200);
  assert.equal((await intakeFor(id)).length, 1);
});

test("persistOrder refuses a Community line handed to it directly (backstop)", async () => {
  const before = await groceryCounts();
  const order = H.shopifyOrder({ id: ++orderSeq, name: "#LEAK", lines: [H.line(H.COMMUNITY.onion5Draft, 1)] });
  await assert.rejects(persistOrder(order, "923001234567"), /Community line/);
  assert.deepEqual(await groceryCounts(), before);
});

test("products/update for a Community product: registry refreshed, products untouched", async () => {
  const before = await groceryCounts();
  const payload = {
    id: 10341692014850, title: "Payaz — Community Deal", status: "draft", product_type: "Community Internal",
    vendor: "Apna Sasta Bazaar", tags: "asb-community-internal, community-demo, do-not-merchandise",
    variants: [
      { id: 50595473817858, sku: "ASB-COM-DEMO-ONION-5KG", title: "5 kg", price: "720.00" },
      { id: 50595473850626, sku: "ASB-COM-DEMO-ONION-10KG", title: "10 kg", price: "1300.00" },
    ],
  };
  const hook = nextHook();
  assert.equal(await H.postShopify(base, payload, { id: hook, topic: "products/update" }), 200);
  await H.waitWebhookDone(db, "shopify", hook);
  const v = (await db.query(`SELECT price::float AS p FROM community_variants WHERE shopify_variant_id = '50595473817858'`)).rows[0];
  assert.equal(v.p, 720);
  assert.deepEqual(await groceryCounts(), before);
});

test("products/update that drops Community signals: kept registered, lines go to review", async () => {
  const payload = {
    id: 10341692342530, title: "Tori", status: "draft", product_type: "Vegetables", vendor: "Apna Sasta Bazaar", tags: "",
    variants: [{ id: 50595475718402, sku: "ASB-VEG-TORI", title: "5 kg", price: "600.00" },
               { id: 50595475751170, sku: "ASB-VEG-TORI-10", title: "10 kg", price: "1100.00" }],
  };
  const hook = nextHook();
  await H.postShopify(base, payload, { id: hook, topic: "products/update" });
  await H.waitWebhookDone(db, "shopify", hook);
  const p = (await db.query(`SELECT signals_ok FROM community_products WHERE shopify_product_id = '10341692342530'`)).rows[0];
  assert.equal(p.signals_ok, false);
  const before = await groceryCounts();
  const tori = { variant_id: 50595475718402, product_id: 10341692342530, sku: "ASB-VEG-TORI", title: "Tori", price: "600.00" };
  const { id, hook: h2 } = await sendOrder([H.line(tori, 1)]);
  await H.waitWebhookDone(db, "shopify", h2);
  assert.deepEqual(await groceryCounts(), before, "a registered id never falls back to grocery");
  await worker.runOnce(db);
  const [r] = await intakeFor(id);
  assert.equal(r.status, "review");
  assert.equal(r.review_reason, "registry_config_conflict");
});

test("products/update for an ordinary grocery product still updates products as before", async () => {
  const payload = {
    id: 9000000000001, title: "Aloo White — 1 kg | آلو", status: "active", product_type: "Vegetables",
    vendor: "Apna Sasta Bazaar", tags: "", variants: [{ id: 47000000000001, sku: "ASB-VEG-001", price: "55.00", compare_at_price: "65.00" }],
  };
  const hook = nextHook();
  await H.postShopify(base, payload, { id: hook, topic: "products/update" });
  assert.equal(await H.waitWebhookDone(db, "shopify", hook), "processed");
  const p = (await db.query(`SELECT asb_price::float AS a, market_price::float AS m FROM products WHERE shopify_variant_id = '47000000000001'`)).rows[0];
  assert.deepEqual(p, { a: 55, m: 65 });
  const reg = (await db.query(`SELECT count(*)::int AS n FROM community_products WHERE shopify_product_id = '9000000000001'`)).rows[0];
  assert.equal(reg.n, 0);
});

test("a brand-new Community product arriving by webhook never enters products", async () => {
  const before = await groceryCounts();
  const payload = {
    id: 10399999999999, title: "Lehsan — Community Deal", status: "draft", product_type: "Community Internal",
    vendor: "Apna Sasta Bazaar", tags: "asb-community-internal",
    variants: [{ id: 50599999999991, sku: "ASB-COM-LEHSAN-2KG", title: "2 kg", price: "900.00" }],
  };
  const hook = nextHook();
  await H.postShopify(base, payload, { id: hook, topic: "products/create" });
  await H.waitWebhookDone(db, "shopify", hook);
  assert.deepEqual(await groceryCounts(), before);
  const r = (await db.query(`SELECT count(*)::int AS n FROM community_variants WHERE shopify_variant_id = '50599999999991'`)).rows[0];
  assert.equal(r.n, 1);
});

test("WhatsApp/inbox: grocery picker and inbox orders refuse Community packs", async () => {
  const orders = require(path.join(ROOT, "orders.js"));
  await assert.rejects(
    db.tx((c) => orders.saveInboxOrder(c, {
      phone: "923009998887", name: "Inbox", orderedAt: new Date("2026-10-08T05:00:00Z"),
      lines: [{ sku: "SHP-50595473817858", packs: 1 }], enteredBy: "test",
    })),
    /Community pack/
  );
  const ok = await db.tx((c) => orders.saveInboxOrder(c, {
    phone: "923009998887", name: "Inbox", orderedAt: new Date("2026-10-08T05:00:00Z"),
    lines: [{ sku: "ASB-VEG-001", packs: 2 }], enteredBy: "test",
  }));
  assert.ok(ok.orderNumber);
});

test("Community order without a phone is still captured; nothing else happens", async () => {
  const before = await groceryCounts();
  const { id, hook } = await sendOrder([H.line(H.COMMUNITY.tomato10Draft, 1)], { phone: null });
  await H.waitWebhookDone(db, "shopify", hook);
  const [r] = await intakeFor(id);
  assert.equal(r.customer_phone, null);
  assert.deepEqual(await groceryCounts(), before);
});

test("registry reconcile from Shopify (mocked Admin API) is dry-run safe and flags lost products", async () => {
  const pages = {
    products: { nodes: [{
      id: "gid://shopify/Product/10341692014850", legacyResourceId: "10341692014850", title: "Payaz — Community Deal",
      status: "DRAFT", productType: "Community Internal", vendor: "Apna Sasta Bazaar", tags: ["asb-community-internal"],
      variants: { nodes: [{ id: "gid://shopify/ProductVariant/50595473817858", legacyResourceId: "50595473817858",
                            sku: "ASB-COM-DEMO-ONION-5KG", title: "5 kg", price: "700.00" }] } }],
      pageInfo: { hasNextPage: false, endCursor: null } },
  };
  const calls = [];
  const fakeFetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body.query.includes("nodes(ids") ? "nodes" : "products");
    if (body.query.includes("nodes(ids")) {
      return { ok: true, json: async () => ({ data: { nodes: body.variables.ids.map(() => null) } }) };
    }
    return { ok: true, json: async () => ({ data: pages }) };
  };
  const products = await registryScript.fetchShopifyProducts(fakeFetch,
    { SHOPIFY_SHOP_DOMAIN: H.SHOP, SHOPIFY_ADMIN_TOKEN: "x" }, ["10341692014850", "10341692080386"]);
  assert.deepEqual(calls, ["products", "nodes"]);
  const lost = products.find((p) => p.id === "10341692080386");
  assert.equal(lost.__deleted, true);
  const plan = await registryScript.plan(db, products);
  assert.ok(plan.some((l) => l.includes("10341692080386") && l.includes("DELETED")));
});

test("products/delete keeps the registry's deleted mark; later lines -> review product_deleted", async () => {
  const hook = nextHook();
  assert.equal(await H.postShopify(base, { id: 10341692276994 }, { id: hook, topic: "products/delete" }), 200);
  assert.equal(await H.waitWebhookDone(db, "shopify", hook), "processed");
  const p = (await db.query(`SELECT shopify_status, deleted_at IS NOT NULL AS deleted, title, product_type
                               FROM community_products WHERE shopify_product_id = '10341692276994'`)).rows[0];
  assert.deepEqual(p, { shopify_status: "deleted", deleted: true, title: "Chicken Boneless — Community Deal", product_type: "Community Internal" });
  const boneless = { variant_id: 50595475554562, product_id: 10341692276994, sku: "ASB-COM-DEMO-BONELESS-3KG", title: "Chicken Boneless — Community Deal", price: "2400.00" };
  const { id, hook: h2 } = await sendOrder([H.line(boneless, 1)]);
  await H.waitWebhookDone(db, "shopify", h2);
  await worker.runOnce(db);
  const [r] = await intakeFor(id);
  assert.equal(r.status, "review");
  assert.equal(r.review_reason, "product_deleted");
});

test("inbox rates path with a partial Community product never marks other variants absent", async () => {
  const productSync = require(path.join(ROOT, "productSync.js"));
  const before = await groceryCounts();
  const row = await productSync.upsertFromShopify(db, {
    id: 10341692113154, title: "Tamatar — Community Deal", status: "draft", product_type: "Community Internal",
    tags: ["asb-community-internal"], variants: [{ id: 50595473981698, sku: "ASB-COM-DEMO-TOMATO-5KG", price: "700.00" }],
  });
  assert.equal(row, null);
  const v = (await db.query(`SELECT is_present FROM community_variants WHERE shopify_variant_id = '50595474014466'`)).rows[0];
  assert.equal(v.is_present, true, "the 10 kg variant was not in the inbox payload but must stay present");
  assert.deepEqual(await groceryCounts(), before);
});

test("concurrent sweeps (webhook kick + timer) process each row exactly once", async () => {
  const a = await sendOrder([H.line(H.COMMUNITY.onion5Draft, 1)], { phone: "+92 345 0000003" });
  const b = await sendOrder([H.line(H.COMMUNITY.tomato10Draft, 1)], { phone: "+92 345 0000004" });
  await H.waitWebhookDone(db, "shopify", a.hook);
  await H.waitWebhookDone(db, "shopify", b.hook);
  await Promise.all([worker.sweep(db), worker.sweep(db), worker.runOnce(db), worker.runOnce(db)]);
  for (const o of [a, b]) {
    const [r] = await intakeFor(o.id);
    assert.equal(r.status, "resolved");
    assert.equal(r.attempts, 1, "processed once, not once per sweep");
  }
});

test("/healthz reports Community readiness and the review backlog", async () => {
  const res = await fetch(`${base}/healthz`);
  const body = await res.json();
  assert.equal(body.community.ready, true);
  assert.ok(body.community.variants >= 28);
  assert.ok(body.community.review >= 1);
  assert.equal(res.status, 200);
});
