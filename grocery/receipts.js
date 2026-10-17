// ============================================================================
// ASB PIPELINE — grocery/receipts.js
//
// WhatsApp delivery receipts (statuses), for EVERY outbound message.
//
//   1. journal()  BEFORE the WhatsApp webhook answers 200: every receipt is
//                 written to whatsapp_receipt_backlog (PK wamid+status, so a
//                 repeat is a no-op). If this fails the webhook answers 503 and
//                 Meta retries - a receipt is never acknowledged unrecorded.
//   2. applyOne() afterwards, and replay() from T4 and every sweep: the
//                 receipt is applied MONOTONICALLY to whatsapp_messages
//                 (queued < sent < failed < delivered < read): 'read' is never
//                 downgraded, a late 'sent' never clears delivered_at. A
//                 receipt whose message row does not exist yet stays unapplied
//                 and is applied when the row appears (no race).
//
// 'sent', 'delivered' and 'read' prove a send. For a grocery bill attempt with
// that wamid, a proof moves the bill unknown/failed -> sent (bill_proof
// 'receipt'). A 'failed' receipt for a bill already sent raises an alert.
// ============================================================================

"use strict";

const alerts = require("./alerts");
const { billMaxAttempts } = require("./config");

const KNOWN = new Set(["sent", "delivered", "read", "failed"]);
const PROOF = new Set(["sent", "delivered", "read"]);

/** Pull every status object out of a WhatsApp webhook body. */
function statusesIn(body) {
  const out = [];
  for (const entry of body?.entry || []) {
    for (const change of entry?.changes || []) {
      for (const s of change?.value?.statuses || []) out.push(s);
    }
  }
  return out;
}

/** BEFORE the 200. One transaction; throws on failure (caller answers 503). */
async function journal(db, statuses) {
  const rows = statuses.filter((s) => s && s.id && KNOWN.has(String(s.status)));
  if (!rows.length) return 0;
  return db.tx(async (c) => {
    let n = 0;
    for (const s of rows) {
      const ts = Number(s.timestamp);
      const r = await c.query(
        `INSERT INTO whatsapp_receipt_backlog (wamid, status, recipient_id, meta_timestamp, errors)
         VALUES ($1, $2, $3, CASE WHEN $4::double precision IS NULL THEN NULL ELSE to_timestamp($4) END, $5)
         ON CONFLICT (wamid, status) DO NOTHING`,
        [String(s.id), String(s.status), s.recipient_id || null, Number.isFinite(ts) ? ts : null,
         s.errors ? JSON.stringify(s.errors) : null]);
      n += r.rowCount;
    }
    return n;
  });
}

/** Apply one journalled receipt. Returns 'applied' | 'unmatched' | 'done'. */
async function applyOne(db, wamid, status) {
  const alertIds = [];
  let retrySource = null;
  const out = await db.tx(async (c) => {
    const j = (await c.query(
      `SELECT * FROM whatsapp_receipt_backlog WHERE wamid = $1 AND status = $2 FOR UPDATE`, [wamid, status])).rows[0];
    if (!j || j.applied_at) return "done";
    const msg = (await c.query(`SELECT id FROM whatsapp_messages WHERE wamid = $1 FOR UPDATE`, [wamid])).rows[0];
    if (!msg) return "unmatched";

    const at = j.meta_timestamp || new Date();
    const errCode = j.errors?.[0]?.code !== undefined ? String(j.errors[0].code) : null;
    await c.query(
      `UPDATE whatsapp_messages
          SET status       = $2::text::msg_status,
              sent_at      = CASE WHEN $2::text IN ('sent','delivered','read') THEN COALESCE(sent_at, $3::timestamptz) ELSE sent_at END,
              delivered_at = CASE WHEN $2::text IN ('delivered','read') THEN COALESCE(delivered_at, $3::timestamptz) ELSE delivered_at END,
              read_at      = CASE WHEN $2::text = 'read' THEN COALESCE(read_at, $3::timestamptz) ELSE read_at END,
              error_code   = CASE WHEN $2::text = 'failed' THEN $4 ELSE error_code END
        WHERE wamid = $1
          AND asb_msg_status_rank(status::text) < asb_msg_status_rank($2::text)`,
      [wamid, status, at, errCode]);

    // Grocery bill proof.
    const a = (await c.query(
      `SELECT id, source_id, proof, channel FROM shopify_order_bill_attempts WHERE wamid = $1 FOR UPDATE`, [wamid])).rows[0];
    if (a) {
      const s = (await c.query(
        `SELECT id, bill_state, bill_current_attempt_id, bill_attempts, bill_attempt_budget_base,
                shopify_order_id, shopify_order_name FROM shopify_order_sources
          WHERE id = $1 FOR NO KEY UPDATE`, [a.source_id])).rows[0];
      if (PROOF.has(status)) {
        if (!a.proof) await c.query(`UPDATE shopify_order_bill_attempts SET proof = 'receipt' WHERE id = $1`, [a.id]);
        if (s.bill_state === "unknown" || s.bill_state === "failed") {
          await c.query(
            `UPDATE shopify_order_sources
                SET bill_state = 'sent', bill_proof = 'receipt', bill_outcome = 'receipt', bill_done_at = now()
              WHERE id = $1`, [s.id]);
        }
      } else if (status === "failed" && errCode === "131047" && a.channel === "text" && s.bill_state === "sent"
                 && String(s.bill_current_attempt_id) === String(a.id)) {
        // The TEXT bill was accepted but never delivered: the 24h window was
        // shut. Nothing reached the customer, so it is retried as a template -
        // only while the automatic budget lasts; otherwise it fails visibly.
        if (s.bill_attempts - s.bill_attempt_budget_base < billMaxAttempts()) {
          await c.query(
            `UPDATE shopify_order_sources SET bill_state = 'pending', bill_outcome = 'window_closed', bill_proof = NULL,
                    bill_next_attempt_at = now() WHERE id = $1`, [s.id]);
          retrySource = s.id;
        } else {
          await c.query(
            `UPDATE shopify_order_sources SET bill_state = 'failed', bill_outcome = 'window_closed', bill_proof = NULL
              WHERE id = $1`, [s.id]);
          alertIds.push(await alerts.insert(c, { sourceId: s.id, kind: "bill_failed",
            detail: { shopify_order_id: s.shopify_order_id, order_name: s.shopify_order_name, wamid,
                      summary: "bill not delivered (131047) and no automatic attempts left" } }));
        }
      } else if (status === "failed" && s.bill_state === "sent") {
        alertIds.push(await alerts.insert(c, { sourceId: s.id, kind: "bill_delivery_failed",
          detail: { shopify_order_id: s.shopify_order_id, order_name: s.shopify_order_name, wamid,
                    error_code: errCode, summary: `WhatsApp could not deliver the bill (${errCode || "?"})` } }));
      }
    }

    await c.query(`UPDATE whatsapp_receipt_backlog SET applied_at = now() WHERE wamid = $1 AND status = $2`, [wamid, status]);
    return "applied";
  });
  if (alertIds.length) await alerts.dispatch(db, alertIds);
  if (retrySource) {
    // Lazy require: billing requires this module.
    setImmediate(() => require("./billing").processBill(db, retrySource).catch(() => {}));
  }
  return out;
}

