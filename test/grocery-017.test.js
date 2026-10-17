// ============================================================================
// Migration 017 — Shopify order sources, durable grocery worker, frozen bills,
// at-most-once billing, receipt journal, backfill, switches.
//
// Real Postgres, real migrations, the real Express app; Meta and Shopify are
// stubbed (test/support/harness.js). Nothing here talks to production.
//
// The five final requirements are tagged REQ1 .. REQ5 in the test names.
// ============================================================================
"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { Pool } = require("pg");
const H = require("./support/harness");

const ROOT = path.join(__dirname, "..");
let db, server, base, sent, wa, worker, billing, apply, operator, backfill, activation, fingerprint, alerts, receipts;
let orderSeq = 7900000000000;
let hookSeq = 0;
const nextHook = () => `g017-${process.pid}-${++hookSeq}`;
const delivered = [];

before(async () => {
  const url = await H.createDatabase("asb_t_g017", ROOT);
  H.setEnv(url);
  sent = H.stubOutside(ROOT);
  const mod = require(path.join(ROOT, "server.js"));
  db = require(path.join(ROOT, "db"));
  wa = require(path.join(ROOT, "whatsapp.js"));
  worker = require(path.join(ROOT, "grocery", "worker.js"));
  billing = require(path.join(ROOT, "grocery", "billing.js"));
  apply = require(path.join(ROOT, "grocery", "apply.js"));
  operator = require(path.join(ROOT, "grocery", "operator.js"));
  backfill = require(path.join(ROOT, "grocery", "backfill.js"));
  activation = require(path.join(ROOT, "grocery", "activation.js"));
  fingerprint = require(path.join(ROOT, "grocery", "fingerprint.js"));
  alerts = require(path.join(ROOT, "grocery", "alerts.js"));
  receipts = require(path.join(ROOT, "grocery", "receipts.js"));
  alerts._setDeliver(async (_db, a) => { delivered.push(a); return { devices: 0, delivered: 0 }; });
  await require(path.join(ROOT, "productSync.js")).ensureSchema(db);
  await db.query(H.FIXTURE_SQL);
  server = mod.app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await new Promise((r) => setTimeout(r, 200));
  await db?.shutdown();
});

// ---------------------------------------------------------------------------
function newOrder(lines, extra = {}) {
  const id = ++orderSeq;
  return H.shopifyOrder({ id, name: `#G${id % 100000}`, lines, ...extra });
}
async function post(order, hook = nextHook(), topic = "orders/create") {
  const status = await H.postShopify(base, order, { id: hook, topic });
  return { status, hook };
}
async function deliver(order, hook) {
  const r = await post(order, hook);
  assert.equal(r.status, 200);
  await H.waitWebhookDone(db, "shopify", r.hook);
  return r.hook;
}
const src = async (orderId) =>
  (await db.query(`SELECT * FROM shopify_order_sources WHERE shopify_order_id = $1`, [String(orderId)])).rows[0];
const qtyOf = async (orderId) => (await db.query(
  `SELECT p.sku, oi.qty_ordered::float AS q FROM shopify_order_sources s JOIN order_items oi ON oi.order_id = s.order_id
     JOIN products p ON p.id = oi.product_id WHERE s.shopify_order_id = $1 ORDER BY p.sku`, [String(orderId)])).rows;
const attemptsOf = async (sourceId) => (await db.query(
  `SELECT * FROM shopify_order_bill_attempts WHERE source_id = $1 ORDER BY attempt_no`, [sourceId])).rows;
const waRows = async (prefix) => (await db.query(
  `SELECT idempotency_key, wamid, status::text AS status, template_name FROM whatsapp_messages
    WHERE idempotency_key LIKE $1 ORDER BY id`, [`${prefix}%`])).rows;
const phoneN = () => `+92 333 ${String(1000000 + ++hookSeq).slice(-7)}`;
const asPhone = (p) => require(path.join(ROOT, "server.js")).normalizePhone(p);

/** Swap the WhatsApp stubs for one test. results: array of structured results (or fns), used in order. */
function scriptSends(results) {
  const origText = wa.sendText, origTpl = wa.sendTemplate;
  const calls = [];
  const next = (kind, phone, x) => {
    calls.push({ kind, phone, x });
    const r = results.shift();
    if (!r) throw new Error("no scripted send result left");
    return typeof r === "function" ? r() : r;
  };
  wa.sendText = async (phone, text) => next("text", phone, text);
  wa.sendTemplate = async (phone, name, params) => next("template", phone, { name, params });
  return { calls, restore: () => { wa.sendText = origText; wa.sendTemplate = origTpl; } };
}
const ACCEPT = (w) => ({ outcome: "accepted", retryable: false, wamid: w, ok: true, phase: "response" });

// ---------------------------------------------------------------------------
// Idempotency and the one-to-many mapping
// ---------------------------------------------------------------------------

test("same Shopify order under two delivery ids, concurrently: one source, one apply, one bill", async () => {
  const o = newOrder([H.line(H.GROCERY.aloo, 2)], { phone: phoneN() });
  const before = sent.length;
  const [a, b] = await Promise.all([post(o), post(o)]);
  assert.deepEqual([a.status, b.status], [200, 200]);
  await H.waitWebhookDone(db, "shopify", a.hook);
  await H.waitWebhookDone(db, "shopify", b.hook);
  await new Promise((r) => setTimeout(r, 150));
  assert.equal((await db.query(`SELECT count(*)::int n FROM shopify_order_sources WHERE shopify_order_id = $1`, [String(o.id)])).rows[0].n, 1);
  assert.deepEqual(await qtyOf(o.id), [{ sku: "ASB-VEG-001", q: 2 }]);
  assert.equal(sent.length, before + 1, "exactly one bill");
  const ev = (await db.query(`SELECT status FROM webhook_events WHERE event_id = ANY($1) ORDER BY status`, [[a.hook, b.hook]])).rows.map((r) => r.status);
  assert.deepEqual(ev, ["ignored", "processed"]);
});

test("two DIFFERENT Shopify orders, same household, concurrently: one bag, merged exactly once, two bills", async () => {
  const phone = phoneN();
  const o1 = newOrder([H.line(H.GROCERY.aloo, 1)], { phone });
  const o2 = newOrder([H.line(H.GROCERY.aloo, 3), H.line(H.GROCERY.mango, 1)], { phone });
  const before = sent.length;
  const [a, b] = await Promise.all([post(o1), post(o2)]);
  await H.waitWebhookDone(db, "shopify", a.hook);
  await H.waitWebhookDone(db, "shopify", b.hook);
  const s1 = await src(o1.id), s2 = await src(o2.id);
  assert.equal(s1.order_id, s2.order_id, "one ASB bag");
  assert.deepEqual([s1.disposition, s2.disposition].sort(), ["created", "merged"]);
  assert.deepEqual(await qtyOf(o1.id), [{ sku: "ASB-FRT-001", q: 1 }, { sku: "ASB-VEG-001", q: 4 }]);
  assert.equal(sent.length, before + 2, "one bill per Shopify order");
  // A redelivery of the MERGED order under a new id changes nothing.
  const s = sent.length;
  await deliver(o2);
  assert.deepEqual(await qtyOf(o1.id), [{ sku: "ASB-FRT-001", q: 1 }, { sku: "ASB-VEG-001", q: 4 }]);
  assert.equal(sent.length, s);
});

test("each bill is frozen at apply time: a later merge does not change the earlier bill", async () => {
  const phone = phoneN();
  const o1 = newOrder([H.line(H.GROCERY.aloo, 1)], { phone });
  await deliver(o1);
  const snap1 = (await db.query(`SELECT rich_text FROM shopify_order_bill_snapshots WHERE source_id = $1`, [(await src(o1.id)).id])).rows[0];
  await deliver(newOrder([H.line(H.GROCERY.mango, 2)], { phone }));
  const again = (await db.query(`SELECT rich_text FROM shopify_order_bill_snapshots WHERE source_id = $1`, [(await src(o1.id)).id])).rows[0];
  assert.equal(again.rich_text, snap1.rich_text);
  assert.doesNotMatch(snap1.rich_text, /Aam/i);
});

test("mixed cart and Community-only orders map cleanly; redelivery is a no-op", async () => {
  const mixed = newOrder([H.line(H.GROCERY.mango, 1), H.line(H.COMMUNITY.onion5Draft, 1)], { phone: phoneN() });
  await deliver(mixed);
  const sm = await src(mixed.id);
  assert.equal(sm.status, "applied");
  const kinds = (await db.query(`SELECT kind FROM shopify_order_source_lines WHERE source_id = $1 ORDER BY kind`, [sm.id])).rows.map((r) => r.kind);
  assert.deepEqual(kinds, ["community", "grocery"]);
  const conly = newOrder([H.line(H.COMMUNITY.tomato10Draft, 1)], { phone: phoneN() });
  const before = sent.length;
  await deliver(conly);
  const sc = await src(conly.id);
  assert.deepEqual([sc.status, sc.bill_state, sc.order_id], ["community_only", "not_required", null]);
  await deliver(conly);
  assert.equal(sent.length, before);
  assert.equal((await db.query(`SELECT count(*)::int n FROM community_intake WHERE shopify_order_id = $1`, [String(conly.id)])).rows[0].n, 1);
});

test("duplicate with DIFFERENT commerce content: never re-applied, loud anomaly, visible in /healthz", async () => {
  const o = newOrder([H.line(H.GROCERY.aloo, 1)], { phone: phoneN() });
  await deliver(o);
  const changed = { ...o, note: "Gate 2 please", line_items: [{ ...o.line_items[0], quantity: 5 }] };
  const n0 = delivered.length;
  const hook = await deliver(changed);
  assert.deepEqual(await qtyOf(o.id), [{ sku: "ASB-VEG-001", q: 1 }], "first captured create wins");
  const ev = (await db.query(`SELECT status, error_detail FROM webhook_events WHERE event_id = $1`, [hook])).rows[0];
  assert.equal(ev.status, "ignored");
  assert.match(ev.error_detail, /MISMATCH/);
  const d = (await db.query(`SELECT * FROM shopify_order_source_duplicates WHERE source_id = $1`, [(await src(o.id)).id])).rows[0];
  assert.equal(d.fingerprint_differs, true);
  await H.waitFor(async () => delivered.length > n0);
  const a = delivered.find((x) => x.kind === "duplicate_anomaly" && x.detail.shopify_order_id === String(o.id));
  assert.ok(a, "anomaly alert delivered after commit");
  assert.ok(a.detail.differing_fields.includes("order.note"));
  const h = await (await fetch(`${base}/healthz`)).json();
  assert.ok(h.grocery.open_anomalies >= 1);
  // Same content, different bytes (key order): quiet duplicate, no alert.
  const reordered = JSON.parse(JSON.stringify({ line_items: o.line_items, ...o }));
  const n1 = delivered.length;
  await deliver(reordered);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(delivered.filter((x) => x.kind === "duplicate_anomaly").length,
               delivered.slice(0, n1).filter((x) => x.kind === "duplicate_anomaly").length);
});

// ---------------------------------------------------------------------------
// REQ2 — fingerprints compare at the SOURCE's frozen version
// ---------------------------------------------------------------------------

