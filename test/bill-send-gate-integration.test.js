// ============================================================================
// Controlled billing safety-gate integration test. A fresh local PostgreSQL
// database, synthetic Shopify webhooks and stubbed WhatsApp: NEVER production.
// Exercises webhook kicks, the sweeper, direct calls, audited hold and release.
// ============================================================================

"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const H = require("./support/harness");

const ROOT = path.join(__dirname, "..");
let db, app, sent, worker, billing, operator, switches, base;
let seq = 0;
const id = () => 8950000000000 + ++seq;

before(async () => {
  const url = await H.createDatabase("asb_t_single_bill", ROOT);
  H.setEnv(url);
  process.env.GROCERY_BILL_SEND = "off";
  process.env.GROCERY_BILL_SEND_SCOPE = "off";
  sent = H.stubOutside(ROOT);
  const server = require(path.join(ROOT, "server.js"));
  db = require(path.join(ROOT, "db"));
  worker = require(path.join(ROOT, "grocery", "worker.js"));
  billing = require(path.join(ROOT, "grocery", "billing.js"));
  operator = require(path.join(ROOT, "grocery", "operator.js"));
  switches = require(path.join(ROOT, "grocery", "switches.js"));
  await require(path.join(ROOT, "productSync.js")).ensureSchema(db);
  await db.query(H.FIXTURE_SQL);
  app = server.app.listen(0);
  await new Promise((resolve) => app.once("listening", resolve));
  base = "http://127.0.0.1:" + app.address().port;
});

after(async () => {
  if (app) await new Promise((resolve) => app.close(resolve));
  await db?.shutdown();
});

async function syntheticOrder() {
  const shopifyId = id();
  return H.shopifyOrder({
    id: shopifyId, name: "#SCOPE-" + shopifyId,
    lines: [H.line(H.GROCERY.aloo, 1)],
    phone: "+92 303 " + String(shopifyId).slice(-7),
  });
}

async function capturedPending(order) {
  const code = await H.postShopify(base, order, { id: "gate-webhook-" + order.id });
  assert.equal(code, 200);
  return H.waitFor(async () => {
    const q = await db.query(
      "SELECT * FROM shopify_order_sources WHERE shopify_order_id = $1",
      [String(order.id)]
    );
    const s = q.rows[0];
    return s?.status === "applied" && s.bill_state === "pending" ? s : null;
  }, { timeoutMs: 12000 });
}

async function attemptCount(sourceId) {
  const q = await db.query(
    "SELECT COUNT(*)::int AS n FROM shopify_order_bill_attempts WHERE source_id = $1",
    [sourceId]
  );
  return q.rows[0].n;
}

test("single-order scope blocks other household bills across sweeper, direct call and webhook kick", async () => {
  const approvedOrder = await syntheticOrder();
  const anotherOrder = await syntheticOrder();
  const allowed = await capturedPending(approvedOrder);
  const blocked = await capturedPending(anotherOrder);
  assert.equal(sent.length, 0, "global bill send is disabled before arming scope");
  assert.equal(await attemptCount(allowed.id), 0);
  assert.equal(await attemptCount(blocked.id), 0);

  // Invalid configuration must not turn the existing global bill activation
  // into permission, even when GROCERY_BILL_SEND is ON.
  process.env.GROCERY_BILL_SEND = "on";
  assert.equal((await switches.status(db)).bills_enabled, false);
  assert.equal(await billing.processBill(db, allowed.id), null);
  await worker.runOnce(db);
  assert.equal(sent.length, 0);
  assert.equal(await attemptCount(allowed.id), 0);

  process.env.GROCERY_BILL_SEND_SCOPE = "single";
  process.env.GROCERY_BILL_TARGET_SOURCE_ID = String(allowed.id);
  process.env.GROCERY_BILL_TARGET_SHOPIFY_ORDER_ID = String(anotherOrder.id);
  assert.equal((await switches.status(db)).bills_enabled, true);
  assert.equal(await billing.processBill(db, allowed.id), null,
               "matching source PK is insufficient with wrong Shopify ID");
  assert.equal(await attemptCount(allowed.id), 0);

  // Arm exact two-key allowlist. An existing audited hold STILL wins.
  process.env.GROCERY_BILL_TARGET_SHOPIFY_ORDER_ID = String(approvedOrder.id);
  assert.equal((await switches.status(db)).bill_scope_mode, "single");
  await operator.billHold(db, { sourceId: allowed.id, by: "synthetic-test",
    reason: "do not dispatch until precisely authorized" });
  await worker.runOnce(db);
  assert.equal(sent.length, 0, "hold prevents the only allowed bill");
  assert.equal(await attemptCount(allowed.id), 0);

  // Explicit operator release while targeted gate is armed: exactly one
  // simulated bill is sent, and all others are left pending, untouched.
  await operator.billRelease(db, { sourceId: allowed.id, by: "synthetic-test",
    reason: "explicit local integration rehearsal" });
  await worker.runOnce(db);
  assert.equal(sent.length, 1, "exactly one fake WhatsApp bill");
  assert.equal(await attemptCount(allowed.id), 1);
  assert.equal(await attemptCount(blocked.id), 0);
  assert.equal((await db.query(
    "SELECT bill_state FROM shopify_order_sources WHERE id = $1", [allowed.id]
  )).rows[0].bill_state, "sent");
  assert.equal((await db.query(
    "SELECT bill_state FROM shopify_order_sources WHERE id = $1", [blocked.id]
  )).rows[0].bill_state, "pending");

  assert.equal(await billing.processBill(db, blocked.id), null,
               "direct call to a different source cannot bypass gate");
  await worker.runOnce(db);
  assert.equal(sent.length, 1, "sweeper and retries did not duplicate bill");

  // A new unrelated order appears AFTER the single-order gate is armed.
  // Its webhook is still applied, but kick(db,id) must not send its bill.
  const newerOrder = await syntheticOrder();
  const newer = await capturedPending(newerOrder);
  assert.equal(await attemptCount(newer.id), 0);
  assert.equal(sent.length, 1, "fresh customer webhook cannot trigger a send");
  await worker.runOnce(db);
  assert.equal(await attemptCount(newer.id), 0);
  assert.equal(sent.length, 1);

  // Emergency OFF is still an unconditional kill switch.
  process.env.GROCERY_BILL_SEND = "off";
  assert.equal((await switches.status(db)).bills_enabled, false);
  assert.equal(await billing.processBill(db, blocked.id), null);
  assert.equal(sent.length, 1);
});
