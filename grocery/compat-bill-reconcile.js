// ============================================================================
// ASB PIPELINE — grocery/compat-bill-reconcile.js
//
// Reconcile bills for orders successfully persisted by rollback-compat-017.
//
// Conservative evidence rules:
//   already_sent  old log status sent/delivered/read -> never send again
//   recover_bill  positive proof that L3 did NOT send:
//                 * Meta returned an error response and there is no wamid, or
//                 * L3 explicitly failed before send because no DB-composed bill existed
//   review        anything ambiguous (network failure, missing log after crash,
//                 a failed delivery that already has a wamid, etc.)
//
// plan() is read-only + deterministic. apply() recomputes the plan under an
// advisory lock, requires the exact approved hash, and never writes review rows.
// ============================================================================

"use strict";

const crypto = require("crypto");
const { composeSnapshot, insertSnapshot } = require("./apply");
const { parseOrderJson } = require("./orderjson");
const { windowOf } = require("./rollback-reconcile");

const LOCK_KEY = 17017019;

function stable(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  return "{" + Object.keys(value).sort().map((k) => JSON.stringify(k) + ":" + stable(value[k])).join(",") + "}";
}
const sha256 = (s) => crypto.createHash("sha256").update(s, "utf8").digest("hex");

function classify(r) {
  const status = r.message_status || null;
  const wamid = r.wamid || null;
  const metaCode = r.meta_error_code || null;

  if (!r.order_id || !r.customer_id || !r.cycle_id || !["created","merged"].includes(r.disposition)) {
    return { action: "review", reason: "compat_source_missing_required_links" };
  }
  if (r.legacy_bill_evidence === true) return null;

  if (["sent","delivered","read"].includes(status)) {
    return { action: "record_sent_evidence", reason: "pre017_log_confirms_sent" };
  }

  if (status === "failed" && !wamid && metaCode) {
    return { action: "recover_bill", reason: "meta_error_response_proves_not_accepted" };
  }

  if (!status && r.event_status === "failed"
      && String(r.error_detail || "").startsWith("rollback-compat-017: no database-composed bill available")) {
    return { action: "recover_bill", reason: "l3_failed_before_send" };
  }

  if (status === "failed" && wamid) {
    return { action: "review", reason: "failed_delivery_has_wamid" };
  }
  if (status === "failed") {
    return { action: "review", reason: "failed_send_without_definite_non_send_evidence" };
  }
  if (!status) {
    return { action: "review", reason: "no_outbound_log_is_ambiguous" };
  }
  return { action: "review", reason: `unexpected_pre017_log_status_${status}` };
}

async function plan(q, { shop, from, to }) {
  if (!shop || !String(shop).trim()) throw new Error("compat bill reconcile needs --shop");
  const win = windowOf(from, to);
  const rows = (await q.query(
    `SELECT s.id AS source_id, s.shopify_order_id, s.shopify_order_name, s.order_id, s.customer_id, s.cycle_id,
            s.disposition, s.legacy_bill_evidence,
            we.id AS webhook_event_id, we.status AS event_status, we.error_detail,
            m.id AS message_id, m.status::text AS message_status, m.wamid,
            m.payload #>> '{response,error,code}' AS meta_error_code
       FROM shopify_order_sources s
       JOIN webhook_events we ON we.id = s.first_webhook_event_id
       LEFT JOIN whatsapp_messages m
         ON m.idempotency_key = 'order_confirmed:shopify:' || s.shopify_order_id
      WHERE s.origin = 'compat'
        AND s.legacy_reason = 'compat_inline'
        AND s.status = 'legacy'
        AND s.bill_state = 'legacy'
        AND s.shop = $1
        AND we.received_at >= $2::timestamptz
        AND we.received_at < $3::timestamptz
      ORDER BY s.id`,
    [shop, win.from, win.to]
  )).rows;

  const out = [];
  for (const r of rows) {
    const c = classify(r);
    if (!c) continue;
    out.push({
      source_id: String(r.source_id),
      shopify_order_id: r.shopify_order_id,
      webhook_event_id: String(r.webhook_event_id),
      order_id: r.order_id === null ? null : String(r.order_id),
      customer_id: r.customer_id === null ? null : String(r.customer_id),
      cycle_id: r.cycle_id === null ? null : String(r.cycle_id),
      disposition: r.disposition,
      event_status: r.event_status,
      message_id: r.message_id === null ? null : String(r.message_id),
      message_status: r.message_status,
      wamid: r.wamid,
      meta_error_code: r.meta_error_code,
      ...c,
    });
  }
  const counts = {};
  for (const r of out) counts[r.action] = (counts[r.action] || 0) + 1;
  const orderedCounts = Object.fromEntries(Object.entries(counts).sort(([a],[b]) => a.localeCompare(b)));
  const body = stable({ version: 1, shop, ...win, rows: out });
  return { shop, ...win, rows: out, counts: orderedCounts, plan_sha256: sha256(body) };
}

async function lockedSource(c, row) {
  const s = (await c.query(
    `SELECT * FROM shopify_order_sources WHERE id = $1 FOR NO KEY UPDATE`, [row.source_id]
  )).rows[0];
  if (!s) throw new Error(`source ${row.source_id} disappeared`);
  if (s.origin !== "compat" || s.status !== "legacy" || s.bill_state !== "legacy"
      || s.legacy_reason !== "compat_inline" || s.shopify_order_id !== row.shopify_order_id) {
    throw new Error(`source ${row.source_id} changed during compat bill recovery`);
  }
  return s;
}