test("REQ2: a duplicate is fingerprinted at the source's version, never reinterpreting the source under a newer one", async () => {
  // Version 2 (test only) also hashes total_price.
  fingerprint._testRegister(2, (p) => ({ ...fingerprint.canonicalV1(p), v: "2",
    total: p && p.total_price !== undefined ? String(p.total_price?.[Object.getOwnPropertySymbols(p.total_price)[0]] ?? p.total_price) : null }));
  const o = newOrder([H.line(H.GROCERY.mango, 1)], { phone: phoneN() });
  await deliver(o);                                         // source captured at v1
  const s = await src(o.id);
  assert.equal(s.commerce_fingerprint_version, 1);
  fingerprint._testRegister(2, null, { makeCurrent: true });
  try {
    // total_price differs: invisible to v1, visible to v2.
    const dup = { ...o, total_price: "99999" };
    const raw = JSON.stringify(dup);
    assert.notEqual(fingerprint.computeAt(raw, 2).hash, fingerprint.computeAt(JSON.stringify(o), 2).hash);
    await deliver(dup);
    const d = (await db.query(`SELECT * FROM shopify_order_source_duplicates WHERE source_id = $1 ORDER BY id DESC`, [s.id])).rows[0];
    assert.equal(d.commerce_fingerprint_version, 1, "computed at the source's version");
    assert.equal(d.fingerprint_differs, false, "no false anomaly from a newer version");
    assert.equal((await src(o.id)).commerce_fingerprint, s.commerce_fingerprint, "source fingerprint untouched");
    // A NEW order is captured at the current version.
    const o2 = newOrder([H.line(H.GROCERY.mango, 1)], { phone: phoneN() });
    await deliver(o2);
    assert.equal((await src(o2.id)).commerce_fingerprint_version, 2);
  } finally {
    fingerprint._testRegister(1, null, { makeCurrent: true });
  }
});

test("fingerprint v1: deterministic line order, CRLF, decimals, timezones, big ids", () => {
  const a = { id: 1, created_at: "2026-10-08T06:00:00+05:00", note: "a\r\nb ", currency: "pkr",
              line_items: [{ id: 3, price: "700.0", quantity: 1 }, { id: 2, price: "50", quantity: 2.0 }] };
  const b = { id: 1, created_at: "2026-10-08T01:00:00Z", note: "a\nb", currency: "PKR",
              line_items: [{ id: 2, price: "50.00", quantity: 2 }, { id: 3, price: "700.00", quantity: 1 }] };
  assert.equal(fingerprint.computeAt(JSON.stringify(a), 1).hash, fingerprint.computeAt(JSON.stringify(b), 1).hash);
  const big = '{"id": 98765432109876543210, "line_items": []}';
  assert.equal(fingerprint.computeAt(big, 1).canonical.order.id, "98765432109876543210");
  const c = { ...b, shipping_address: { address1: "Flat 9" } };
  assert.notEqual(fingerprint.computeAt(JSON.stringify(c), 1).hash, fingerprint.computeAt(JSON.stringify(b), 1).hash);
});

// ---------------------------------------------------------------------------
// Durable worker, attempts, switches
// ---------------------------------------------------------------------------

test("worker switch OFF: captured and durable but not applied; ON + sweep applies it once", async () => {
  process.env.GROCERY_SOURCE_WORKER = "off";
  const o = newOrder([H.line(H.GROCERY.aloo, 1)], { phone: phoneN() });
  const { status, hook } = await post(o);
  assert.equal(status, 200);
  await new Promise((r) => setTimeout(r, 200));
  let s = await src(o.id);
  assert.deepEqual([s.status, s.bill_state, s.order_id], ["received", "not_ready", null]);
  assert.equal((await db.query(`SELECT status FROM webhook_events WHERE event_id = $1`, [hook])).rows[0].status, "received");
  process.env.GROCERY_SOURCE_WORKER = "on";
  await worker.runOnce(db);
  s = await src(o.id);
  assert.equal(s.status, "applied");
  assert.equal(s.attempts, 1);
  assert.equal(s.bill_state, "sent");
});

test("bill switch OFF: applied, bill stays pending; ON -> sent once", async () => {
  process.env.GROCERY_BILL_SEND = "off";
  const o = newOrder([H.line(H.GROCERY.mango, 1)], { phone: phoneN() });
  await post(o);
  await H.waitFor(async () => (await src(o.id))?.status === "applied");
  assert.equal((await src(o.id)).bill_state, "pending");
  const before = sent.length;
  await worker.runOnce(db);
  assert.equal(sent.length, before, "nothing sent while off");
  process.env.GROCERY_BILL_SEND = "on";
  await worker.runOnce(db);
  assert.equal((await src(o.id)).bill_state, "sent");
  assert.equal(sent.length, before + 1);
});

test("attempts count attempts STARTED: an expired lease counts, success after it shows 2 (webhook mirrors it)", async () => {
  process.env.GROCERY_SOURCE_WORKER = "off";
  const o = newOrder([H.line(H.GROCERY.aloo, 1)], { phone: phoneN() });
  const { hook } = await post(o);
  process.env.GROCERY_SOURCE_WORKER = "on";
  const s0 = await src(o.id);
  const lease = await apply.claim(db, s0.id);            // started ... then "crashed"
  assert.equal(lease.attempts, 1);
  await db.query(`UPDATE shopify_order_sources SET lease_until = now() - interval '1 second' WHERE id = $1`, [s0.id]);
  assert.equal(await apply.expireLeases(db), 1);
  let s = await src(o.id);
  assert.deepEqual([s.status, s.attempts], ["retryable_error", 1]);
  await db.query(`UPDATE shopify_order_sources SET next_attempt_at = now() WHERE id = $1`, [s0.id]);
  await worker.runOnce(db);
  s = await src(o.id);
  assert.deepEqual([s.status, s.attempts], ["applied", 2]);
  assert.equal((await db.query(`SELECT attempts FROM webhook_events WHERE event_id = $1`, [hook])).rows[0].attempts, 2);
});

test("no phone: review + alert, no order, no bill", async () => {
  const o = newOrder([H.line(H.GROCERY.aloo, 1)], { phone: null });
  const before = sent.length;
  const hook = await deliver(o);
  const s = await src(o.id);
  assert.deepEqual([s.status, s.review_reason, s.bill_state, s.order_id], ["review", "no_phone", "not_ready", null]);
  assert.equal((await db.query(`SELECT status FROM webhook_events WHERE event_id = $1`, [hook])).rows[0].status, "failed");
  assert.equal(sent.length, before);
  assert.ok((await db.query(`SELECT 1 FROM grocery_alerts WHERE source_id = $1 AND kind = 'review'`, [s.id])).rows.length);
});

test("apply keeps failing: retryable with backoff, then review after the budget; no improvised bill", async () => {
  process.env.GROCERY_SOURCE_WORKER = "off";
  const o = newOrder([H.line(H.GROCERY.aloo, 1)], { phone: phoneN() });
  await post(o);
  process.env.GROCERY_SOURCE_WORKER = "on";
  const s0 = await src(o.id);
  const before = sent.length;
  await db.query(`ALTER TABLE order_items RENAME TO order_items_hidden`);
  try {
    for (let i = 0; i < apply.MAX_ATTEMPTS; i++) {
      await db.query(`UPDATE shopify_order_sources SET next_attempt_at = now() WHERE id = $1`, [s0.id]);
      await apply.processSource(db, s0.id);
    }
  } finally {
    await db.query(`ALTER TABLE order_items_hidden RENAME TO order_items`);
  }
  const s = await src(o.id);
  assert.deepEqual([s.status, s.review_reason, s.attempts], ["review", "max_attempts", apply.MAX_ATTEMPTS]);
  assert.equal(sent.length, before, "no bill was improvised");
  // Operator requeue gives a fresh budget and the order applies.
  await operator.requeue(db, { sourceId: s.id, by: "Waqas", reason: "table restored" });
  await worker.runOnce(db);
  assert.equal((await src(o.id)).status, "applied");
});

// ---------------------------------------------------------------------------
// Billing: at-most-once automatic send
// ---------------------------------------------------------------------------

test("ambiguous send -> unknown + alert; never re-sent automatically; claim expiry also -> unknown", async () => {
  const sc = scriptSends([{ outcome: "ambiguous", retryable: false, phase: "request", errorCode: "ECONNRESET" }]);
  let o;
  try {
    o = newOrder([H.line(H.GROCERY.aloo, 1)], { phone: phoneN() });
    await deliver(o);
  } finally { sc.restore(); }
  const s = await src(o.id);
  assert.equal(s.bill_state, "unknown");
  const before = sent.length;
  await worker.runOnce(db);
  assert.equal(sent.length, before, "unknown is never retried automatically");
  assert.deepEqual((await waRows(`order_confirmed:shopify:${o.id}`)).map((r) => r.status), ["queued"]);

  // A claim that never finalizes (crash between send and finalize) -> unknown.
  process.env.GROCERY_BILL_SEND = "off";
  const o2 = newOrder([H.line(H.GROCERY.aloo, 1)], { phone: phoneN() });
  await post(o2);
  await H.waitFor(async () => (await src(o2.id))?.bill_state === "pending");
  process.env.GROCERY_BILL_SEND = "on";
  const cl = await billing.claim(db, (await src(o2.id)).id);
  assert.ok(cl.attemptId);
  await assert.rejects(db.query(`UPDATE shopify_order_bill_attempts SET claimed_at = claimed_at - interval '1 hour' WHERE id = $1`,
                                [cl.attemptId]), /immutable/);
  assert.equal(await billing.expireClaims(db, { olderThanMin: 0 }), 1);
  assert.equal((await src(o2.id)).bill_state, "unknown");
  // The late result (accepted) still lands: unknown -> sent with the wamid.
  assert.equal(await billing.finalize(db, cl.attemptId, cl.token, ACCEPT("wamid.LATE1")), "late_accepted");
  assert.equal((await src(o2.id)).bill_state, "sent");
  assert.deepEqual((await waRows(`order_confirmed:shopify:${o2.id}`)).map((r) => [r.status, r.wamid]), [["sent", "wamid.LATE1"]]);
});

test("REQ4: an operator resend persists its authorization on the source; the claim records it on attempt 2", async () => {
  const sc = scriptSends([{ outcome: "refused", retryable: false, phase: "response", httpStatus: 400, metaCode: 131026 }]);
  let o;
  try {
    o = newOrder([H.line(H.GROCERY.mango, 1)], { phone: phoneN() });
    await deliver(o);
  } finally { sc.restore(); }
  let s = await src(o.id);
  assert.deepEqual([s.bill_state, s.bill_outcome], ["failed", "refused"]);
  await assert.rejects(db.query(`UPDATE shopify_order_sources SET bill_authorization_audit_id = 1 WHERE id = $1`, [s.id]),
                       /resend authorization|bill_authorization|violates/);
  const r = await operator.billResend(db, { sourceId: s.id, by: "Waqas", reason: "number fixed, resend" });
  s = await src(o.id);
  assert.equal(s.bill_state, "pending");
  assert.equal(String(s.bill_authorization_audit_id), String(r.authorization_audit_id), "authorization persisted on the source");
  await billing.processBill(db, s.id);
  s = await src(o.id);
  assert.equal(s.bill_state, "sent");
  assert.equal(s.bill_authorization_audit_id, null, "consumed by the claim");
  const at = await attemptsOf(s.id);
  assert.deepEqual(at.map((a) => [a.attempt_no, a.outcome, a.initiated_by, a.authorization_audit_id && String(a.authorization_audit_id)]),
                   [[1, "refused", "worker", null], [2, "accepted", "Waqas", String(r.authorization_audit_id)]]);
  // Attempt history preserved: one log row per attempt, the resend recorded as sent with its own wamid.
  const rows = await waRows(`order_confirmed:shopify:${o.id}`);
  assert.deepEqual(rows.map((x) => [x.idempotency_key, x.status]),
                   [[`order_confirmed:shopify:${o.id}`, "failed"], [`order_confirmed:shopify:${o.id}:attempt:2`, "sent"]]);
  assert.ok(rows[1].wamid);
});

