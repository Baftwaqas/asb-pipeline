// ============================================================================
// ASB PIPELINE — grocery/rollback-reconcile.js
//
// Recovery for orders/create webhooks ACKed during an emergency L3 rollback
// window but left without a shopify_order_sources row.
//
// This is deliberately NOT another global backfill. The original 017 backfill
// marker must already exist. An operator supplies an explicit [from,to) window;
// plan() is read-only and deterministic; apply() recomputes the exact plan under
// an advisory lock and refuses unless its SHA-256 matches the approved dry run.
//
// Safe classifications:
//   replay             failed/unfinished event, no source/order/bill evidence
//   link_existing      an order row already exists: map it, never replay
//   map_community_only processed event whose every line is already in durable
//                      Community intake: map it, never create a grocery order
//   review             contradictory/ambiguous evidence: write nothing
//
// Existing 017 audit action names are reused with detail.mode set to
// "rollback_window_reconcile", so no additional production schema migration is
// required merely to obtain an append-only operator audit trail.
// ============================================================================

"use strict";

const crypto = require("crypto");
const backfill = require("./backfill");

const LOCK_KEY = 17017018;
const MAX_WINDOW_MS = 72 * 60 * 60 * 1000;

const cmpId = (a, b) => {
  const d = BigInt(a) - BigInt(b);
  return d < 0n ? -1 : d > 0n ? 1 : 0;
};

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + stable(value[k])).join(",") + "}";
}

const sha256 = (value) => crypto.createHash("sha256").update(value, "utf8").digest("hex");

function windowOf(from, to) {
  const a = new Date(from);
  const b = new Date(to);
  if (!from || Number.isNaN(a.getTime())) throw new Error("reconcile needs a valid --from timestamp");
  if (!to || Number.isNaN(b.getTime())) throw new Error("reconcile needs a valid --to timestamp");
  if (b <= a) throw new Error("reconcile --to must be after --from");
  if (b.getTime() - a.getTime() > MAX_WINDOW_MS) {
    throw new Error("reconcile window is wider than 72 hours - split it into smaller reviewed windows");
  }
  if (b.getTime() > Date.now() + 5000) throw new Error("reconcile --to cannot be in the future");
  return { from: a.toISOString(), to: b.toISOString() };
}

function countBy(rows) {
  const m = {};
  for (const r of rows) m[r.action] = (m[r.action] || 0) + 1;
  return Object.fromEntries(Object.entries(m).sort(([a], [b]) => a.localeCompare(b)));
}