/** Apply every unapplied receipt whose message row now exists (optionally one wamid). */
async function replay(db, { wamid = null, limit = 200 } = {}) {
  const { rows } = await db.query(
    `SELECT b.wamid, b.status FROM whatsapp_receipt_backlog b
      WHERE b.applied_at IS NULL ${wamid ? "AND b.wamid = $2" : "AND b.received_at > now() - interval '14 days'"}
        AND EXISTS (SELECT 1 FROM whatsapp_messages m WHERE m.wamid = b.wamid)
      ORDER BY b.received_at, asb_msg_status_rank(b.status)
      LIMIT $1`, wamid ? [limit, wamid] : [limit]);
  let applied = 0;
  for (const r of rows) {
    try {
      if ((await applyOne(db, r.wamid, r.status)) === "applied") applied++;
    } catch (e) {
      console.error(`[wa] receipt ${r.wamid}/${r.status} could not be applied:`, e.message);
    }
  }
  return applied;
}

/**
 * Proof receipts (sent/delivered/read) with no message row after a while,
 * from a phone that has a bill attempt whose outcome was never known
 * (ambiguous or claim_expired, no wamid) - WHATEVER the source's bill state
 * is now. A later resend may already have made the bill 'sent'; the receipt
 * can still prove the earlier attempt reached the customer too. One alert per
 * wamid, listing the candidate attempts; an operator links one explicitly
 * (scripts/grocery-review.js link-receipt --attempt <id>). Never automatic.
 */
async function alertUnlinked(db, { olderThanMin = 15 } = {}) {
  const ids = await db.tx(async (c) => {
    const { rows } = await c.query(
      `SELECT b.wamid, b.recipient_id, min(b.status) AS status,
              jsonb_agg(DISTINCT jsonb_build_object('attempt_id', a.id, 'attempt_no', a.attempt_no, 'outcome', a.outcome,
                                                    'source_id', s.id, 'shopify_order_id', s.shopify_order_id,
                                                    'bill_state', s.bill_state)) AS candidates,
              min(s.id) AS source_id
         FROM whatsapp_receipt_backlog b
         JOIN shopify_order_bill_snapshots sn ON sn.phone = b.recipient_id
         JOIN shopify_order_bill_attempts a ON a.source_id = sn.source_id
                                         AND a.outcome IN ('ambiguous','claim_expired') AND a.wamid IS NULL
                                         AND (b.meta_timestamp IS NULL OR b.meta_timestamp >= a.claimed_at - interval '2 minutes')
         JOIN shopify_order_sources s ON s.id = a.source_id
        WHERE b.applied_at IS NULL AND b.status IN ('sent','delivered','read')
          AND b.received_at < now() - $1::numeric * interval '1 minute'
          AND NOT EXISTS (SELECT 1 FROM whatsapp_messages m WHERE m.wamid = b.wamid)
          AND NOT EXISTS (SELECT 1 FROM grocery_alerts g WHERE g.kind = 'receipt_unlinked' AND g.detail->>'wamid' = b.wamid)
        GROUP BY b.wamid, b.recipient_id`, [olderThanMin]);
    const out = [];
    for (const r of rows) {
      out.push(await alerts.insert(c, { sourceId: r.source_id, kind: "receipt_unlinked",
        detail: { wamid: r.wamid, recipient_id: r.recipient_id, status: r.status, candidates: r.candidates,
                  summary: "a delivery receipt may prove an earlier bill attempt reached the customer - link it after checking" } }));
    }
    return out;
  });
  if (ids.length) await alerts.dispatch(db, ids);
  return ids.length;
}

module.exports = { statusesIn, journal, applyOne, replay, alertUnlinked, PROOF };