test("REQ5: 131047 (window shut) is definite not-sent and retries as a TEMPLATE on the next attempt", async () => {
  const phone = phoneN();
  // The 24h window LOOKS open (an inbound message), so attempt 1 goes as text.
  await db.query(`INSERT INTO whatsapp_messages (phone, direction, status, received_at, msg_type, body_preview)
                  VALUES ($1, 'inbound', 'delivered', now(), 'text', 'salam')`, [asPhone(phone)]);
  const sc = scriptSends([
    { outcome: "not_sent", retryable: true, retryVia: "template", phase: "response", httpStatus: 400, metaCode: 131047 },
    ACCEPT("wamid.TPL131047"),
  ]);
  let o;
  try {
    o = newOrder([H.line(H.GROCERY.aloo, 1)], { phone });
    await deliver(o);
  } finally { sc.restore(); }
  assert.deepEqual(sc.calls.map((c) => c.kind), ["text", "template"]);
  const s = await src(o.id);
  assert.equal(s.bill_state, "sent");
  const at = await attemptsOf(s.id);
  assert.deepEqual(at.map((a) => [a.attempt_no, a.channel, a.outcome, a.retryable]),
                   [[1, "text", "not_sent", true], [2, "template", "accepted", false]]);
});

test("REQ5: transport classification (structured result, not inferred from ok:false)", async () => {
  const realFetch = global.fetch;
  const reply = (status, body) => async () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  const fail = (code, name = "TypeError") => async () => { const e = new Error(`fetch failed (${code})`); e.name = name; e.cause = { code }; throw e; };
  const cases = [
    [reply(200, { messages: [{ id: "wamid.OK" }] }), "accepted", false],
    [reply(200, { messages: [] }), "ambiguous", false],
    [reply(200, "not json"), "ambiguous", false],
    [reply(400, { error: { code: 131047, message: "Re-engagement message" } }), "not_sent", true, "template"],
    [reply(400, { error: { code: 130429, message: "rate limit" } }), "refused", true],
    [reply(400, { error: { code: 100, message: "invalid param" } }), "refused", false],
    [reply(401, { error: { code: 190, message: "token expired" } }), "refused", false],
    [reply(500, { error: { code: 2, message: "service unavailable" } }), "ambiguous", false],
    [reply(404, "<html>"), "ambiguous", false],
    [fail("ECONNREFUSED"), "not_sent", true],
    [fail("ENOTFOUND"), "not_sent", true],
    [fail("ECONNRESET"), "ambiguous", false],
    [fail("ABORT_ERR", "AbortError"), "ambiguous", false],
  ];
  try {
    for (const [fn, outcome, retryable, via] of cases) {
      global.fetch = fn;
      const r = await wa.postMessage({ to: "923000000000", type: "text", text: { body: "x" } });
      assert.equal(r.outcome, outcome, `${fn} -> ${r.outcome}`);
      assert.equal(r.retryable, retryable);
      if (via) assert.equal(r.retryVia, via);
      assert.equal(r.ok, outcome === "accepted", "legacy ok field");
    }
  } finally {
    global.fetch = realFetch;
  }
});