async function plan(q, { shop, from, to }) {
  if (!shop || !String(shop).trim()) throw new Error("reconcile needs --shop (or SHOPIFY_SHOP_DOMAIN)");
  const win = windowOf(from, to);
  const marker = await backfill.markerOf(q);
  if (!marker) {
    throw new Error("017 backfill marker is missing - use the initial 017 backfill, not rollback-window reconciliation");
  }

  const events = (await q.query(
    `SELECT id, event_id, status, received_at, processed_at, error_detail, payload, payload->>'id' AS oid
       FROM webhook_events
      WHERE source = 'shopify' AND topic = 'orders/create'
        AND received_at >= $1::timestamptz AND received_at < $2::timestamptz
      ORDER BY id`,
    [win.from, win.to]
  )).rows;

  const unusable_event_ids = events
    .filter((e) => !/^[0-9]+$/.test(e.oid || ""))
    .map((e) => String(e.id));

  const usable = events.filter((e) => /^[0-9]+$/.test(e.oid || ""));
  const oids = [...new Set(usable.map((e) => e.oid))].sort(cmpId);
  if (!oids.length) {
    const rows = [];
    const body = stable({ version: 1, shop, ...win, marker_plan_sha256: marker.plan_sha256 || null, rows });
    return { shop, ...win, marker_plan_sha256: marker.plan_sha256 || null, rows, counts: {},
             unusable_event_ids, plan_sha256: sha256(body) };
  }

  const [sourcesQ, ordersQ, evidenceQ, communityQ] = await Promise.all([
    q.query(`SELECT shopify_order_id FROM shopify_order_sources WHERE shopify_order_id = ANY($1::text[])`, [oids]),
    q.query(`SELECT id, customer_id, cycle_id, shopify_order_id FROM orders WHERE shopify_order_id = ANY($1::text[])`, [oids]),
    q.query(
      `SELECT substring(idempotency_key FROM '^order_confirmed:shopify:([0-9]+)$') AS oid
         FROM whatsapp_messages
        WHERE idempotency_key ~ '^order_confirmed:shopify:[0-9]+$'
          AND status::text IN ('sent','delivered','read')
          AND substring(idempotency_key FROM '^order_confirmed:shopify:([0-9]+)$') = ANY($1::text[])`,
      [oids]
    ),
    q.query(
      `SELECT shopify_order_id, count(DISTINCT shopify_line_item_id)::int AS n
         FROM community_intake
        WHERE shopify_order_id = ANY($1::text[])
        GROUP BY shopify_order_id`,
      [oids]
    ),
  ]);

  const sourced = new Set(sourcesQ.rows.map((r) => r.shopify_order_id));
  const orderBy = new Map(ordersQ.rows.map((r) => [r.shopify_order_id, r]));
  const billed = new Set(evidenceQ.rows.map((r) => r.oid));
  const communityBy = new Map(communityQ.rows.map((r) => [r.shopify_order_id, Number(r.n)]));

  const groups = new Map();
  for (const e of usable) {
    if (sourced.has(e.oid)) continue;
    if (!groups.has(e.oid)) groups.set(e.oid, []);
    groups.get(e.oid).push(e);
  }

  const rows = [];
  for (const oid of [...groups.keys()].sort(cmpId)) {
    const evs = groups.get(oid).sort((a, b) => Number(a.id) - Number(b.id));
    const decorated = evs.map((e) => ({
      ...e,
      payload_sha256: sha256(stable(e.payload)),
      line_count: Array.isArray(e.payload?.line_items) ? e.payload.line_items.length : 0,
    }));
    const hashes = [...new Set(decorated.map((e) => e.payload_sha256))];
    const first = decorated[0];
    const order = orderBy.get(oid) || null;
    const communityLines = communityBy.get(oid) || 0;
    const eventIds = decorated.map((e) => String(e.id));
    const base = {
      shopify_order_id: oid,
      event_ids: eventIds,
      payload_sha256: first.payload_sha256,
      line_count: first.line_count,
      community_line_count: communityLines,
    };

    if (hashes.length !== 1) {
      rows.push({ ...base, action: "review", reason: "payload_mismatch_within_window",
                  payload_sha256: null, payload_hashes: hashes.sort() });
      continue;
    }

    const selected = decorated.find((e) => e.status === "failed")
      || decorated.find((e) => e.status === "received")
      || decorated.find((e) => e.status === "processed")
      || first;

    if (order) {
      rows.push({ ...base, action: "link_existing", reason: "order_exists_without_source",
                  webhook_event_id: String(selected.id), event_status: selected.status,
                  order_id: String(order.id), customer_id: String(order.customer_id), cycle_id: String(order.cycle_id),
                  legacy_bill_evidence: billed.has(oid) });
      continue;
    }

    if (billed.has(oid)) {
      rows.push({ ...base, action: "review", reason: "bill_evidence_without_source_or_order",
                  webhook_event_id: String(selected.id), event_status: selected.status });
      continue;
    }

    const processed = decorated.find((e) => e.status === "processed");
    if (processed && first.line_count > 0 && communityLines >= first.line_count) {
      rows.push({ ...base, action: "map_community_only", reason: "all_lines_already_in_community_intake",
                  webhook_event_id: String(processed.id), event_status: processed.status });
      continue;
    }

    const recoverable = decorated.find((e) => e.status === "failed")
      || decorated.find((e) => e.status === "received");
    if (recoverable) {
      rows.push({ ...base, action: "replay",
                  reason: recoverable.status === "failed" ? "rollback_event_failed" : "rollback_event_unfinished",
                  legacy_reason: recoverable.status === "failed" ? "event_failed" : "event_unfinished",
                  webhook_event_id: String(recoverable.id), event_status: recoverable.status });
      continue;
    }

    rows.push({ ...base, action: "review", reason: "processed_without_order_or_complete_community_capture",
                webhook_event_id: String(selected.id), event_status: selected.status });
  }

  const counts = countBy(rows);
  const body = stable({
    version: 1, shop, ...win, marker_plan_sha256: marker.plan_sha256 || null, rows,
  });
  return {
    shop, ...win, marker_plan_sha256: marker.plan_sha256 || null,
    rows, counts, unusable_event_ids, plan_sha256: sha256(body),
  };
}

