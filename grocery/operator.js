// ============================================================================
// ASB PIPELINE — grocery/operator.js
//
// Every manual action on a grocery source. Each one: --by and --reason
// required, one transaction, the row locked, rows that are 'processing' or
// 'sending' refused, ONE update that writes status and bill_state together,
// and an audit row. Alerts (if any) are delivered after commit.
// ============================================================================

"use strict";

const outbound = require("./outbound");
const receipts = require("./receipts");
const { composeSnapshot, insertSnapshot } = require("./apply");
const { parseOrderJson } = require("./orderjson");

function need(by, reason) {
  if (!by || !String(by).trim() || !reason || !String(reason).trim()) throw new Error("needs --by and --reason");
}

async function audit(c, s, { action, toStatus, toBill, by, reason, detail }) {
  return (await c.query(
    `INSERT INTO shopify_order_source_audit
       (source_id, action, from_status, to_status, from_bill_state, to_bill_state, actor, reason, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [s.id, action, s.status, toStatus ?? s.status, s.bill_state, toBill ?? s.bill_state, by, reason, detail || null])).rows[0].id;
}

async function locked(c, sourceId) {
  const s = (await c.query(`SELECT * FROM shopify_order_sources WHERE id = $1 FOR NO KEY UPDATE`, [sourceId])).rows[0];
  if (!s) throw new Error(`source ${sourceId} not found`);
  if (s.status === "processing" || s.bill_state === "sending") throw new Error(`source ${sourceId} is in flight - try again shortly`);
  return s;
}

function action(fn) {
  return async (db, args) => {
    need(args.by, args.reason);
    return db.tx((c) => fn(c, args));
  };
}

const requeue = action(async (c, { sourceId, by, reason }) => {
  const s = await locked(c, sourceId);
  if (s.status !== "review") throw new Error(`requeue needs status review (is ${s.status})`);
  await audit(c, s, { action: "requeue", toStatus: "received", by, reason });
  await c.query(
    `UPDATE shopify_order_sources SET status = 'received', review_reason = NULL, attempt_budget_base = attempts,
            next_attempt_at = now() WHERE id = $1`, [s.id]);
  await c.query(`UPDATE webhook_events SET status = 'received', error_detail = $2 WHERE id = $1`,
                [s.first_webhook_event_id, `requeued by ${by}: ${reason}`]);
  return { status: "received" };
});

const dismiss = action(async (c, { sourceId, linkOrderId = null, by, reason }) => {
  const s = await locked(c, sourceId);
  if (s.status !== "review") throw new Error(`dismiss needs status review (is ${s.status})`);
  await audit(c, s, { action: linkOrderId ? "link_order" : "dismiss", toStatus: "dismissed", toBill: "not_required",
                      by, reason, detail: linkOrderId ? { order_id: linkOrderId } : null });
  await c.query(
    `UPDATE shopify_order_sources SET status = 'dismissed', review_reason = NULL, bill_state = 'not_required',
            order_id = COALESCE(order_id, $2), disposition = CASE WHEN $2::bigint IS NULL THEN disposition ELSE 'manual_link' END
      WHERE id = $1`, [s.id, linkOrderId]);
  await c.query(`UPDATE webhook_events SET error_detail = $2 WHERE id = $1`,
                [s.first_webhook_event_id, `dismissed by ${by}: ${reason}`]);
  return { status: "dismissed" };
});

const reopenLegacy = action(async (c, { sourceId, withBill = false, by, reason }) => {
  const s = await locked(c, sourceId);
  if (s.status !== "legacy" || !["event_failed", "event_unfinished"].includes(s.legacy_reason)) {
    throw new Error(`only legacy event_failed / event_unfinished rows can be reopened (is ${s.status}/${s.legacy_reason})`);
  }
  const bill = withBill ? "not_ready" : "not_required";
  await audit(c, s, { action: "reopen_legacy", toStatus: "received", toBill: bill, by, reason });
  await c.query(`UPDATE shopify_order_sources SET status = 'received', bill_state = $2, next_attempt_at = now() WHERE id = $1`,
                [s.id, bill]);
  await c.query(`UPDATE webhook_events SET status = 'received', error_detail = $2 WHERE id = $1`,
                [s.first_webhook_event_id, `reopened by ${by}: ${reason}`]);
  return { status: "received", bill };
});

const anomalyAck = async (db, { duplicateId, by, reason }) => {
  need(by, reason);
  return db.tx(async (c) => {
    const d = (await c.query(`SELECT * FROM shopify_order_source_duplicates WHERE id = $1 FOR UPDATE`, [duplicateId])).rows[0];
    if (!d) throw new Error(`duplicate ${duplicateId} not found`);
    if (d.acknowledged_at) return { already: true };
    const s = (await c.query(`SELECT * FROM shopify_order_sources WHERE id = $1`, [d.source_id])).rows[0];
    await audit(c, s, { action: "anomaly_ack", by, reason, detail: { duplicate_id: d.id } });
    await c.query(`UPDATE shopify_order_source_duplicates SET acknowledged_by = $2, acknowledged_at = now() WHERE id = $1`,
                  [d.id, by]);
    return { acknowledged: d.id };
  });
};

// Resend: failed/unknown -> pending, with the authorizing audit row persisted
// on the source (bill_authorization_audit_id) for the claim to record.
const billResend = action(async (c, { sourceId, by, reason }) => {
  const s = await locked(c, sourceId);
  if (!["failed", "unknown"].includes(s.bill_state)) throw new Error(`resend needs bill failed/unknown (is ${s.bill_state})`);
  const snap = (await c.query(`SELECT 1 FROM shopify_order_bill_snapshots WHERE source_id = $1`, [s.id])).rows.length;
  if (!snap) throw new Error("no bill snapshot - use bill-compose first");
  const id = await audit(c, s, { action: "bill_resend", toBill: "pending", by, reason });
  await c.query(
    `UPDATE shopify_order_sources SET bill_state = 'pending', bill_authorization_audit_id = $2,
            bill_attempt_budget_base = bill_attempts, bill_next_attempt_at = now() WHERE id = $1`, [s.id, id]);
  return { bill: "pending", authorization_audit_id: id };
});

const billCompose = action(async (c, { sourceId, by, reason }) => {
  const s = await locked(c, sourceId);
  if (s.bill_state !== "failed" || s.bill_outcome !== "compose_error") throw new Error("compose is only for a compose_error bill");
  if ((await c.query(`SELECT 1 FROM shopify_order_bill_snapshots WHERE source_id = $1`, [s.id])).rows.length) {
    throw new Error("a snapshot already exists");
  }
  const raw = s.payload_raw ?? (await c.query(`SELECT payload::text AS t FROM webhook_events WHERE id = $1`,
                                                [s.first_webhook_event_id])).rows[0]?.t;
  const order = parseOrderJson(raw);
  const phone = (await c.query(`SELECT phone FROM customers WHERE id = $1`, [s.customer_id])).rows[0].phone;
  const snap = await composeSnapshot(c, { src: s, orderId: s.order_id, order, phone });
  snap.scope = "operator_compose";
  snap.composed_by = by;
  const id = await audit(c, s, { action: "bill_compose", toBill: "pending", by, reason });
  await insertSnapshot(c, snap);
  await c.query(
    `UPDATE shopify_order_sources SET bill_state = 'pending', bill_authorization_audit_id = $2,
            bill_attempt_budget_base = bill_attempts, bill_next_attempt_at = now() WHERE id = $1`, [s.id, id]);
  return { bill: "pending", authorization_audit_id: id };
});

// Lock order everywhere: attempt, then source (as finalize / receipts do).
async function lockAttemptThenSource(c, sourceId) {
  const cur = (await c.query(`SELECT bill_current_attempt_id FROM shopify_order_sources WHERE id = $1`, [sourceId])).rows[0];
  if (!cur) throw new Error(`source ${sourceId} not found`);
  const a = cur.bill_current_attempt_id
    ? (await c.query(`SELECT * FROM shopify_order_bill_attempts WHERE id = $1 FOR UPDATE`, [cur.bill_current_attempt_id])).rows[0]
    : null;
  const s = await locked(c, sourceId);
  if (String(s.bill_current_attempt_id) !== String(cur.bill_current_attempt_id)) throw new Error("the bill moved on - try again");
  return { s, a };
}

const billConfirmSent = action(async (c, { sourceId, by, reason }) => {
  const { s, a } = await lockAttemptThenSource(c, sourceId);
  if (s.bill_state !== "unknown") throw new Error(`confirm-sent needs bill unknown (is ${s.bill_state})`);
  await audit(c, s, { action: "bill_confirm_sent", toBill: "sent", by, reason, detail: { attempt: a?.attempt_no } });
  if (a && !a.proof) await c.query(`UPDATE shopify_order_bill_attempts SET proof = 'operator' WHERE id = $1`, [a.id]);
  if (a) await outbound.markSentInTx(c, { key: a.message_key, wamid: a.wamid || null });
  await c.query(
    `UPDATE shopify_order_sources SET bill_state = 'sent', bill_proof = 'operator', bill_outcome = 'operator',
            bill_done_at = now() WHERE id = $1`, [s.id]);
  return { bill: "sent" };
});

const billAbandon = action(async (c, { sourceId, by, reason }) => {
  const s = await locked(c, sourceId);
  if (!["failed", "unknown"].includes(s.bill_state)) throw new Error(`abandon needs bill failed/unknown (is ${s.bill_state})`);
  await audit(c, s, { action: "bill_abandon", toBill: "abandoned", by, reason });
  await c.query(`UPDATE shopify_order_sources SET bill_state = 'abandoned' WHERE id = $1`, [s.id]);
  return { bill: "abandoned" };
});

const billHold = action(async (c, { sourceId, by, reason }) => {
  const s = await locked(c, sourceId);
  if (s.bill_hold_reason) return { already: true };
  await audit(c, s, { action: "bill_hold", by, reason });
  await c.query(`UPDATE shopify_order_sources SET bill_hold_reason = $2, bill_hold_by = $3, bill_hold_at = now() WHERE id = $1`,
                [s.id, reason, by]);
  return { held: true };
});

const billRelease = action(async (c, { sourceId, by, reason }) => {
  const s = await locked(c, sourceId);
  if (!s.bill_hold_reason) return { already: true };
  await audit(c, s, { action: "bill_release", by, reason, detail: { was: s.bill_hold_reason } });
  await c.query(`UPDATE shopify_order_sources SET bill_hold_reason = NULL, bill_hold_by = NULL, bill_hold_at = NULL WHERE id = $1`,
                [s.id]);
  return { held: false };
});

// Link a journalled proof receipt to ONE specific attempt whose outcome was
// never known (ambiguous / claim_expired). Never automatic. The source's bill
// becomes 'sent' only if it is still unknown/failed; if a later resend already
// made it 'sent', the proof is recorded on the earlier attempt (the customer
// received both) and the bill state is left as it is.
const linkReceipt = async (db, { attemptId, wamid, by, reason }) => {
  need(by, reason);
  if (!attemptId) throw new Error("link-receipt needs --attempt <attempt id>");
  if (!wamid) throw new Error("link-receipt needs --wamid");
  const r = await db.tx(async (c) => {
    const a = (await c.query(`SELECT * FROM shopify_order_bill_attempts WHERE id = $1 FOR UPDATE`, [attemptId])).rows[0];
    if (!a) throw new Error(`attempt ${attemptId} not found`);
    if (!["ambiguous", "claim_expired"].includes(a.outcome) || a.wamid) {
      throw new Error(`attempt ${attemptId} cannot take a receipt (outcome ${a.outcome}, wamid ${a.wamid || "none"})`);
    }
    const s = await locked(c, a.source_id);
    const snap = (await c.query(`SELECT phone FROM shopify_order_bill_snapshots WHERE source_id = $1`, [s.id])).rows[0];
    const j = (await c.query(
      `SELECT * FROM whatsapp_receipt_backlog WHERE wamid = $1 AND status IN ('sent','delivered','read') ORDER BY received_at LIMIT 1`,
      [wamid])).rows[0];
    if (!j) throw new Error(`no proof receipt journalled for ${wamid}`);
    if (j.recipient_id && j.recipient_id !== snap.phone) throw new Error(`receipt is for ${j.recipient_id}, the bill went to ${snap.phone}`);
    if ((await c.query(`SELECT 1 FROM whatsapp_messages WHERE wamid = $1`, [wamid])).rows.length) {
      throw new Error(`${wamid} already belongs to another logged message`);
    }
    const toSent = ["unknown", "failed"].includes(s.bill_state);
    await audit(c, s, { action: "link_receipt", toBill: toSent ? "sent" : s.bill_state, by, reason,
                        detail: { wamid, attempt_id: a.id, attempt_no: a.attempt_no,
                                  ...(s.bill_state === "sent" ? { note: "bill was already sent by a later attempt - customer received both" } : {}) } });
    await c.query(`UPDATE shopify_order_bill_attempts SET wamid = $2, proof = 'receipt' WHERE id = $1`, [a.id, wamid]);
    await outbound.markSentInTx(c, { key: a.message_key, wamid });
    if (toSent) {
      await c.query(
        `UPDATE shopify_order_sources SET bill_state = 'sent', bill_proof = 'receipt', bill_outcome = 'receipt',
                bill_done_at = now() WHERE id = $1`, [s.id]);
    }
    return { attempt: a.id, bill: toSent ? "sent" : s.bill_state };
  });
  await receipts.replay(db, { wamid });
  return r;
};

/** What needs a person. */
async function attentionRows(q, { limit = 100 } = {}) {
  const n = Math.max(1, Math.min(1000, parseInt(limit, 10) || 100));
  return (await q.query(
    `SELECT s.id, s.shopify_order_id, s.shopify_order_name AS name, s.status, s.review_reason, s.legacy_reason,
            s.bill_state, s.bill_outcome, s.bill_hold_reason, s.attempts, s.bill_attempts, s.last_error, s.order_id,
            (SELECT count(*)::int FROM shopify_order_source_duplicates d
              WHERE d.source_id = s.id AND d.fingerprint_differs AND d.acknowledged_at IS NULL) AS open_anomalies,
            s.updated_at
       FROM shopify_order_sources s
      WHERE s.status IN ('review','retryable_error')
         OR (s.status = 'legacy' AND s.legacy_reason IN ('event_failed','event_unfinished'))
         OR s.bill_state IN ('failed','unknown')
         OR s.bill_hold_reason IS NOT NULL
         OR EXISTS (SELECT 1 FROM shopify_order_source_duplicates d
                     WHERE d.source_id = s.id AND d.fingerprint_differs AND d.acknowledged_at IS NULL)
      ORDER BY s.id LIMIT $1`, [n])).rows;
}

module.exports = { requeue, dismiss, reopenLegacy, anomalyAck, billResend, billCompose, billConfirmSent,
                   billAbandon, billHold, billRelease, linkReceipt, attentionRows };