test("bill staleness uses age (not a locked cycle); a cancelled bag needs no bill; a hold blocks sending", async () => {
  process.env.GROCERY_BILL_SEND = "off";
  const o = newOrder([H.line(H.GROCERY.aloo, 1)], { phone: phoneN() });
  await post(o);
  await H.waitFor(async () => (await src(o.id))?.bill_state === "pending");
  const s = await src(o.id);
  // The cycle locks (normal after cutoff): the bill is STILL sent.
  await db.query(`UPDATE cycles SET status = 'locked', locked_at = now() WHERE id = $1`, [s.cycle_id]);
  assert.equal((await db.query(`SELECT status::text s FROM cycles WHERE id = $1`, [s.cycle_id])).rows[0].s, "locked");
  await operator.billHold(db, { sourceId: s.id, by: "Waqas", reason: "checking the address" });
  process.env.GROCERY_BILL_SEND = "on";
  assert.equal(await billing.processBill(db, s.id), null, "held");
  await assert.rejects(db.query(`UPDATE shopify_order_sources SET bill_hold_at = NULL WHERE id = $1`, [s.id]), /hold_all_or_none/);
  await operator.billRelease(db, { sourceId: s.id, by: "Waqas", reason: "address ok" });
  assert.equal(await billing.processBill(db, s.id), "sent", "a locked cycle does not suppress a valid confirmation");
  await db.query(`UPDATE cycles SET status = 'open' WHERE id = $1`, [s.cycle_id]);

  // Cancelled bag -> not_required.
  process.env.GROCERY_BILL_SEND = "off";
  const o2 = newOrder([H.line(H.GROCERY.aloo, 1)], { phone: phoneN() });
  await post(o2);
  await H.waitFor(async () => (await src(o2.id))?.bill_state === "pending");
  await db.query(`UPDATE orders SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [(await src(o2.id)).order_id]);
  process.env.GROCERY_BILL_SEND = "on";
  assert.equal(await billing.processBill(db, (await src(o2.id)).id), "cancelled");
  assert.equal((await src(o2.id)).bill_state, "not_required");
});

test("a bill older than GROCERY_BILL_MAX_AGE_H is held back as stale (alert); an operator resend overrides the age rule", async () => {
  process.env.GROCERY_BILL_SEND = "off";
  const o = newOrder([H.line(H.GROCERY.aloo, 1)], { phone: phoneN() });
  await post(o);
  await H.waitFor(async () => (await src(o.id))?.bill_state === "pending");
  process.env.GROCERY_BILL_SEND = "on";
  process.env.GROCERY_BILL_MAX_AGE_H = "0";
  try {
    const before = sent.length;
    assert.equal(await billing.processBill(db, (await src(o.id)).id), "stale");
    assert.deepEqual([(await src(o.id)).bill_state, (await src(o.id)).bill_outcome], ["failed", "stale"]);
    assert.equal(sent.length, before);
    await operator.billResend(db, { sourceId: (await src(o.id)).id, by: "Waqas", reason: "still relevant, send it" });
    assert.equal(await billing.processBill(db, (await src(o.id)).id), "sent");
  } finally {
    delete process.env.GROCERY_BILL_MAX_AGE_H;
  }
});

test("compose error: the order is applied, the bill fails visibly; operator compose -> sent", async () => {
  const bill = require(path.join(ROOT, "bill.js"));
  const orig = bill.orderConfirmation;
  bill.orderConfirmation = () => { throw new Error("template bug"); };
  let o;
  try {
    o = newOrder([H.line(H.GROCERY.aloo, 1)], { phone: phoneN() });
    await deliver(o);
  } finally { bill.orderConfirmation = orig; }
  let s = await src(o.id);
  assert.deepEqual([s.status, s.bill_state, s.bill_outcome], ["applied", "failed", "compose_error"]);
  await operator.billCompose(db, { sourceId: s.id, by: "Waqas", reason: "template fixed" });
  await billing.processBill(db, s.id);
  s = await src(o.id);
  assert.equal(s.bill_state, "sent");
});

// ---------------------------------------------------------------------------
// REQ1 — receipts journalled before the 200, applied monotonically
// ---------------------------------------------------------------------------

function receiptBody(statuses) {
  return { object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { phone_number_id: "000000" }, statuses } }] }] };
}
const st = (id, status, ts, recipient = "923000000001") => ({ id, status, timestamp: String(ts), recipient_id: recipient });

test("REQ1: receipts are journalled BEFORE the 200; a journal failure answers 503 and stores nothing", async () => {
  await db.query(`ALTER TABLE whatsapp_receipt_backlog RENAME TO wrb_hidden`);
  let status;
  try {
    status = await H.postWhatsApp(base, receiptBody([st("wamid.J1", "delivered", 1791427200)]));
  } finally {
    await db.query(`ALTER TABLE wrb_hidden RENAME TO whatsapp_receipt_backlog`);
  }
  assert.equal(status, 503, "never acknowledged unrecorded");
  // Meta retries: journalled, then 200.
  assert.equal(await H.postWhatsApp(base, receiptBody([st("wamid.J1", "delivered", 1791427200)])), 200);
  const j = (await db.query(`SELECT * FROM whatsapp_receipt_backlog WHERE wamid = 'wamid.J1'`)).rows;
  assert.equal(j.length, 1, "journalled");
  assert.equal(j[0].applied_at, null, "no message row yet: waits in the journal");
});

test("REQ1: a receipt that arrives before its bill row is applied once the row exists; read is never downgraded", async () => {
  const sc = scriptSends([ACCEPT("wamid.EARLY1")]);
  let o;
  try {
    // The receipt for the wamid arrives BEFORE the send is even logged.
    assert.equal(await H.postWhatsApp(base, receiptBody([st("wamid.EARLY1", "read", 1791427300)])), 200);
    o = newOrder([H.line(H.GROCERY.mango, 1)], { phone: phoneN() });
    await deliver(o);
  } finally { sc.restore(); }
  await H.waitFor(async () => (await waRows(`order_confirmed:shopify:${o.id}`))[0]?.status === "read");
  // Late, lower receipts never downgrade, and never clear delivered/read times.
  assert.equal(await H.postWhatsApp(base, receiptBody([st("wamid.EARLY1", "delivered", 1791427100),
                                                        st("wamid.EARLY1", "sent", 1791427000)])), 200);
  await new Promise((r) => setTimeout(r, 150));
  await receipts.replay(db);
  const m = (await db.query(`SELECT status::text AS status, delivered_at, read_at FROM whatsapp_messages WHERE wamid = 'wamid.EARLY1'`)).rows[0];
  assert.equal(m.status, "read");
  assert.ok(m.read_at && m.delivered_at, "timestamps kept");
  const j = (await db.query(`SELECT status, applied_at FROM whatsapp_receipt_backlog WHERE wamid = 'wamid.EARLY1' ORDER BY status`)).rows;
  assert.ok(j.every((r) => r.applied_at), "every journalled receipt marked applied once");
  await assert.rejects(db.query(`UPDATE whatsapp_receipt_backlog SET applied_at = now() WHERE wamid = 'wamid.EARLY1'`), /only applied_at may be set, once/);
});

test("REQ1: delivered after read on an ordinary (non-bill) message keeps read; failed receipt for a sent bill alerts", async () => {
  await db.query(`INSERT INTO whatsapp_messages (wamid, phone, direction, status, msg_type, body_preview)
                  VALUES ('wamid.PLAIN1', '923000000002', 'outbound', 'sent', 'text', 'hi')`);
  assert.equal(await H.postWhatsApp(base, receiptBody([st("wamid.PLAIN1", "read", 1791427500)])), 200);
  assert.equal(await H.postWhatsApp(base, receiptBody([st("wamid.PLAIN1", "delivered", 1791427400)])), 200);
  await H.waitFor(async () => (await db.query(`SELECT count(*)::int n FROM whatsapp_receipt_backlog WHERE wamid = 'wamid.PLAIN1' AND applied_at IS NOT NULL`)).rows[0].n === 2);
  assert.equal((await db.query(`SELECT status::text s FROM whatsapp_messages WHERE wamid = 'wamid.PLAIN1'`)).rows[0].s, "read");

  const sc = scriptSends([ACCEPT("wamid.FAILLATER")]);
  let o;
  try { o = newOrder([H.line(H.GROCERY.aloo, 1)], { phone: phoneN() }); await deliver(o); } finally { sc.restore(); }
  const n0 = delivered.length;
  assert.equal(await H.postWhatsApp(base, receiptBody([st("wamid.FAILLATER", "failed", 1791427600)])), 200);
  await H.waitFor(async () => delivered.slice(n0).some((a) => a.kind === "bill_delivery_failed"));
  assert.equal((await src(o.id)).bill_state, "sent", "acceptance stands; the failure is an alert");
});

test("REQ1: an unknown bill can be proven by a journalled receipt only through an audited operator link", async () => {
  const sc = scriptSends([{ outcome: "ambiguous", retryable: false, phase: "request", errorCode: "UND_ERR_SOCKET" }]);
  const phone = phoneN();
  let o;
  try { o = newOrder([H.line(H.GROCERY.aloo, 1)], { phone }); await deliver(o); } finally { sc.restore(); }
  const s = await src(o.id);
  assert.equal(s.bill_state, "unknown");
  assert.equal(await H.postWhatsApp(base, receiptBody([st("wamid.PROOF1", "delivered", 1791427700, asPhone(phone))])), 200);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal((await src(o.id)).bill_state, "unknown", "never linked automatically");
  await operator.linkReceipt(db, { attemptId: s.bill_current_attempt_id, wamid: "wamid.PROOF1", by: "Waqas",
                                   reason: "customer chat shows the bill" });
  const after = await src(o.id);
  assert.deepEqual([after.bill_state, after.bill_proof], ["sent", "receipt"]);
  assert.deepEqual((await waRows(`order_confirmed:shopify:${o.id}`)).map((r) => [r.status, r.wamid]), [["delivered", "wamid.PROOF1"]]);
});

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

test("guards: illegal combinations and transitions are refused by the database", async () => {
  const o = newOrder([H.line(H.GROCERY.aloo, 1)], { phone: phoneN() });
  await deliver(o);
  const s = await src(o.id);
  await assert.rejects(db.query(`UPDATE shopify_order_sources SET status = 'received' WHERE id = $1`, [s.id]), /not allowed/);
  await assert.rejects(db.query(`UPDATE shopify_order_sources SET bill_state = 'pending' WHERE id = $1`, [s.id]), /only for a 131047/);
  await assert.rejects(db.query(`UPDATE shopify_order_sources SET order_id = NULL WHERE id = $1`, [s.id]), /set-once|violates/);
  await assert.rejects(db.query(`UPDATE shopify_order_sources SET commerce_fingerprint = 'x' WHERE id = $1`, [s.id]), /immutable/);
  await assert.rejects(db.query(`DELETE FROM shopify_order_sources WHERE id = $1`, [s.id]), /not allowed/);
  await assert.rejects(db.query(`TRUNCATE shopify_order_bill_attempts CASCADE`), /not allowed/);
  await assert.rejects(db.query(`UPDATE shopify_order_bill_snapshots SET rich_text = 'x' WHERE source_id = $1`, [s.id]), /not allowed/);
  await assert.rejects(db.query(`UPDATE shopify_order_bill_attempts SET wamid = 'other' WHERE source_id = $1`, [s.id]), /set once/);
  // received + failed in one row is impossible even transiently.
  process.env.GROCERY_SOURCE_WORKER = "off";
  const o2 = newOrder([H.line(H.GROCERY.aloo, 1)], { phone: phoneN() });
  await post(o2);
  process.env.GROCERY_SOURCE_WORKER = "on";
  await assert.rejects(db.query(`UPDATE shopify_order_sources SET bill_state = 'failed' WHERE id = $1`, [(await src(o2.id)).id]), /sos_bill_live/);
  await worker.runOnce(db);
});

// ---------------------------------------------------------------------------
// REQ3 — backfill: transactional, plan-hash approved, old/new overlap
// ---------------------------------------------------------------------------

function poolDb(url) {
  const pool = new Pool({ connectionString: url, max: 3 });
  return {
    pool,
    query: (t, p) => pool.query(t, p),
    tx: async (fn) => {
      const c = await pool.connect();
      try { await c.query("BEGIN"); const r = await fn(c); await c.query("COMMIT"); return r; }
      catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
    },
  };
}

test("REQ3: backfill maps old orders, converts old/new overlap to legacy, is all-or-nothing, marker last", async () => {
  const url = await H.createDatabase("asb_t_g017_backfill", ROOT, { grocery: false });
  const b = poolDb(url);
  const SHOP = H.SHOP;
  try {
    await b.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS meta_retailer_id TEXT`);
    await b.query(H.FIXTURE_SQL);
    const cust = (await b.query(`INSERT INTO customers (phone, name) VALUES ('923001110000', 'Old') RETURNING id`)).rows[0].id;
    const cyc = (await b.query(`INSERT INTO cycles (code, cycle_date, opens_at, locks_at, delivery_date, status)
                                VALUES ('C-T', '2026-10-12', now(), now() + interval '1 day', '2026-10-12', 'open') RETURNING id`)).rows[0].id;
    const ev = async (id, oid, status) => (await b.query(
      `INSERT INTO webhook_events (source, event_id, topic, payload, status) VALUES ('shopify', $1, 'orders/create', $2, $3) RETURNING id`,
      [id, { id: Number(oid) }, status])).rows[0].id;
    // Old code: A persisted (orders row), B merged into A's bag (processed, no row), C failed, D unfinished.
    await b.query(`INSERT INTO orders (customer_id, cycle_id, channel, status, shopify_order_id) VALUES ($1, $2, 'shopify', 'confirmed', '5000000000001')`, [cust, cyc]);
    await ev("old-A", "5000000000001", "processed");
    await ev("old-B", "5000000000002", "processed");
    await b.query(`INSERT INTO webhook_events (source, event_id, topic, payload, status) VALUES ('shopify', 'old-C', 'orders/create', $1, 'failed')`,
                  [H.shopifyOrder({ id: 5000000000003, name: "#OLDC", lines: [H.line(H.GROCERY.aloo, 2)], phone: "+92 300 7770003" })]);
    await ev("old-D", "5000000000004", "received");
    await b.query(`INSERT INTO whatsapp_messages (idempotency_key, phone, direction, status, msg_type)
                   VALUES ('order_confirmed:shopify:5000000000001', '923001110000', 'outbound', 'sent', 'template')`);
    // New code (gate closed) captured redeliveries of A and B, and a brand-new order E.
    const live = async (oid, status = "received") => {
      const raw = JSON.stringify({ id: Number(oid), line_items: [] });
      const e = await ev(`new-${oid}`, oid, "received");
      const fp = fingerprint.computeAt(raw, 1);
      return (await b.query(
        `INSERT INTO shopify_order_sources (origin, shop, shopify_order_id, first_webhook_event_id, payload_sha256, payload_raw,
           commerce_fingerprint, commerce_fingerprint_version, commerce_canonical, status, bill_state)
         VALUES ('live', $1, $2, $3, 'sha', $4, $5, 1, $6, $7, 'not_ready') RETURNING id`,
        [SHOP, oid, e, raw, fp.hash, fp.canonical, status])).rows[0].id;
    };
    const liveA = await live("5000000000001");
    await live("5000000000002");
    await live("5000000000005");
    await live("5000000000006", "retryable_error");

    // Worker cannot be activated before the backfill.
    await assert.rejects(activation.activate(b, { what: "worker", by: "Waqas", reason: "too early" }), /backfill has not completed/);

    const p = await backfill.plan(b, { shop: SHOP });
    const byId = Object.fromEntries(p.rows.map((r) => [r.shopify_order_id, r]));
    assert.deepEqual([byId["5000000000001"].action, byId["5000000000001"].legacy_reason, byId["5000000000001"].order_id !== null],
                     ["upgrade", "persisted_before_cutover", true]);
    assert.deepEqual([byId["5000000000002"].action, byId["5000000000002"].legacy_reason, byId["5000000000002"].order_id],
                     ["upgrade", "event_processed_unmapped", null]);
    assert.equal(byId["5000000000003"].legacy_reason, "event_failed");
    assert.equal(byId["5000000000004"].legacy_reason, "event_unfinished");
    assert.equal(byId["5000000000005"], undefined, "a genuinely new order is left for the worker");
    assert.equal(byId["5000000000001"].legacy_bill_evidence, true);

    // Wrong hash -> refused, nothing written.
    await assert.rejects(backfill.apply(b, { shop: SHOP, by: "Waqas", reason: "r", planSha: "0".repeat(64) }), /plan changed/);
    // A failing verification rolls the WHOLE run back: here a live row the
    // plan does not convert (retryable_error) whose order the old code saved.
    await b.query(`INSERT INTO orders (customer_id, cycle_id, channel, status, shopify_order_id)
                   VALUES ($1, $2, 'shopify', 'cancelled', '5000000000006')`, [cust, cyc]);
    const p2 = await backfill.plan(b, { shop: SHOP });
    await assert.rejects(backfill.apply(b, { shop: SHOP, by: "Waqas", reason: "r", planSha: p2.plan_sha256 }), /verification failed/);
    assert.equal((await b.query(`SELECT count(*)::int n FROM shopify_order_sources WHERE origin = 'backfill'`)).rows[0].n, 0, "rolled back");
    assert.equal(await backfill.markerOf(b), null, "no marker after a failed run");
    assert.equal((await b.query(`SELECT status FROM shopify_order_sources WHERE id = $1`, [liveA])).rows[0].status, "received");

    // Obstacle removed; the approved plan runs.
    await b.query(`UPDATE orders SET shopify_order_id = NULL WHERE shopify_order_id = '5000000000006'`);
    const p3 = await backfill.plan(b, { shop: SHOP });
    await backfill.apply(b, { shop: SHOP, by: "Waqas", reason: "cutover", planSha: p3.plan_sha256 });
    const m = await backfill.markerOf(b);
    assert.ok(m && m.by === "Waqas", "marker written last, with who and why");
    const rows = Object.fromEntries((await b.query(
      `SELECT shopify_order_id, status, legacy_reason, order_id, bill_state FROM shopify_order_sources`)).rows.map((x) => [x.shopify_order_id, x]));
    assert.deepEqual([rows["5000000000001"].status, rows["5000000000001"].legacy_reason, rows["5000000000001"].bill_state],
                     ["legacy", "persisted_before_cutover", "legacy"]);
    assert.ok(rows["5000000000001"].order_id);
    assert.deepEqual([rows["5000000000002"].status, rows["5000000000002"].legacy_reason, rows["5000000000002"].order_id],
                     ["legacy", "event_processed_unmapped", null]);
    assert.equal(rows["5000000000003"].legacy_reason, "event_failed");
    assert.equal((await b.query(`SELECT status FROM webhook_events WHERE event_id = 'new-5000000000001'`)).rows[0].status, "ignored");
    // Run once only.
    await assert.rejects(backfill.apply(b, { shop: SHOP, by: "Waqas", reason: "again", planSha: p3.plan_sha256 }), /already completed/);
    // The backfill did NOT activate anything; activation is separate.
    const sw = require(path.join(ROOT, "grocery", "switches.js"));
    assert.deepEqual(await sw.settings(b).then((x) => [Boolean(x.backfill), Boolean(x.worker), Boolean(x.bills)]), [true, false, false]);
    await assert.rejects(activation.activate(b, { what: "bills", by: "Waqas", reason: "x" }), /activate the worker first/);
    await activation.activate(b, { what: "worker", by: "Waqas", reason: "approved" });
    // Legacy reason survives a reopen (provenance), and only failed/unfinished can be reopened.
    await assert.rejects(operator.reopenLegacy(b, { sourceId: liveA, by: "Waqas", reason: "x" }), /only legacy event_failed/);
    const c = (await b.query(`SELECT id FROM shopify_order_sources WHERE shopify_order_id = '5000000000003'`)).rows[0].id;
    await operator.reopenLegacy(b, { sourceId: c, by: "Waqas", reason: "old failure, apply it" });
    const reopened = (await b.query(`SELECT status, legacy_reason, bill_state FROM shopify_order_sources WHERE id = $1`, [c])).rows[0];
    assert.deepEqual(reopened, { status: "received", legacy_reason: "event_failed", bill_state: "not_required" });
    // ... and the worker really applies it from the old event's stored payload.
    process.env.GROCERY_SOURCE_WORKER = "on";
    assert.equal(await apply.processSource(b, c), "applied");
    const done = (await b.query(`SELECT status, legacy_reason, bill_state, order_id FROM shopify_order_sources WHERE id = $1`, [c])).rows[0];
    assert.deepEqual([done.status, done.legacy_reason, done.bill_state], ["applied", "event_failed", "not_required"]);
    assert.deepEqual((await b.query(`SELECT qty_ordered::float q FROM order_items WHERE order_id = $1`, [done.order_id])).rows, [{ q: 2 }]);
  } finally {
    await b.pool.end();
  }
});