async function lockEvent(c, row) {
  const e = (await c.query(
    `SELECT id, status, payload->>'id' AS oid FROM webhook_events WHERE id = $1 FOR UPDATE`,
    [row.webhook_event_id]
  )).rows[0];
  if (!e) throw new Error(`webhook event ${row.webhook_event_id} disappeared`);
  if (e.oid !== row.shopify_order_id || e.status !== row.event_status) {
    throw new Error(`webhook event ${row.webhook_event_id} changed during reconciliation`);
  }
  return e;
}

async function insertSource(c, sql, params, oid) {
  const r = await c.query(sql, params);
  if (r.rows.length !== 1) {
    throw new Error(`Shopify order ${oid}: a source appeared concurrently - run the dry plan again`);
  }
  return r.rows[0].id;
}

async function auditRow(c, sourceId, action, actor, reason, detail, fromStatus = null, toStatus = null,
                        fromBill = null, toBill = null) {
  return (await c.query(
    `INSERT INTO shopify_order_source_audit
       (source_id, action, from_status, to_status, from_bill_state, to_bill_state, actor, reason, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [sourceId, action, fromStatus, toStatus, fromBill, toBill, actor, reason, detail]
  )).rows[0].id;
}

async function apply(db, { shop, from, to, by, reason, planSha }) {
  if (!by || !String(by).trim() || !reason || !String(reason).trim()) {
    throw new Error("reconcile apply needs --by and --reason");
  }
  if (!planSha) throw new Error("reconcile apply needs --plan-sha from the approved dry run");

  return db.tx(async (c) => {
    await c.query(`SET LOCAL lock_timeout = '10s'`);
    await c.query(`SET LOCAL statement_timeout = '120s'`);
    await c.query(`SELECT pg_advisory_xact_lock($1)`, [LOCK_KEY]);

    const p = await plan(c, { shop, from, to });
    if (p.plan_sha256 !== planSha) {
      throw new Error(`plan changed since approval (approved ${planSha}, now ${p.plan_sha256}) - run the dry plan again`);
    }

    const run = (await c.query(
      `INSERT INTO shopify_order_source_audit (action, actor, reason, detail)
       VALUES ('backfill_run', $1, $2, $3) RETURNING id`,
      [by, reason, {
        mode: "rollback_window_reconcile", shop, from: p.from, to: p.to,
        plan_sha256: p.plan_sha256, counts: p.counts, marker_plan_sha256: p.marker_plan_sha256,
      }]
    )).rows[0].id;

    let written = 0, queued = 0, linked = 0, communityOnly = 0;
    for (const row of p.rows) {
      if (row.action === "review") continue;
      await lockEvent(c, row);

      if (row.action === "link_existing") {
        const sourceId = await insertSource(c,
          `INSERT INTO shopify_order_sources
             (origin, shop, shopify_order_id, first_webhook_event_id, status, legacy_reason,
              order_id, customer_id, cycle_id, bill_state, legacy_bill_evidence)
           VALUES ('backfill',$1,$2,$3,'legacy','orders_row',$4,$5,$6,'legacy',$7)
           ON CONFLICT DO NOTHING RETURNING id`,
          [shop, row.shopify_order_id, row.webhook_event_id, row.order_id, row.customer_id, row.cycle_id,
           Boolean(row.legacy_bill_evidence)], row.shopify_order_id);
        await auditRow(c, sourceId, "backfill_row", by, reason,
          { mode: "rollback_window_reconcile", run, reconciliation_action: row.action,
            webhook_event_id: row.webhook_event_id, plan_sha256: p.plan_sha256 });
        written++; linked++;
        continue;
      }

      if (row.action === "map_community_only") {
        const sourceId = await insertSource(c,
          `INSERT INTO shopify_order_sources
             (origin, shop, shopify_order_id, first_webhook_event_id, status, legacy_reason, bill_state)
           VALUES ('backfill',$1,$2,$3,'community_only','event_processed_unmapped','not_required')
           ON CONFLICT DO NOTHING RETURNING id`,
          [shop, row.shopify_order_id, row.webhook_event_id], row.shopify_order_id);
        await auditRow(c, sourceId, "backfill_row", by, reason,
          { mode: "rollback_window_reconcile", run, reconciliation_action: row.action,
            webhook_event_id: row.webhook_event_id, plan_sha256: p.plan_sha256 });
        written++; communityOnly++;
        continue;
      }

      if (row.action === "replay") {
        const sourceId = await insertSource(c,
          `INSERT INTO shopify_order_sources
             (origin, shop, shopify_order_id, first_webhook_event_id, status, legacy_reason,
              bill_state, legacy_bill_evidence)
           VALUES ('backfill',$1,$2,$3,'legacy',$4,'legacy',false)
           ON CONFLICT DO NOTHING RETURNING id`,
          [shop, row.shopify_order_id, row.webhook_event_id, row.legacy_reason], row.shopify_order_id);
        await auditRow(c, sourceId, "backfill_row", by, reason,
          { mode: "rollback_window_reconcile", run, reconciliation_action: row.action,
            webhook_event_id: row.webhook_event_id, plan_sha256: p.plan_sha256 });
        await auditRow(c, sourceId, "reopen_legacy", by, reason,
          { mode: "rollback_window_reconcile", run, webhook_event_id: row.webhook_event_id,
            plan_sha256: p.plan_sha256 },
          "legacy", "received", "legacy", "not_ready");
        await c.query(
          `UPDATE shopify_order_sources
              SET status = 'received', bill_state = 'not_ready', next_attempt_at = now()
            WHERE id = $1`, [sourceId]);
        await c.query(
          `UPDATE webhook_events
              SET status = 'received', error_detail = $2
            WHERE id = $1`,
          [row.webhook_event_id, `queued by rollback-window reconciliation: ${by}: ${reason}`]);
        written++; queued++;
      }
    }

    for (const row of p.rows.filter((r) => r.action !== "review")) {
      const s = (await c.query(
        `SELECT status, bill_state, order_id FROM shopify_order_sources WHERE shopify_order_id = $1`,
        [row.shopify_order_id]
      )).rows[0];
      if (!s) throw new Error(`verification failed: ${row.shopify_order_id} has no source`);
      if (row.action === "replay" && !(s.status === "received" && s.bill_state === "not_ready")) {
        throw new Error(`verification failed: replay ${row.shopify_order_id} is ${s.status}/${s.bill_state}`);
      }
      if (row.action === "link_existing" && !(s.status === "legacy" && String(s.order_id) === row.order_id)) {
        throw new Error(`verification failed: link ${row.shopify_order_id} is not mapped to order ${row.order_id}`);
      }
      if (row.action === "map_community_only" && !(s.status === "community_only" && s.bill_state === "not_required")) {
        throw new Error(`verification failed: community-only ${row.shopify_order_id} is ${s.status}/${s.bill_state}`);
      }
    }

    return {
      applied: written, queued, linked, community_only: communityOnly,
      review_only: p.counts.review || 0, counts: p.counts,
      plan_sha256: p.plan_sha256, run,
    };
  });
}

module.exports = { plan, apply, windowOf, LOCK_KEY, MAX_WINDOW_MS };
