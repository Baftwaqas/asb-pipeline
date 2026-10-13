"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const H = require("./support/harness");

const ROOT = path.join(__dirname, "..");
let db, reconcile, worker, sent;

before(async () => {
  const url = await H.createDatabase("asb_t_rollback_reconcile", ROOT);
  H.setEnv(url);
  sent = H.stubOutside(ROOT);
  db = require(path.join(ROOT, "db"));
  reconcile = require(path.join(ROOT, "grocery", "rollback-reconcile.js"));
  worker = require(path.join(ROOT, "grocery", "worker.js"));
  await db.query(H.FIXTURE_SQL);
});

after(async () => {
  await db?.shutdown();
});

async function event(payload, { id, status, at }) {
  return (await db.query(
    `INSERT INTO webhook_events (source, event_id, topic, payload, status, received_at, error_detail)
     VALUES ('shopify',$1,'orders/create',$2::jsonb,$3,$4,'synthetic rollback-window test')
     RETURNING id`,
    [id, JSON.stringify(payload), status, at]
  )).rows[0].id;
}

async function source(oid) {
  return (await db.query(`SELECT * FROM shopify_order_sources WHERE shopify_order_id = $1`, [String(oid)])).rows[0];
}

test("rollback-window: failed event with no source is deterministically queued and then applied exactly once", async () => {
  const oid = 8800000010001;
  const o = H.shopifyOrder({ id: oid, name: "#RW-1", lines: [H.line(H.GROCERY.aloo, 1)],
                             phone: "+92 300 7110001", createdAt: "2026-10-13T10:01:00Z" });
  const ev = await event(o, { id: "rw-failed-1", status: "failed", at: "2026-10-13T10:02:00Z" });
  const opts = { shop: H.SHOP, from: "2026-10-13T10:00:00Z", to: "2026-10-13T10:10:00Z" };

  const p1 = await reconcile.plan(db, opts);
  const p2 = await reconcile.plan(db, opts);
  assert.equal(p1.plan_sha256, p2.plan_sha256, "dry plan is deterministic");
  assert.equal(p1.rows.length, 1);
  assert.deepEqual([p1.rows[0].action, p1.rows[0].legacy_reason, p1.rows[0].webhook_event_id],
                   ["replay", "event_failed", String(ev)]);

  const before = sent.length;
  const r = await reconcile.apply(db, { ...opts, planSha: p1.plan_sha256, by: "Waqas", reason: "test recovery" });
  assert.deepEqual([r.queued, r.review_only], [1, 0]);

  let s = await source(oid);
  assert.deepEqual([s.origin, s.status, s.bill_state, s.legacy_reason],
                   ["backfill", "received", "not_ready", "event_failed"]);
  assert.equal((await db.query(`SELECT status FROM webhook_events WHERE id = $1`, [ev])).rows[0].status, "received");
  const actions = (await db.query(
    `SELECT action, detail->>'mode' AS mode FROM shopify_order_source_audit
      WHERE source_id = $1 ORDER BY id`, [s.id])).rows;
  assert.deepEqual(actions.map((x) => [x.action, x.mode]),
                   [["backfill_row", "rollback_window_reconcile"], ["reopen_legacy", "rollback_window_reconcile"]]);

  await worker.runOnce(db);
  s = await source(oid);
  assert.deepEqual([s.status, s.bill_state], ["applied", "sent"]);
  assert.equal(sent.length, before + 1);
  assert.equal((await db.query(
    `SELECT oi.qty_ordered::float q
       FROM order_items oi JOIN shopify_order_sources s ON s.order_id = oi.order_id
      WHERE s.shopify_order_id = $1`, [String(oid)])).rows[0].q, 1);
});

test("rollback-window: stale approved hash refuses everything", async () => {
  const opts = { shop: H.SHOP, from: "2026-10-13T11:00:00Z", to: "2026-10-13T11:10:00Z" };
  const a = H.shopifyOrder({ id: 8800000010011, name: "#RW-A", lines: [H.line(H.GROCERY.aloo, 1)],
                             phone: "+92 300 7110011", createdAt: "2026-10-13T11:01:00Z" });
  await event(a, { id: "rw-stale-a", status: "failed", at: "2026-10-13T11:02:00Z" });
  const approved = await reconcile.plan(db, opts);

  const b = H.shopifyOrder({ id: 8800000010012, name: "#RW-B", lines: [H.line(H.GROCERY.mango, 1)],
                             phone: "+92 300 7110012", createdAt: "2026-10-13T11:03:00Z" });
  await event(b, { id: "rw-stale-b", status: "received", at: "2026-10-13T11:04:00Z" });

  await assert.rejects(
    reconcile.apply(db, { ...opts, planSha: approved.plan_sha256, by: "Waqas", reason: "stale test" }),
    /plan changed since approval/
  );
  assert.equal(await source(a.id), undefined);
  assert.equal(await source(b.id), undefined);
});