// ---------------------------------------------------------------------------
// Review-pass regressions
// ---------------------------------------------------------------------------

test("guard: failed/unknown -> pending without an operator authorization is refused by the database", async () => {
  const sc = scriptSends([{ outcome: "ambiguous", retryable: false, phase: "request" }]);
  let o;
  try { o = newOrder([H.line(H.GROCERY.aloo, 1)], { phone: phoneN() }); await deliver(o); } finally { sc.restore(); }
  const s = await src(o.id);
  assert.equal(s.bill_state, "unknown");
  await assert.rejects(db.query(`UPDATE shopify_order_sources SET bill_state = 'pending' WHERE id = $1`, [s.id]), /needs an operator authorization/);
});

test("authorized resend of a STALE bill keeps its authority on the 131047 template retry", async () => {
  process.env.GROCERY_BILL_SEND = "off";
  const phone = phoneN();
  await db.query(`INSERT INTO whatsapp_messages (phone, direction, status, received_at, msg_type, body_preview)
                  VALUES ($1, 'inbound', 'delivered', now(), 'text', 'salam')`, [asPhone(phone)]);
  const o = newOrder([H.line(H.GROCERY.aloo, 1)], { phone });
  await post(o);
  await H.waitFor(async () => (await src(o.id))?.bill_state === "pending");
  process.env.GROCERY_BILL_SEND = "on";
  process.env.GROCERY_BILL_MAX_AGE_H = "0";
  try {
    assert.equal(await billing.processBill(db, (await src(o.id)).id), "stale");
    await operator.billResend(db, { sourceId: (await src(o.id)).id, by: "Waqas", reason: "send anyway" });
    const sc = scriptSends([
      { outcome: "not_sent", retryable: true, retryVia: "template", phase: "response", httpStatus: 400, metaCode: 131047 },
      ACCEPT("wamid.STALE131047"),
    ]);
    try { assert.equal(await billing.processBill(db, (await src(o.id)).id), "sent"); } finally { sc.restore(); }
    assert.deepEqual(sc.calls.map((c) => c.kind), ["text", "template"]);
  } finally {
    delete process.env.GROCERY_BILL_MAX_AGE_H;
  }
});

test("a pre-017 log row under the bill key: attempt numbering skips it, the accepted wamid is recorded", async () => {
  process.env.GROCERY_BILL_SEND = "off";
  const o = newOrder([H.line(H.GROCERY.mango, 1)], { phone: phoneN() });
  await post(o);
  await H.waitFor(async () => (await src(o.id))?.bill_state === "pending");
  // Old code logged its improvised bill under the attempt-1 key, as failed.
  await db.query(`INSERT INTO whatsapp_messages (idempotency_key, phone, direction, status, msg_type)
                  VALUES ($1, '923000000099', 'outbound', 'failed', 'template')`, [`order_confirmed:shopify:${o.id}`]);
  process.env.GROCERY_BILL_SEND = "on";
  const sc = scriptSends([ACCEPT("wamid.SKIP1")]);
  try { assert.equal(await billing.processBill(db, (await src(o.id)).id), "sent"); } finally { sc.restore(); }
  const at = await attemptsOf((await src(o.id)).id);
  assert.deepEqual(at.map((a) => [a.attempt_no, a.message_key.endsWith(":attempt:2"), a.wamid]), [[2, true, "wamid.SKIP1"]]);
});

test("REQ5: 131047 reported ASYNCHRONOUSLY (failed receipt after acceptance) re-sends once, as a template", async () => {
  const phone = phoneN();
  await db.query(`INSERT INTO whatsapp_messages (phone, direction, status, received_at, msg_type, body_preview)
                  VALUES ($1, 'inbound', 'delivered', now(), 'text', 'salam')`, [asPhone(phone)]);
  const sc = scriptSends([ACCEPT("wamid.ASYNC1"), ACCEPT("wamid.ASYNC2")]);
  let o;
  try {
    o = newOrder([H.line(H.GROCERY.aloo, 1)], { phone });
    await deliver(o);
    assert.equal((await src(o.id)).bill_state, "sent");
    const failed = { id: "wamid.ASYNC1", status: "failed", timestamp: "1791428000", recipient_id: asPhone(phone),
                     errors: [{ code: 131047, title: "Re-engagement message" }] };
    assert.equal(await H.postWhatsApp(base, receiptBody([failed])), 200);
    await H.waitFor(async () => (await src(o.id))?.bill_state === "sent" && (await attemptsOf((await src(o.id)).id)).length === 2);
  } finally { sc.restore(); }
  assert.deepEqual(sc.calls.map((c) => c.kind), ["text", "template"]);
  const at = await attemptsOf((await src(o.id)).id);
  assert.deepEqual(at.map((a) => [a.channel, a.outcome, a.wamid]), [["text", "accepted", "wamid.ASYNC1"], ["template", "accepted", "wamid.ASYNC2"]]);
});

test("/healthz is NOT ready when migration 017 is missing (a deploy ahead of the migration is caught)", async () => {
  await db.query(`ALTER TABLE shopify_order_sources RENAME TO sos_hidden`);
  let res, body;
  try {
    res = await fetch(`${base}/healthz`);
    body = await res.json();
  } finally {
    await db.query(`ALTER TABLE sos_hidden RENAME TO shopify_order_sources`);
  }
  assert.equal(res.status, 503);
  assert.equal(body.grocery.available, false);
});

test("the bag writer refuses a Shopify order already in a bag, even on the merge path", async () => {
  const { persistOrder } = require(path.join(ROOT, "server.js"));
  const o = newOrder([H.line(H.GROCERY.aloo, 2)], { phone: phoneN() });
  const first = await persistOrder(o, asPhone(o.shipping_address.phone));
  assert.equal(first.alreadyPersisted, false);
  const again = await persistOrder(o, asPhone(o.shipping_address.phone));
  assert.equal(again.alreadyPersisted, true);
  assert.deepEqual((await db.query(`SELECT qty_ordered::float q FROM order_items WHERE order_id = $1`, [first.orderId])).rows, [{ q: 2 }]);
});

// ---------------------------------------------------------------------------
// Second review pass (alerts, rehearsal safety, lossless ids, 131047, late
// receipts, source-aware foreign keys)
// ---------------------------------------------------------------------------

const push = () => require(path.join(ROOT, "push.js"));
async function newAlert(kind = "review") {
  return db.tx((c) => alerts.insert(c, { kind, detail: { summary: `test ${kind}` } }));
}
const alertRow = async (id) => (await db.query(`SELECT * FROM grocery_alerts WHERE id = $1`, [id])).rows[0];
function stubWebpush(behaviour) {
  const wp = push()._webpush;
  const orig = wp.sendNotification;
  const calls = [];
  wp.sendNotification = async (sub, payload) => { calls.push({ endpoint: sub.endpoint, payload }); return behaviour(sub); };
  return { calls, restore: () => { wp.sendNotification = orig; } };
}
async function addDevices(n) {
  for (let i = 0; i < n; i++) {
    await db.query(`INSERT INTO push_subscriptions (endpoint, p256dh, auth, agent) VALUES ($1, 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', 'tBHItJI5svbpez7KI4CCXg', 'test')`,
                   [`https://push.example.invalid/dev-${process.pid}-${i}-${Date.now()}`]);
  }
}

test("alerts: NO subscribed device is never 'sent' - retried with backoff, then gave_up", async () => {
  alerts._setDeliver(null);                                   // the real push path
  await db.query(`DELETE FROM push_subscriptions`);
  process.env.GROCERY_ALERT_MAX_ATTEMPTS = "2";
  const wp = stubWebpush(() => ({}));
  try {
    const id = await newAlert();
    await alerts.dispatch(db, [id]);
    let a = await alertRow(id);
    assert.deepEqual([a.state, a.attempts, a.last_error], ["pending", 1, "no subscribed devices"]);
    assert.ok(new Date(a.next_attempt_at) > new Date(), "backed off");
    await alerts.dispatch(db, [id]);
    assert.equal((await alertRow(id)).attempts, 1, "not retried before its backoff");
    await db.query(`UPDATE grocery_alerts SET next_attempt_at = now() WHERE id = $1`, [id]);
    await alerts.dispatch(db, [id]);
    a = await alertRow(id);
    assert.deepEqual([a.state, a.attempts], ["gave_up", 2]);
    assert.equal(wp.calls.length, 0);
    const h = await (await fetch(`${base}/healthz`)).json();
    assert.ok(h.grocery.alerts_gave_up >= 1, "visible in /healthz");
  } finally {
    wp.restore();
    delete process.env.GROCERY_ALERT_MAX_ATTEMPTS;
    alerts._setDeliver(async (_db, a) => { delivered.push(a); return { devices: 0, delivered: 0 }; });
  }
});

test("alerts: every device failing is not 'sent'; one device accepting is", async () => {
  alerts._setDeliver(null);
  await db.query(`DELETE FROM push_subscriptions`);
  await addDevices(2);
  let wp = stubWebpush(() => { const e = new Error("push service down"); e.statusCode = 500; throw e; });
  try {
    const id = await newAlert("bill_failed");
    await alerts.dispatch(db, [id]);
    const a = await alertRow(id);
    assert.deepEqual([a.state, a.attempts, a.last_error], ["pending", 1, "0 of 2 device(s) accepted"]);
    assert.equal(wp.calls.length, 2, "both devices were tried");
    wp.restore();
    let n = 0;
    wp = stubWebpush(() => { if (n++ === 0) { const e = new Error("gone"); e.statusCode = 500; throw e; } return {}; });
    await db.query(`UPDATE grocery_alerts SET next_attempt_at = now() WHERE id = $1`, [id]);
    await alerts.dispatch(db, [id]);
    const b = await alertRow(id);
    assert.deepEqual([b.state, b.attempts], ["sent", 2], "one of two devices accepted -> sent");
  } finally {
    wp.restore();
    await db.query(`DELETE FROM push_subscriptions`);
    alerts._setDeliver(async (_db, a) => { delivered.push(a); return { devices: 0, delivered: 0 }; });
  }
});

