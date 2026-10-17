// ============================================================================
// ASB PIPELINE — grocery/backfill.js
//
// Maps every Shopify order the PRE-017 code already handled to a
// shopify_order_sources row, so it can never be applied (or billed) again.
// Rows written here only BLOCK re-application; they never apply anything.
//
//   orders_row                orders.shopify_order_id = X     -> order_id known
//   event_processed_unmapped  an old-code orders/create for X was 'processed'
//                             but no order row holds X (merged into another
//                             bag, or Community-only)          -> order_id NULL
//   event_failed / event_unfinished
//                             old-code event 'failed' / still 'received'
//                                                              -> order_id NULL,
//                             listed for a person (reopen_legacy can apply it)
//
// Old/new Render overlap: a LIVE source still 'received' (created by new code
// while the gate was closed) whose Shopify order the old code had already
// persisted or processed is converted to legacy here - persisted_before_cutover
// with its order_id when an order row holds it, else event_processed_unmapped
// with NULL - so the worker can never apply it a second time.
//
// plan()  is read-only and deterministic; it returns rows and a plan_sha256.
// apply() runs in ONE transaction under an advisory lock, refuses unless the
//         recomputed plan hash equals the approved one, verifies the result,
//         and writes the readiness marker LAST. Any failure rolls back
//         everything, marker included.
// ============================================================================

"use strict";

const crypto = require("crypto");
const { KEYS } = require("./switches");

const LOCK_KEY = 17017017;   // pg_advisory_xact_lock key for the 017 backfill

const cmpId = (a, b) => { const d = BigInt(a) - BigInt(b); return d < 0n ? -1 : d > 0n ? 1 : 0; };

async function plan(q, { shop }) {
  if (!shop) throw new Error("backfill needs the shop domain (--shop or SHOPIFY_SHOP_DOMAIN)");

  // Old-code orders/create events: owned by no source and not a recorded duplicate.
  const events = (await q.query(
    `SELECT we.id, we.status, we.payload->>'id' AS oid
       FROM webhook_events we
      WHERE we.source = 'shopify' AND we.topic = 'orders/create'
        AND NOT EXISTS (SELECT 1 FROM shopify_order_sources s WHERE s.first_webhook_event_id = we.id)
        AND NOT EXISTS (SELECT 1 FROM shopify_order_source_duplicates d WHERE d.webhook_event_id = we.id)
      ORDER BY we.id`)).rows;
  const orders = (await q.query(
    `SELECT id, shopify_order_id FROM orders WHERE shopify_order_id IS NOT NULL ORDER BY id`)).rows;
  const existing = (await q.query(
    `SELECT id, origin, status, shopify_order_id FROM shopify_order_sources`)).rows;   // ids are global
  const evidence = new Set((await q.query(
    `SELECT substring(idempotency_key FROM '^order_confirmed:shopify:([0-9]+)$') AS oid
       FROM whatsapp_messages
      WHERE idempotency_key ~ '^order_confirmed:shopify:[0-9]+$' AND status::text IN ('sent','delivered','read')`))
    .rows.map((r) => r.oid));

  const unusable = events.filter((e) => !/^[0-9]+$/.test(e.oid || "")).map((e) => e.id);
  const byOrder = new Map();
  const slot = (oid) => {
    if (!byOrder.has(oid)) byOrder.set(oid, { events: [], orderId: null });
    return byOrder.get(oid);
  };
  for (const e of events) if (/^[0-9]+$/.test(e.oid || "")) slot(e.oid).events.push(e);
  for (const o of orders) if (/^[0-9]+$/.test(o.shopify_order_id)) slot(o.shopify_order_id).orderId = String(o.id);
  const srcBy = new Map(existing.map((s) => [s.shopify_order_id, s]));

  const rows = [];
  for (const oid of [...byOrder.keys()].sort(cmpId)) {
    const { events: evs, orderId } = byOrder.get(oid);
    const first = (st) => evs.find((e) => (st ? e.status === st : true))?.id ?? null;
    const processed = first("processed");
    const src = srcBy.get(oid);
    const bill = evidence.has(oid);

    if (!src) {
      let reason = null, event = null;
      if (orderId) { reason = "orders_row"; event = processed ?? first(null); }
      else if (processed) { reason = "event_processed_unmapped"; event = processed; }
      else if (first("failed")) { reason = "event_failed"; event = first("failed"); }
      else if (first("received")) { reason = "event_unfinished"; event = first("received"); }
      if (!reason) continue;                                  // only 'ignored' events: nothing to map
      rows.push({ action: "insert", shopify_order_id: oid, legacy_reason: reason,
                  order_id: orderId, first_webhook_event_id: event === null ? null : String(event),
                  legacy_bill_evidence: bill, source_id: null });
    } else if (src.origin === "live" && src.status === "received" && (orderId || processed)) {
      rows.push({ action: "upgrade", shopify_order_id: oid,
                  legacy_reason: orderId ? "persisted_before_cutover" : "event_processed_unmapped",
                  order_id: orderId, first_webhook_event_id: null, legacy_bill_evidence: bill,
                  source_id: String(src.id) });
    }
  }
  const counts = rows.reduce((m, r) => { const k = `${r.action}:${r.legacy_reason}`; m[k] = (m[k] || 0) + 1; return m; }, {});
  const body = JSON.stringify({ shop, rows });
  return { shop, rows, counts, unusable_event_ids: unusable,
           plan_sha256: crypto.createHash("sha256").update(body, "utf8").digest("hex") };
}

async function markerOf(q) {
  const r = (await q.query(`SELECT value FROM app_settings WHERE key = $1`, [KEYS.backfill])).rows[0];
  return r ? JSON.parse(r.value) : null;
}