async function lockMessage(c, row) {
  if (!row.message_id) return null;
  const m = (await c.query(
    `SELECT id, status::text AS status, wamid, payload #>> '{response,error,code}' AS meta_error_code
       FROM whatsapp_messages WHERE id = $1 FOR UPDATE`, [row.message_id]
  )).rows[0];
  if (!m || m.status !== row.message_status || (m.wamid || null) !== (row.wamid || null)
      || (m.meta_error_code || null) !== (row.meta_error_code || null)) {
    throw new Error(`message evidence for source ${row.source_id} changed during compat bill recovery`);
  }
  return m;
}

async function recoverOne(c, row, s, { by, reason, run, planSha }) {
  await lockMessage(c, row);
  const event = (await c.query(
    `SELECT id, status, error_detail, payload::text AS raw
       FROM webhook_events WHERE id = $1 FOR UPDATE`, [row.webhook_event_id]
  )).rows[0];
  if (!event || event.status !== row.event_status) {
    throw new Error(`webhook event ${row.webhook_event_id} changed during compat bill recovery`);
  }

  const customer = (await c.query(`SELECT phone FROM customers WHERE id = $1`, [s.customer_id])).rows[0];
  if (!customer?.phone) throw new Error(`source ${s.id}: linked customer has no phone`);
  const order = parseOrderJson(event.raw);
  const snap = await composeSnapshot(c, { src: s, orderId: s.order_id, order, phone: customer.phone });
  snap.scope = "operator_compose";
  snap.composed_by = by;

  const auditId = (await c.query(
    `INSERT INTO shopify_order_source_audit
       (source_id, action, from_status, to_status, from_bill_state, to_bill_state, actor, reason, detail)
     VALUES ($1,'bill_compose','legacy','applied','legacy','pending',$2,$3,$4)
     RETURNING id`,
    [s.id, by, reason, {
      mode: "compat_bill_recovery", run, plan_sha256: planSha,
      evidence: row.reason, webhook_event_id: row.webhook_event_id,
      message_id: row.message_id, meta_error_code: row.meta_error_code,
    }]
  )).rows[0].id;

  await insertSnapshot(c, snap);
  const u = await c.query(
    `UPDATE shopify_order_sources
        SET status = 'applied', applied_at = now(), bill_state = 'pending',
            bill_next_attempt_at = now(), bill_authorization_audit_id = $2
      WHERE id = $1 AND status = 'legacy' AND bill_state = 'legacy'`,
    [s.id, auditId]
  );
  if (u.rowCount !== 1) throw new Error(`source ${s.id} moved during compat bill recovery`);

  await c.query(
    `UPDATE webhook_events
        SET status = 'processed', processed_at = COALESCE(processed_at, now()),
            error_detail = $2
      WHERE id = $1`,
    [event.id, `compat bill recovery queued by ${by}: ${reason}`]
  );
  return auditId;
}

async function recordSent(c, row, s, { by, reason, run, planSha }) {
  const m = await lockMessage(c, row);
  if (!m || !["sent","delivered","read"].includes(m.status)) {
    throw new Error(`source ${s.id}: sent evidence changed`);
  }
  await c.query(
    `UPDATE shopify_order_sources
        SET legacy_bill_evidence = true
      WHERE id = $1 AND legacy_bill_evidence IS NULL`, [s.id]
  );
  await c.query(
    `INSERT INTO shopify_order_source_audit
       (source_id, action, from_status, to_status, from_bill_state, to_bill_state, actor, reason, detail)
     VALUES ($1,'backfill_row','legacy','legacy','legacy','legacy',$2,$3,$4)`,
    [s.id, by, reason, {
      mode: "compat_bill_recovery", run, plan_sha256: planSha,
      reconciliation_action: "record_sent_evidence", message_id: row.message_id, message_status: row.message_status,
    }]
  );
}

async function apply(db, { shop, from, to, by, reason, planSha }) {
  if (!by || !String(by).trim() || !reason || !String(reason).trim()) {
    throw new Error("compat bill apply needs --by and --reason");
  }
  if (!planSha) throw new Error("compat bill apply needs --plan-sha from the approved dry run");

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
       VALUES ('backfill_run',$1,$2,$3) RETURNING id`,
      [by, reason, { mode: "compat_bill_recovery", shop, from: p.from, to: p.to,
                     plan_sha256: p.plan_sha256, counts: p.counts }]
    )).rows[0].id;

    let recovered = 0, recordedSent = 0;
    for (const row of p.rows) {
      if (row.action === "review") continue;
      const s = await lockedSource(c, row);
      if (row.action === "recover_bill") {
        await recoverOne(c, row, s, { by, reason, run, planSha: p.plan_sha256 });
        recovered++;
      } else if (row.action === "record_sent_evidence") {
        await recordSent(c, row, s, { by, reason, run, planSha: p.plan_sha256 });
        recordedSent++;
      }
    }

    return {
      recovered, recorded_sent: recordedSent, review_only: p.counts.review || 0,
      counts: p.counts, plan_sha256: p.plan_sha256, run,
    };
  });
}

module.exports = { plan, apply, classify, LOCK_KEY };