test("rehearsal safety: on a database marked rehearsal, alerts are recorded but NO push network action happens", async () => {
  alerts._setDeliver(null);
  await db.query(`DELETE FROM push_subscriptions`);
  await addDevices(2);                                        // a copy of production carries real subscriptions
  const wp = stubWebpush(() => ({}));
  await db.query(`INSERT INTO app_settings (key, value) VALUES ('asb_environment', 'rehearsal')`);
  try {
    const id = await newAlert("duplicate_anomaly");
    const r = await alerts.dispatch(db, [id]);
    assert.equal(r.suppressed, "rehearsal_environment");
    const a = await alertRow(id);
    assert.deepEqual([a.state, a.attempts], ["pending", 0], "recorded, untouched");
    // The inbox's own notification path is suppressed too.
    const m = await push().newMessage(db, { from: "923001234567", name: "X", preview: "hi", type: "text" });
    assert.equal(m.suppressed, "rehearsal_environment");
    assert.equal(wp.calls.length, 0, "no push request left the process");
    const h = await (await fetch(`${base}/healthz`)).json();
    assert.equal(h.grocery.push_suppressed, "rehearsal_environment");
  } finally {
    await db.query(`DELETE FROM app_settings WHERE key = 'asb_environment'`);
    wp.restore();
    await db.query(`DELETE FROM push_subscriptions`);
    alerts._setDeliver(async (_db, a) => { delivered.push(a); return { devices: 0, delivered: 0 }; });
  }
});

test("alert push switch OFF: alerts recorded, deliver never called", async () => {
  process.env.GROCERY_ALERT_PUSH = "off";
  const n0 = delivered.length;
  try {
    const id = await newAlert();
    const r = await alerts.dispatch(db, [id]);
    assert.match(r.suppressed, /GROCERY_ALERT_PUSH/);
    assert.equal(delivered.length, n0);
    assert.equal((await alertRow(id)).state, "pending");
  } finally {
    process.env.GROCERY_ALERT_PUSH = "on";
  }
});

test("lossless ids end to end: Shopify ids > 2^53 reach source, intake, classification, bag and lines unchanged", async () => {
  const registry = require(path.join(ROOT, "community", "registry.js"));
  await db.query(`INSERT INTO products (sku, name_en, category, unit, step_qty, min_qty, is_weighed, shopify_product_id,
                                        shopify_variant_id, is_active, asb_price, market_price)
                  VALUES ('ASB-BIG-001', 'Big Aloo', 'sabziyaan', 'kg', 1, 1, true, '9007199254741005', '9007199254741003', true, 50, 60)`);
  await registry.upsertProduct(db, { id: "9007199254741011", title: "Big Pack — Community Deal", status: "draft",
    product_type: "Community Internal", vendor: "Apna Sasta Bazaar", tags: "asb-community-internal",
    variants: [{ id: "9007199254741009", sku: "ASB-COM-BIG-5KG", title: "5 kg", price: "700.00" }] }, "webhook");
  const raw = `{"id":9007199254740993,"name":"#BIG1","created_at":"2026-10-08T06:00:00+05:00","currency":"PKR","note":null,"phone":null,
    "total_price":"900.00",
    "customer":{"id":9007199254740995,"first_name":"Big","last_name":"Id","phone":null},
    "shipping_address":{"first_name":"Big","last_name":"Id","phone":"+92 333 7654321","address1":"Flat 1","address2":"Block 2"},
    "line_items":[
      {"id":9007199254741001,"variant_id":9007199254741003,"product_id":9007199254741005,"sku":"ASB-BIG-001","title":"Big Aloo","price":"50.00","quantity":2,"vendor":"Apna Sasta Bazaar"},
      {"id":9007199254741007,"variant_id":9007199254741009,"product_id":9007199254741011,"sku":"ASB-COM-BIG-5KG","title":"Big Pack — Community Deal","variant_title":"5 kg","price":"700.00","quantity":1,"vendor":"Apna Sasta Bazaar"}]}`;
  assert.notEqual(String(JSON.parse(raw).id), "9007199254740993", "plain JSON.parse would corrupt this id");
  const hook = nextHook();
  assert.equal(await H.postShopifyRaw(base, raw, { id: hook }), 200);
  await H.waitWebhookDone(db, "shopify", hook);

  const s = (await db.query(`SELECT * FROM shopify_order_sources WHERE shopify_order_id = '9007199254740993'`)).rows[0];
  assert.ok(s, "source keyed by the exact id");
  assert.equal(s.status, "applied");
  const intake = (await db.query(`SELECT shopify_order_id, shopify_line_item_id, shopify_variant_id, shopify_product_id
                                    FROM community_intake WHERE shopify_order_id = '9007199254740993'`)).rows;
  assert.deepEqual(intake, [{ shopify_order_id: "9007199254740993", shopify_line_item_id: "9007199254741007",
                              shopify_variant_id: "9007199254741009", shopify_product_id: "9007199254741011" }],
                   "Community line classified by its exact variant id");
  const o = (await db.query(`SELECT shopify_order_id FROM orders WHERE id = $1`, [s.order_id])).rows[0];
  assert.equal(o.shopify_order_id, "9007199254740993");
  const items = (await db.query(`SELECT p.shopify_variant_id, oi.qty_ordered::float q FROM order_items oi
                                   JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1`, [s.order_id])).rows;
  assert.deepEqual(items, [{ shopify_variant_id: "9007199254741003", q: 2 }], "grocery line matched by its exact variant id");
  const lines = (await db.query(`SELECT shopify_line_item_id, kind FROM shopify_order_source_lines WHERE source_id = $1
                                   ORDER BY shopify_line_item_id`, [s.id])).rows;
  assert.deepEqual(lines, [{ shopify_line_item_id: "9007199254741001", kind: "grocery" },
                           { shopify_line_item_id: "9007199254741007", kind: "community" }]);
  const cust = (await db.query(`SELECT shopify_customer_id FROM customers WHERE id = $1`, [s.customer_id])).rows[0];
  assert.equal(cust.shopify_customer_id, "9007199254740995");
  // A redelivery with the same exact id is the same order.
  const hook2 = nextHook();
  assert.equal(await H.postShopifyRaw(base, raw, { id: hook2 }), 200);
  await H.waitWebhookDone(db, "shopify", hook2);
  assert.deepEqual((await db.query(`SELECT qty_ordered::float q FROM order_items WHERE order_id = $1`, [s.order_id])).rows, [{ q: 2 }]);
});

test("async 131047 on a TEMPLATE attempt is not retried automatically (alert only)", async () => {
  const sc = scriptSends([ACCEPT("wamid.TPLFAIL1")]);
  let o;
  try { o = newOrder([H.line(H.GROCERY.aloo, 1)], { phone: phoneN() }); await deliver(o); } finally { sc.restore(); }
  assert.deepEqual(sc.calls.map((c) => c.kind), ["template"]);
  const n0 = delivered.length;
  const failed = { id: "wamid.TPLFAIL1", status: "failed", timestamp: "1791429000", recipient_id: "x", errors: [{ code: 131047 }] };
  assert.equal(await H.postWhatsApp(base, receiptBody([failed])), 200);
  await H.waitFor(async () => delivered.slice(n0).some((a) => a.kind === "bill_delivery_failed"));
  await new Promise((r) => setTimeout(r, 100));
  const s = await src(o.id);
  assert.equal(s.bill_state, "sent");
  assert.equal((await attemptsOf(s.id)).length, 1, "no automatic resend");
});

test("async 131047 with NO automatic budget left: bill -> failed + alert, no resend", async () => {
  const phone = phoneN();
  await db.query(`INSERT INTO whatsapp_messages (phone, direction, status, received_at, msg_type, body_preview)
                  VALUES ($1, 'inbound', 'delivered', now(), 'text', 'salam')`, [asPhone(phone)]);
  process.env.GROCERY_BILL_MAX_ATTEMPTS = "1";
  const sc = scriptSends([ACCEPT("wamid.BUDGET1")]);
  let o;
  try {
    o = newOrder([H.line(H.GROCERY.aloo, 1)], { phone });
    await deliver(o);
    const failed = { id: "wamid.BUDGET1", status: "failed", timestamp: "1791429100", recipient_id: asPhone(phone), errors: [{ code: 131047 }] };
    assert.equal(await H.postWhatsApp(base, receiptBody([failed])), 200);
    await H.waitFor(async () => (await src(o.id)).bill_state === "failed");
    await new Promise((r) => setTimeout(r, 150));
  } finally { sc.restore(); delete process.env.GROCERY_BILL_MAX_ATTEMPTS; }
  const s = await src(o.id);
  assert.deepEqual([s.bill_state, s.bill_outcome], ["failed", "window_closed"]);
  assert.deepEqual(sc.calls.map((c) => c.kind), ["text"], "no automatic resend");
  assert.ok((await db.query(`SELECT 1 FROM grocery_alerts WHERE source_id = $1 AND kind = 'bill_failed'`, [s.id])).rows.length);
});

test("late receipt for an EARLIER ambiguous attempt after a resend already sent the bill: surfaced, then linked to that attempt", async () => {
  const phone = phoneN();
  let sc = scriptSends([{ outcome: "ambiguous", retryable: false, phase: "request" }]);
  let o;
  try { o = newOrder([H.line(H.GROCERY.aloo, 1)], { phone }); await deliver(o); } finally { sc.restore(); }
  let s = await src(o.id);
  const first = (await attemptsOf(s.id))[0];
  await operator.billResend(db, { sourceId: s.id, by: "Waqas", reason: "customer says nothing came" });
  sc = scriptSends([ACCEPT("wamid.RESEND1")]);
  try { await billing.processBill(db, s.id); } finally { sc.restore(); }
  assert.equal((await src(o.id)).bill_state, "sent");
  // Now WhatsApp reports the FIRST (unknown) attempt as delivered after all.
  assert.equal(await H.postWhatsApp(base, receiptBody([st("wamid.LATEPROOF1", "delivered", Math.floor(Date.now() / 1000), asPhone(phone))])), 200);
  await new Promise((r) => setTimeout(r, 100));
  assert.ok((await receipts.alertUnlinked(db, { olderThanMin: 0 })) >= 1);
  const al = (await db.query(`SELECT detail FROM grocery_alerts WHERE kind = 'receipt_unlinked' AND detail->>'wamid' = 'wamid.LATEPROOF1'`)).rows[0];
  assert.ok(al.detail.candidates.some((c) => String(c.attempt_id) === String(first.id) && c.bill_state === "sent"),
            "surfaced although the source is already 'sent'");
  await assert.rejects(operator.linkReceipt(db, { attemptId: (await attemptsOf(s.id))[1].id, wamid: "wamid.LATEPROOF1", by: "Waqas", reason: "x" }),
                       /cannot take a receipt/);
  const r = await operator.linkReceipt(db, { attemptId: first.id, wamid: "wamid.LATEPROOF1", by: "Waqas", reason: "chat shows two bills" });
  assert.equal(r.bill, "sent");
  const a1 = (await attemptsOf(s.id))[0];
  assert.deepEqual([a1.wamid, a1.proof, a1.outcome], ["wamid.LATEPROOF1", "receipt", "ambiguous"]);
  s = await src(o.id);
  assert.equal(s.bill_proof, "accepted", "the source keeps its own proof");
  const au = (await db.query(`SELECT detail FROM shopify_order_source_audit WHERE source_id = $1 AND action = 'link_receipt'`, [s.id])).rows[0];
  assert.match(au.detail.note, /received both/);
});