async function verify(c, shop) {
  const problems = [];
  const a = (await c.query(
    `SELECT o.shopify_order_id FROM orders o
      WHERE o.shopify_order_id ~ '^[0-9]+$'
        AND NOT EXISTS (SELECT 1 FROM shopify_order_sources s WHERE s.shopify_order_id = o.shopify_order_id)
      LIMIT 5`)).rows;
  if (a.length) problems.push(`orders without a source: ${a.map((r) => r.shopify_order_id).join(", ")}`);
  const b = (await c.query(
    `SELECT DISTINCT we.payload->>'id' AS oid FROM webhook_events we
      WHERE we.source = 'shopify' AND we.topic = 'orders/create' AND we.status <> 'ignored'
        AND (we.payload->>'id') ~ '^[0-9]+$'
        AND NOT EXISTS (SELECT 1 FROM shopify_order_sources s WHERE s.shopify_order_id = we.payload->>'id')
      LIMIT 5`)).rows;
  if (b.length) problems.push(`orders/create events without a source: ${b.map((r) => r.oid).join(", ")}`);
  const d = (await c.query(
    `SELECT s.id FROM shopify_order_sources s
      WHERE s.origin = 'live' AND s.status IN ('received','retryable_error')
        AND (EXISTS (SELECT 1 FROM orders o WHERE o.shopify_order_id = s.shopify_order_id)
             OR EXISTS (SELECT 1 FROM webhook_events we
                         WHERE we.source = 'shopify' AND we.topic = 'orders/create' AND we.status = 'processed'
                           AND we.payload->>'id' = s.shopify_order_id
                           AND NOT EXISTS (SELECT 1 FROM shopify_order_sources x WHERE x.first_webhook_event_id = we.id)))
      LIMIT 5`)).rows;
  if (d.length) problems.push(`live sources that old code already handled: ${d.map((r) => r.id).join(", ")}`);
  return problems;
}

async function apply(db, { shop, by, reason, planSha }) {
  if (!by || !String(by).trim() || !reason || !String(reason).trim()) throw new Error("apply needs --by and --reason");
  if (!planSha) throw new Error("apply needs --plan-sha (from the approved dry run)");
  return db.tx(async (c) => {
    await c.query(`SET LOCAL lock_timeout = '10s'`);
    await c.query(`SET LOCAL statement_timeout = '120s'`);
    await c.query(`SELECT pg_advisory_xact_lock($1)`, [LOCK_KEY]);
    if (await markerOf(c)) throw new Error("backfill already completed (marker present) - refusing to run again");

    const p = await plan(c, { shop });
    if (p.plan_sha256 !== planSha) {
      throw new Error(`plan changed since it was approved (approved ${planSha}, now ${p.plan_sha256}) - run the dry run again`);
    }
    const run = (await c.query(
      `INSERT INTO shopify_order_source_audit (action, actor, reason, detail)
       VALUES ('backfill_run', $1, $2, $3) RETURNING id`,
      [by, reason, { plan_sha256: p.plan_sha256, counts: p.counts, shop }])).rows[0].id;

    for (const r of p.rows) {
      if (r.action === "insert") {
        const id = (await c.query(
          `INSERT INTO shopify_order_sources
             (origin, shop, shopify_order_id, first_webhook_event_id, status, legacy_reason, order_id,
              bill_state, legacy_bill_evidence)
           VALUES ('backfill', $1, $2, $3, 'legacy', $4, $5, 'legacy', $6)
           RETURNING id`,
          [shop, r.shopify_order_id, r.first_webhook_event_id, r.legacy_reason, r.order_id, r.legacy_bill_evidence])).rows[0].id;
        await c.query(
          `INSERT INTO shopify_order_source_audit (source_id, action, to_status, to_bill_state, actor, reason, detail)
           VALUES ($1, 'backfill_row', 'legacy', 'legacy', $2, $3, $4)`,
          [id, by, reason, { run, legacy_reason: r.legacy_reason }]);
      } else {
        const u = await c.query(
          `UPDATE shopify_order_sources
              SET status = 'legacy', legacy_reason = $2, order_id = $3, bill_state = 'legacy', legacy_bill_evidence = $4
            WHERE id = $1 AND origin = 'live' AND status = 'received'`,
          [r.source_id, r.legacy_reason, r.order_id, r.legacy_bill_evidence]);
        if (u.rowCount !== 1) throw new Error(`source ${r.source_id} changed during the backfill`);
        await c.query(
          `UPDATE webhook_events SET status = 'ignored', processed_at = now(),
                  error_detail = 'old code already handled this Shopify order (017 backfill)'
            WHERE id = (SELECT first_webhook_event_id FROM shopify_order_sources WHERE id = $1)`, [r.source_id]);
        await c.query(
          `INSERT INTO shopify_order_source_audit (source_id, action, from_status, to_status, from_bill_state, to_bill_state,
                                                   actor, reason, detail)
           VALUES ($1, 'backfill_upgrade', 'received', 'legacy', 'not_ready', 'legacy', $2, $3, $4)`,
          [r.source_id, by, reason, { run, legacy_reason: r.legacy_reason }]);
      }
    }

    const problems = await verify(c, shop);
    if (problems.length) throw new Error(`backfill verification failed: ${problems.join("; ")}`);

    const marker = { by, reason, at: new Date().toISOString(), plan_sha256: p.plan_sha256, counts: p.counts, shop, run };
    const m = await c.query(
      `INSERT INTO app_settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING`,
      [KEYS.backfill, JSON.stringify(marker)]);
    if (m.rowCount !== 1) throw new Error("readiness marker appeared concurrently - refusing");
    return { applied: p.rows.length, counts: p.counts, plan_sha256: p.plan_sha256, marker };
  });
}

module.exports = { plan, apply, verify, markerOf, LOCK_KEY };