test("rollback-window: an existing order is linked as legacy and never replayed", async () => {
  const oid = 8800000010021;
  const orders = require(path.join(ROOT, "orders.js"));
  const orderId = await db.tx(async (c) => {
    const cycle = await orders.resolveCycle(c, new Date("2026-10-13T12:01:00Z"));
    const customer = await orders.upsertCustomer(c, { phone: "923007110021", name: "Link Test" });
    return (await c.query(
      `INSERT INTO orders (customer_id, cycle_id, channel, status, shopify_order_id, shopify_order_name)
       VALUES ($1,$2,'shopify','confirmed',$3,'#RW-LINK') RETURNING id`,
      [customer.id, cycle.id, String(oid)]
    )).rows[0].id;
  });
  const o = H.shopifyOrder({ id: oid, name: "#RW-LINK", lines: [H.line(H.GROCERY.aloo, 2)],
                             phone: "+92 300 7110021", createdAt: "2026-10-13T12:01:00Z" });
  await event(o, { id: "rw-link", status: "failed", at: "2026-10-13T12:02:00Z" });
  const opts = { shop: H.SHOP, from: "2026-10-13T12:00:00Z", to: "2026-10-13T12:10:00Z" };
  const p = await reconcile.plan(db, opts);
  assert.deepEqual([p.rows[0].action, p.rows[0].order_id], ["link_existing", String(orderId)]);
  const before = sent.length;
  await reconcile.apply(db, { ...opts, planSha: p.plan_sha256, by: "Waqas", reason: "link existing" });
  const s = await source(oid);
  assert.deepEqual([s.status, s.bill_state, s.legacy_reason, String(s.order_id)],
                   ["legacy", "legacy", "orders_row", String(orderId)]);
  await worker.runOnce(db);
  assert.equal((await source(oid)).status, "legacy");
  assert.equal(sent.length, before, "linked legacy order is never replayed or billed");
});

test("rollback-window: processed all-Community event is mapped community_only, never grocery-replayed", async () => {
  const oid = 8800000010031;
  const line = H.line(H.COMMUNITY.onion5Draft, 1);
  const o = H.shopifyOrder({ id: oid, name: "#RW-COM", lines: [line],
                             phone: "+92 300 7110031", createdAt: "2026-10-13T13:01:00Z" });
  const ev = await event(o, { id: "rw-community", status: "processed", at: "2026-10-13T13:02:00Z" });
  await db.query(
    `INSERT INTO community_intake
       (shop, shopify_order_id, shopify_line_item_id, shopify_order_name, webhook_event_id, topic,
        shopify_product_id, shopify_variant_id, sku, vendor, title, variant_title, quantity, unit_price,
        currency, customer_phone, shopify_customer_id, order_created_at, line_payload, order_raw,
        order_payload, order_payload_sha256, classification, signals)
     VALUES ($1,$2,$3,$4,$5,'orders/create',$6,$7,$8,$9,$10,$11,$12,$13,'PKR',$14,$15,$16,
             $17::jsonb,$18,$19::jsonb,$20,'registered',ARRAY['registered_variant'])`,
    [H.SHOP, String(oid), String(line.id), o.name, ev, String(line.product_id), String(line.variant_id),
     line.sku, line.vendor, line.title, line.variant_title || null, line.quantity, line.price,
     "923007110031", String(o.customer.id), o.created_at, JSON.stringify(line), JSON.stringify(o),
     JSON.stringify(o), "c".repeat(64)]
  );
  const opts = { shop: H.SHOP, from: "2026-10-13T13:00:00Z", to: "2026-10-13T13:10:00Z" };
  const p = await reconcile.plan(db, opts);
  assert.equal(p.rows[0].action, "map_community_only");
  const before = sent.length;
  await reconcile.apply(db, { ...opts, planSha: p.plan_sha256, by: "Waqas", reason: "map community only" });
  const s = await source(oid);
  assert.deepEqual([s.status, s.bill_state, s.order_id], ["community_only", "not_required", null]);
  assert.equal((await db.query(`SELECT count(*)::int n FROM orders WHERE shopify_order_id = $1`, [String(oid)])).rows[0].n, 0);
  assert.equal(sent.length, before);
});

test("rollback-window: ambiguous processed grocery event is review-only and never auto-created", async () => {
  const oid = 8800000010041;
  const o = H.shopifyOrder({ id: oid, name: "#RW-REVIEW", lines: [H.line(H.GROCERY.aloo, 1)],
                             phone: "+92 300 7110041", createdAt: "2026-10-13T14:01:00Z" });
  await event(o, { id: "rw-review", status: "processed", at: "2026-10-13T14:02:00Z" });
  const opts = { shop: H.SHOP, from: "2026-10-13T14:00:00Z", to: "2026-10-13T14:10:00Z" };
  const p = await reconcile.plan(db, opts);
  assert.deepEqual([p.rows[0].action, p.rows[0].reason],
                   ["review", "processed_without_order_or_complete_community_capture"]);
  const r = await reconcile.apply(db, { ...opts, planSha: p.plan_sha256, by: "Waqas", reason: "review ambiguity" });
  assert.deepEqual([r.applied, r.review_only], [0, 1]);
  assert.equal(await source(oid), undefined);
  const run = (await db.query(
    `SELECT detail FROM shopify_order_source_audit WHERE source_id IS NULL AND action='backfill_run'
      ORDER BY id DESC LIMIT 1`)).rows[0];
  assert.equal(run.detail.mode, "rollback_window_reconcile");
});