test("source-aware foreign keys: a source cannot point at another source's attempt or authorization", async () => {
  process.env.GROCERY_BILL_SEND = "off";
  const oP = newOrder([H.line(H.GROCERY.aloo, 1)], { phone: phoneN() });
  await post(oP);
  await H.waitFor(async () => (await src(oP.id))?.bill_state === "pending");
  process.env.GROCERY_BILL_SEND = "on";
  const oS = newOrder([H.line(H.GROCERY.aloo, 1)], { phone: phoneN() });
  await deliver(oS);
  const sP = await src(oP.id), sS = await src(oS.id);
  const otherAttempt = (await attemptsOf(sS.id))[0].id;
  // 1. current attempt of ANOTHER source
  await assert.rejects(db.query(
    `UPDATE shopify_order_sources SET bill_state = 'sending', bill_attempts = bill_attempts + 1, bill_current_attempt_id = $2 WHERE id = $1`,
    [sP.id, otherAttempt]), /sos_current_attempt/);
  // 2. authorization audit row of ANOTHER source
  await operator.billHold(db, { sourceId: sS.id, by: "Waqas", reason: "test" });
  const foreignAudit = (await db.query(`SELECT id FROM shopify_order_source_audit WHERE source_id = $1 ORDER BY id DESC LIMIT 1`, [sS.id])).rows[0].id;
  const sc = scriptSends([{ outcome: "refused", retryable: false, phase: "response", httpStatus: 400, metaCode: 100 }]);
  try { await billing.processBill(db, sP.id); } finally { sc.restore(); }
  assert.equal((await src(oP.id)).bill_state, "failed");
  await assert.rejects(db.query(
    `UPDATE shopify_order_sources SET bill_state = 'pending', bill_authorization_audit_id = $2 WHERE id = $1`,
    [sP.id, foreignAudit]), /sos_authorization/);
  // 3. an attempt recording ANOTHER source's authorization
  const snap = (await db.query(`SELECT bill_key FROM shopify_order_bill_snapshots WHERE source_id = $1`, [sP.id])).rows[0];
  await assert.rejects(db.query(
    `INSERT INTO shopify_order_bill_attempts (source_id, bill_key, attempt_no, message_key, claim_token, channel, initiated_by, authorization_audit_id)
     VALUES ($1, $2, 9, $2 || ':attempt:9', gen_random_uuid(), 'template', 'Waqas', $3)`,
    [sP.id, snap.bill_key, foreignAudit]), /ba_authorization/);
  await operator.billRelease(db, { sourceId: sS.id, by: "Waqas", reason: "test" });
});

// ---------------------------------------------------------------------------
// Rehearsal with a FAKE Graph endpoint: worker ON, bills ON, real WhatsApp and
// real push impossible.
// ---------------------------------------------------------------------------

test("rehearsal guard refuses a real Graph host with a token, and unsuppressed push", async () => {
  const rehearsal = require(path.join(ROOT, "scripts", "community-rehearsal.js"));
  const fakeDb = { query: async () => ({ rows: [{ value: "rehearsal" }] }) };
  const realFetch = global.fetch;
  const ALL_ON = { available: true, worker_enabled: true, bills_enabled: true, alert_push: true, push_suppressed: "rehearsal_environment" };
  const health = (over) => ({ community: { environment: "rehearsal", ready: true, variants_resolvable: 14 },
    config: { whatsappToken: true, graphHost: "graph.facebook.com" },
    grocery: { ...ALL_ON }, ...over });
  try {
    global.fetch = async () => new Response(JSON.stringify(health({})));
    await assert.rejects(rehearsal.guard(fakeDb, "http://x"), /WhatsApp token and Meta calls go to graph.facebook.com/);
    global.fetch = async () => new Response(JSON.stringify(health({ config: { whatsappToken: true, graphHost: "127.0.0.1" },
      grocery: { ...ALL_ON, push_suppressed: false } })));
    await assert.rejects(rehearsal.guard(fakeDb, "http://x"), /push notifications are NOT suppressed/);
    global.fetch = async () => new Response(JSON.stringify(health({ config: { whatsappToken: true, graphHost: "127.0.0.1" } })));
    await rehearsal.guard(fakeDb, "http://x");
  } finally {
    global.fetch = realFetch;
  }
});

test("rehearsal guard: a full 017 rehearsal needs worker, bills AND alert push on (strictly true) plus push suppressed", async () => {
  const rehearsal = require(path.join(ROOT, "scripts", "community-rehearsal.js"));
  const fakeDb = { query: async () => ({ rows: [{ value: "rehearsal" }] }) };
  const realFetch = global.fetch;
  const ALL_ON = { available: true, worker_enabled: true, bills_enabled: true, alert_push: true, push_suppressed: "PUSH_DISABLED" };
  const withGrocery = (grocery) => ({ community: { environment: "rehearsal", ready: true, variants_resolvable: 14 },
    config: { whatsappToken: true, graphHost: "127.0.0.1" }, grocery });
  const serve = (grocery) => { global.fetch = async () => new Response(JSON.stringify(withGrocery(grocery))); };
  try {
    // Worker on, bills off -> refused.
    serve({ ...ALL_ON, bills_enabled: false });
    await assert.rejects(rehearsal.guard(fakeDb, "http://x"), (e) => {
      assert.ok(e instanceof rehearsal.RehearsalRefused);
      assert.match(e.message, /missing: bills_enabled/);
      assert.doesNotMatch(e.message, /worker_enabled|alert_push/);
      return true;
    });
    // Alert push off -> refused.
    serve({ ...ALL_ON, alert_push: false });
    await assert.rejects(rehearsal.guard(fakeDb, "http://x"), (e) => {
      assert.ok(e instanceof rehearsal.RehearsalRefused);
      assert.match(e.message, /missing: alert_push/);
      assert.doesNotMatch(e.message, /worker_enabled|bills_enabled/);
      return true;
    });
    // Worker off (bills/alerts on) -> refused.
    serve({ ...ALL_ON, worker_enabled: false });
    await assert.rejects(rehearsal.guard(fakeDb, "http://x"), /missing: worker_enabled/);
    // Strict: truthy-but-not-true, or an absent field, refuses.
    serve({ ...ALL_ON, bills_enabled: "yes" });
    await assert.rejects(rehearsal.guard(fakeDb, "http://x"), /missing: bills_enabled/);
    const { alert_push, ...noAlertField } = ALL_ON;
    serve(noAlertField);
    await assert.rejects(rehearsal.guard(fakeDb, "http://x"), /missing: alert_push/);
    // Everything off -> all three named.
    serve({ ...ALL_ON, worker_enabled: false, bills_enabled: false, alert_push: false });
    await assert.rejects(rehearsal.guard(fakeDb, "http://x"), /worker_enabled.*bills_enabled.*alert_push/);
    // All switches on but push not suppressed -> refused.
    serve({ ...ALL_ON, push_suppressed: false });
    await assert.rejects(rehearsal.guard(fakeDb, "http://x"), /push notifications are NOT suppressed/);
    // No 017 grocery block, or grocery not available -> refused.
    serve(undefined);
    await assert.rejects(rehearsal.guard(fakeDb, "http://x"), /017 grocery pipeline as available/);
    serve({ ...ALL_ON, available: false });
    await assert.rejects(rehearsal.guard(fakeDb, "http://x"), /017 grocery pipeline as available/);
    // All four conditions met -> passes.
    serve(ALL_ON);
    const h = await rehearsal.guard(fakeDb, "http://x");
    assert.equal(h.grocery.bills_enabled, true);
  } finally {
    global.fetch = realFetch;
  }
});

test("full rehearsal, run TWICE on the same database, against a staging server whose Meta calls go to a local FAKE Graph: bills really 'sent', no customer-id collision, nothing real touched",
  { timeout: 120000 }, async () => {
    const net = require("net");
    const { spawn } = require("child_process");
    const fs = require("fs");
    const { createFakeGraph } = require(path.join(ROOT, "scripts", "fake-graph.js"));
    const rehearsal = require(path.join(ROOT, "scripts", "community-rehearsal.js"));
    const registryScript = require(path.join(ROOT, "scripts", "community-registry.js"));
    const url = await H.createDatabase("asb_t_g017_fakegraph", ROOT);
    const sdb = poolDb(url);
    const fake = createFakeGraph({ log: () => {} });
    await new Promise((r) => fake.server.listen(0, "127.0.0.1", r));
    const graph = `http://127.0.0.1:${fake.server.address().port}/v25.0`;
    let child;
    try {
      await sdb.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS meta_retailer_id TEXT`);
      await sdb.query(H.FIXTURE_SQL);
      const snap = JSON.parse(fs.readFileSync(path.join(ROOT, "db/community/registry-snapshot-2026-10-08.json"), "utf8"));
      await registryScript.bootstrapSnapshot(sdb, snap.products, { file: "registry-snapshot-2026-10-08.json", apply: true });
      await sdb.query(`INSERT INTO app_settings (key, value) VALUES ('asb_environment', 'rehearsal')`);
      await addDevicesTo(sdb, 1);                     // a "real" device copied from production
      const port = await new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
      const env = { ...process.env, DATABASE_URL: url, PORT: String(port), BIND_HOST: "127.0.0.1", SHOPIFY_WEBHOOK_SECRET: "staging-secret",
                    META_APP_SECRET: "x", COMMUNITY_INTAKE_WORKER: "on", COMMUNITY_INTAKE_SWEEP_MS: "300",
                    GRAPH_BASE: graph, WHATSAPP_TOKEN: "fake-token", PHONE_NUMBER_ID: "000000",
                    GROCERY_SOURCE_WORKER: "on", GROCERY_BILL_SEND: "on", GROCERY_ALERT_PUSH: "on", GROCERY_SWEEP_MS: "500" };
      child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env, stdio: "ignore" });
      const sbase = `http://127.0.0.1:${port}`;
      await H.waitFor(async () => { try { return (await fetch(sbase + "/")).ok; } catch { return false; } }, { timeoutMs: 15000 });
      const out = [];
      const r = await rehearsal.rehearse({ db: sdb, base: sbase, secret: "staging-secret", log: (l) => out.push(l) });
      assert.equal(r.failed, 0, out.join("\n"));
      await H.waitFor(async () => (await sdb.query(
        `SELECT count(*)::int n FROM shopify_order_sources WHERE bill_state = 'sent'`)).rows[0].n >= 2, { timeoutMs: 15000 });
      const sends = fake.requests.filter((q) => /\/messages$/.test(q.url) && q.body?.type);
      assert.ok(sends.length >= 2, "bills went to the FAKE Graph");
      const wam = (await sdb.query(`SELECT wamid FROM whatsapp_messages WHERE idempotency_key LIKE 'order_confirmed:shopify:%'`)).rows;
      assert.ok(wam.length >= 2 && wam.every((w) => /^wamid\.FAKE/.test(w.wamid)));
      // The command sheet's step 14e query: a direct join from rehearsal attempts to their message rows.
      const v = (await sdb.query(
        `SELECT count(a.id)::int AS rehearsal_attempts, count(m.id)::int AS messages_found,
                (count(*) FILTER (WHERE m.wamid LIKE 'wamid.FAKE%'))::int AS fake_ids,
                (count(*) FILTER (WHERE m.wamid IS NOT NULL AND m.wamid NOT LIKE 'wamid.FAKE%'
                                    AND m.wamid NOT LIKE 'wamid.REHEARSAL-LINK-%'))::int AS real_meta_ids
           FROM shopify_order_bill_attempts a
           JOIN shopify_order_sources s ON s.id = a.source_id AND s.shopify_order_name LIKE '#REH-%'
           LEFT JOIN whatsapp_messages m ON m.idempotency_key = a.message_key`)).rows[0];
      assert.ok(v.rehearsal_attempts >= 2, JSON.stringify(v));
      assert.equal(v.messages_found, v.rehearsal_attempts, JSON.stringify(v));
      assert.equal(v.fake_ids, v.rehearsal_attempts, JSON.stringify(v));
      assert.equal(v.real_meta_ids, 0, JSON.stringify(v));
      assert.equal((await sdb.query(`SELECT count(*)::int n FROM grocery_alerts WHERE state = 'sent'`)).rows[0].n, 0,
                   "no alert was pushed to a device");

      // Regression (Neon step 13a): a SECOND rehearsal against the same database
      // must not reuse the first run's synthetic Shopify customer ids. It used
      // new phones with the same ids -> 23505 on customers_shopify_customer_id_key.
      const r2 = await rehearsal.rehearse({ db: sdb, base: sbase, secret: "staging-secret", log: (l) => out.push(l) });
      assert.notEqual(r2.run, r.run);
      assert.equal(r2.failed, 0, out.join("\n"));
      const srcOf = async (run) => (await sdb.query(
        `SELECT shopify_order_name AS name, status, bill_state, last_error FROM shopify_order_sources
          WHERE shopify_order_name LIKE $1 ORDER BY id`, [`#REH-${run}-%`])).rows;
      const second = await H.waitFor(async () => {
        const rows = await srcOf(r2.run);
        const a = rows.find((x) => x.name.endsWith("-A")), c = rows.find((x) => x.name.endsWith("-C"));
        return a?.status === "applied" && c?.status === "applied" && a.bill_state === "sent" && c.bill_state === "sent" && rows;
      }, { timeoutMs: 20000 }).catch(async () => { throw new Error(`second run did not apply: ${JSON.stringify(await srcOf(r2.run))}`); });
      for (const x of second) {
        assert.ok(!["retryable_error", "review"].includes(x.status), JSON.stringify(x));
        assert.doesNotMatch(String(x.last_error || ""), /23505|shopify_customer_id/, JSON.stringify(x));
      }
      const ids = async (run) => (await sdb.query(
        `SELECT DISTINCT c.shopify_customer_id AS id FROM shopify_order_sources s JOIN orders o ON o.id = s.order_id
           JOIN customers c ON c.id = o.customer_id WHERE s.shopify_order_name LIKE $1`, [`#REH-${run}-%`])).rows.map((x) => x.id);
      const [ids1, ids2] = [await ids(r.run), await ids(r2.run)];
      assert.equal(ids1.length, 2, JSON.stringify(ids1));
      assert.equal(ids2.length, 2, JSON.stringify(ids2));
      assert.ok(ids2.every((id) => !ids1.includes(id)), `customer ids reused across runs: ${ids1} / ${ids2}`);
      assert.ok([...ids1, ...ids2].every((id) => Number.isSafeInteger(Number(id))), "ids stay within the safe integer range");
    } finally {
      child?.kill("SIGTERM");
      fake.server.close();
      await sdb.pool.end();
    }
  });

async function addDevicesTo(q, n) {
  for (let i = 0; i < n; i++) {
    await q.query(`INSERT INTO push_subscriptions (endpoint, p256dh, auth, agent) VALUES ($1, 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', 'tBHItJI5svbpez7KI4CCXg', 'prod-copy')`,
                  [`https://push.example.invalid/prodcopy-${process.pid}-${i}`]);
  }
}

// ---------------------------------------------------------------------------
// Neon rehearsal safety: scripts/rehearsal-db.js and BIND_HOST
// ---------------------------------------------------------------------------

test("rehearsal-db host check: exact expected host required; production endpoint (direct or pooled) always refused", () => {
  const { checkHost, Refused } = require(path.join(ROOT, "scripts", "rehearsal-db.js"));
  const REH = "ep-rehearsal-111.c-2.us-east-2.aws.neon.tech";
  const PROD = "ep-production-999.c-2.us-east-2.aws.neon.tech";
  const url = (h) => `postgresql://u:p@${h}/neondb?sslmode=require`;
  const ok = { databaseUrl: url(REH), expectedHost: REH, productionHost: PROD };
  assert.equal(checkHost(ok), REH);
  assert.equal(checkHost({ ...ok, expectedHost: REH.toUpperCase() }), REH);
  const refuses = (over, re) => assert.throws(() => checkHost({ ...ok, ...over }), (e) => e instanceof Refused && re.test(e.message));
  refuses({ databaseUrl: undefined }, /DATABASE_URL is not set/);
  refuses({ expectedHost: "" }, /EXPECTED_REHEARSAL_DB_HOST is not set/);
  refuses({ productionHost: undefined }, /PRODUCTION_DB_HOST is not set/);
  refuses({ databaseUrl: url(PROD), expectedHost: PROD }, /PRODUCTION endpoint/);
  refuses({ databaseUrl: url(PROD) }, /PRODUCTION endpoint/);
  refuses({ databaseUrl: url(PROD.replace("ep-production-999", "ep-production-999-pooler")) }, /PRODUCTION endpoint/);
  refuses({ expectedHost: PROD.replace("ep-production-999", "ep-production-999-pooler"),
            databaseUrl: url(PROD.replace("ep-production-999", "ep-production-999-pooler")) }, /PRODUCTION endpoint/);
  refuses({ expectedHost: PROD }, /EXPECTED_REHEARSAL_DB_HOST is the production endpoint/);
  refuses({ databaseUrl: url("ep-other-222.c-2.us-east-2.aws.neon.tech") }, /does not exactly match/);
  refuses({ databaseUrl: url(`x${REH}`) }, /does not exactly match/);
  const pooled = REH.replace("ep-rehearsal-111", "ep-rehearsal-111-pooler");
  refuses({ databaseUrl: url(pooled), expectedHost: pooled }, /pooled host/);
});

test("rehearsal-db: marking writes only after the host check; --check / --assert-* gate operator targets to #REH- orders", async () => {
  const rdb = require(path.join(ROOT, "scripts", "rehearsal-db.js"));
  const host = new URL(process.env.DATABASE_URL).hostname;
  const env = { DATABASE_URL: process.env.DATABASE_URL, EXPECTED_REHEARSAL_DB_HOST: host, PRODUCTION_DB_HOST: "ep-prod-1.example.neon.tech" };
  const quiet = { log: () => {} };
  const getMarker = async () => (await db.query(`SELECT value FROM app_settings WHERE key = 'asb_environment'`)).rows[0]?.value ?? null;
  const original = await getMarker();
  try {
    await db.query(`DELETE FROM app_settings WHERE key = 'asb_environment'`);
    // Production host -> refused BEFORE any connection; nothing written.
    let touched = false;
    await assert.rejects(rdb.run(["--mark", "--apply"], { ...env, PRODUCTION_DB_HOST: host }, { ...quiet, getDb: () => { touched = true; return db; } }),
      (e) => e instanceof rdb.Refused && /PRODUCTION endpoint/.test(e.message));
    await assert.rejects(rdb.run(["--mark", "--apply"], { ...env, EXPECTED_REHEARSAL_DB_HOST: "other.example" }, { ...quiet, getDb: () => { touched = true; return db; } }),
      /does not exactly match/);
    assert.equal(touched, false, "the database is never opened when the host check fails");
    assert.equal(await getMarker(), null);
    // --check refuses an unmarked database.
    await assert.rejects(rdb.run(["--check"], env, { ...quiet, getDb: () => db }), /not marked as a rehearsal copy/);
    // Dry run writes nothing; --apply writes the marker.
    assert.equal((await rdb.run(["--mark"], env, { ...quiet, getDb: () => db })).wrote, false);
    assert.equal(await getMarker(), null);
    assert.equal((await rdb.run(["--mark", "--apply"], env, { ...quiet, getDb: () => db })).wrote, true);
    assert.equal(await getMarker(), "rehearsal");
    assert.equal((await rdb.run(["--check"], env, { ...quiet, getDb: () => db })).marker, "rehearsal");

    // A rehearsal order and a real-looking order.
    const reh = newOrder([H.line(H.GROCERY.aloo, 1)], { phone: phoneN(), name: `#REH-${process.pid}-A` });
    const real = newOrder([H.line(H.GROCERY.aloo, 1)], { phone: phoneN() });
    await deliver(reh); await deliver(real);
    const sReh = await H.waitFor(async () => { const s = await src(reh.id); return s?.status === "applied" && s; });
    const sReal = await H.waitFor(async () => { const s = await src(real.id); return s?.status === "applied" && s; });
    await deliver({ ...reh, line_items: [H.line(H.GROCERY.aloo, 3)] });          // changed content -> duplicate row
    const dupReh = (await db.query(`SELECT id FROM shopify_order_source_duplicates WHERE source_id = $1`, [sReh.id])).rows[0];
    const attReh = await H.waitFor(async () => (await attemptsOf(sReh.id))[0]);
    const attReal = await H.waitFor(async () => (await attemptsOf(sReal.id))[0]);
    const ok = (args) => rdb.run(args, env, { ...quiet, getDb: () => db });
    assert.equal((await ok(["--assert-source", String(sReh.id)])).source.id, sReh.id);
    assert.equal((await ok(["--assert-attempt", String(attReh.id)])).source.id, sReh.id);
    assert.equal((await ok(["--assert-duplicate", String(dupReh.id)])).source.id, sReh.id);
    await assert.rejects(ok(["--assert-source", String(sReal.id)]), /NOT a rehearsal order/);
    await assert.rejects(ok(["--assert-attempt", String(attReal.id)]), /NOT a rehearsal order/);
    await assert.rejects(ok(["--assert-source", "999999999"]), /not found/);
    await assert.rejects(ok(["--assert-source", "1; DROP TABLE x"]), /numeric id/);
  } finally {
    await db.query(`DELETE FROM app_settings WHERE key = 'asb_environment'`);
    if (original !== null) await db.query(`INSERT INTO app_settings (key, value) VALUES ('asb_environment', $1)`, [original]);
  }
});

test("BIND_HOST=127.0.0.1: the server listens on loopback only; unset keeps the default (all interfaces)", { timeout: 60000 }, async () => {
  const net = require("net");
  const os = require("os");
  const { spawn } = require("child_process");
  const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === "IPv4" && !i.internal)?.address;
  const freePort = () => new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
  const canConnect = (host, port) => new Promise((res) => {
    const c = net.connect({ host, port }); c.once("connect", () => { c.destroy(); res(true); }); c.once("error", () => res(false));
  });
  const boot = async (extra) => {
    const port = await freePort();
    const child = spawn(process.execPath, ["server.js"], { cwd: ROOT, stdio: "ignore",
      env: { ...process.env, PORT: String(port), GROCERY_SOURCE_WORKER: "off", GROCERY_BILL_SEND: "off", COMMUNITY_INTAKE_WORKER: "off", ...extra } });
    await H.waitFor(() => canConnect("127.0.0.1", port), { timeoutMs: 15000 });
    return { child, port };
  };
  const bound = await boot({ BIND_HOST: "127.0.0.1" });
  try {
    assert.equal(await canConnect("127.0.0.1", bound.port), true);
    if (lan) assert.equal(await canConnect(lan, bound.port), false, `must not be reachable on ${lan}`);
  } finally { bound.child.kill(); }
  if (lan) {
    const open = await boot({ BIND_HOST: "" });
    try { assert.equal(await canConnect(lan, open.port), true, "default (Render) behaviour unchanged"); }
    finally { open.child.kill(); }
  }
});
