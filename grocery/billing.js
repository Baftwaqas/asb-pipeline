// ============================================================================
// ASB PIPELINE — grocery/billing.js
//
// The order-confirmation bill: AT-MOST-ONCE AUTOMATIC SEND, with manual
// reconciliation of ambiguous sends.
//
//   T2 claim     one transaction: checks (hold, earlier log, cancelled bag,
//                age), chooses the channel, INSERTS an attempt row and moves
//                the bill pending -> sending in one update.
//   T3 send      no transaction: the FROZEN snapshot, exactly as stored.
//   T4 finalize  one transaction: the attempt's result, the whatsapp_messages
//                row for THIS attempt (outbound.logInTx, never swallowed) and
//                the bill state. Retried in-process if the database is away;
//                after that the sweeper marks the claim expired -> 'unknown'.
//
// Automatic retry ONLY when nothing was sent (not_sent, or a Graph refusal
// that is safe to retry). 131047 (24h window shut) retries as a TEMPLATE.
// Ambiguous outcomes become 'unknown' and wait for a person.
// ============================================================================

"use strict";

const notify = require("../notify");
const alerts = require("./alerts");
const outbound = require("./outbound");
const receipts = require("./receipts");
const switches = require("./switches");

const { billMaxAttempts, billMaxAgeH: BILL_MAX_AGE_H } = require("./config");
const BILL_BASE_BACKOFF_S = Number(process.env.GROCERY_BILL_BASE_BACKOFF_S || 60);
const CLAIM_EXPIRY_MIN = Number(process.env.GROCERY_BILL_CLAIM_EXPIRY_MIN || 10);
const FINALIZE_RETRY_MS = Number(process.env.GROCERY_FINALIZE_RETRY_MS || 5 * 60 * 1000);

/** T2. Returns { attemptId, token, snapshot, channel } | { done: '<reason>' } | null. */
async function claim(db, sourceId) {
  const alertIds = [];
  const out = await db.tx(async (c) => {
    const s = (await c.query(
      `SELECT s.*, (s.bill_next_attempt_at IS NULL OR s.bill_next_attempt_at <= now()) AS due
         FROM shopify_order_sources s WHERE s.id = $1 FOR NO KEY UPDATE`, [sourceId])).rows[0];
    if (!s || s.bill_state !== "pending" || !s.due || s.bill_hold_reason) return null;
    const snap = (await c.query(
      `SELECT *, (composed_at < now() - $2::numeric * interval '1 hour') AS stale
         FROM shopify_order_bill_snapshots WHERE source_id = $1`, [sourceId, BILL_MAX_AGE_H()])).rows[0];

    // A pre-017 log row for this bill already shows it went out.
    const prior = (await c.query(
      `SELECT 1 FROM whatsapp_messages m
        WHERE m.idempotency_key = $1 AND m.status::text IN ('sent','delivered','read')
          AND NOT EXISTS (SELECT 1 FROM shopify_order_bill_attempts a WHERE a.message_key = m.idempotency_key)`,
      [snap.bill_key])).rows.length;
    if (prior) {
      await c.query(
        `UPDATE shopify_order_sources SET bill_state = 'sent', bill_proof = 'prior_log', bill_outcome = 'prior_log',
                bill_done_at = now(), bill_authorization_audit_id = NULL WHERE id = $1`, [sourceId]);
      return { done: "prior_log" };
    }
    const bag = (await c.query(`SELECT status::text AS status FROM orders WHERE id = $1`, [s.order_id])).rows[0];
    if (bag?.status === "cancelled") {
      await c.query(
        `UPDATE shopify_order_sources SET bill_state = 'not_required', bill_outcome = 'cancelled',
                bill_authorization_audit_id = NULL WHERE id = $1`, [sourceId]);
      return { done: "cancelled" };
    }
    // Too old to confirm automatically. An operator's resend overrides this -
    // for its own retries too (attempts after the authorizing attempt).
    const authorized = Boolean(s.bill_authorization_audit_id) || (await c.query(
      `SELECT 1 FROM shopify_order_bill_attempts
        WHERE source_id = $1 AND attempt_no > $2 AND authorization_audit_id IS NOT NULL`,
      [sourceId, s.bill_attempt_budget_base])).rows.length > 0;
    if (snap.stale && !authorized) {
      await c.query(
        `UPDATE shopify_order_sources SET bill_state = 'failed', bill_outcome = 'stale' WHERE id = $1`, [sourceId]);
      alertIds.push(await alerts.insert(c, { sourceId, kind: "bill_stale",
        detail: { shopify_order_id: s.shopify_order_id, order_name: s.shopify_order_name,
                  summary: `bill older than ${BILL_MAX_AGE_H()}h - not sent automatically` } }));
      return { done: "stale" };
    }

    // Channel: free text inside the 24h window, else the template. After a
    // 131047 refusal for this bill, only the template.
    const forceTemplate = (await c.query(
      `SELECT 1 FROM shopify_order_bill_attempts a
        WHERE a.source_id = $1
          AND (a.transport->>'retryVia' = 'template'
               OR EXISTS (SELECT 1 FROM whatsapp_messages m WHERE m.wamid = a.wamid AND m.error_code = '131047'))`,
      [sourceId])).rows.length > 0;
    const open = forceTemplate ? false : Boolean((await c.query(
      `SELECT window_open FROM asb_conversations WHERE phone = $1`, [snap.phone])).rows[0]?.window_open);
    const channel = open ? "text" : "template";

    let initiatedBy = "worker";
    if (s.bill_authorization_audit_id) {
      initiatedBy = (await c.query(`SELECT actor FROM shopify_order_source_audit WHERE id = $1`,
                                   [s.bill_authorization_audit_id])).rows[0].actor;
    }
    // Attempt number: after the last one, skipping any key a pre-017 log row
    // already holds (old code logged its own bill under the attempt-1 key).
    let n = Math.max(s.bill_attempts,
      Number((await c.query(`SELECT coalesce(max(attempt_no), 0) AS m FROM shopify_order_bill_attempts WHERE source_id = $1`,
                            [sourceId])).rows[0].m)) + 1;
    const keyFor = (k) => (k === 1 ? snap.bill_key : `${snap.bill_key}:attempt:${k}`);
    while ((await c.query(`SELECT 1 FROM whatsapp_messages WHERE idempotency_key = $1`, [keyFor(n)])).rows.length) n++;
    const a = (await c.query(
      `INSERT INTO shopify_order_bill_attempts
         (source_id, bill_key, attempt_no, message_key, claim_token, channel, initiated_by, authorization_audit_id)
       VALUES ($1, $2, $3, $4, gen_random_uuid(), $5, $6, $7)
       RETURNING id, claim_token`,
      [sourceId, snap.bill_key, n, keyFor(n), channel,
       initiatedBy, s.bill_authorization_audit_id || null])).rows[0];
    await c.query(
      `UPDATE shopify_order_sources
          SET bill_state = 'sending', bill_attempts = bill_attempts + 1, bill_current_attempt_id = $2,
              bill_authorization_audit_id = NULL
        WHERE id = $1`, [sourceId, a.id]);
    return { attemptId: a.id, token: a.claim_token, snapshot: snap, channel };
  });
  if (alertIds.length) await alerts.dispatch(db, alertIds);
  return out;
}

/** T4. Returns a short outcome string. Throws only if the database fails (caller retries). */
async function finalize(db, attemptId, token, r) {
  const alertIds = [];
  const out = await db.tx(async (c) => {
    const a = (await c.query(
      `SELECT * FROM shopify_order_bill_attempts WHERE id = $1 AND claim_token = $2 FOR UPDATE`, [attemptId, token])).rows[0];
    if (!a) throw new Error(`bill attempt ${attemptId} not found for this claim`);
    const s = (await c.query(`SELECT * FROM shopify_order_sources WHERE id = $1 FOR NO KEY UPDATE`, [a.source_id])).rows[0];
    const snap = (await c.query(`SELECT * FROM shopify_order_bill_snapshots WHERE source_id = $1`, [a.source_id])).rows[0];
    const transport = { ...r, data: r.data ?? null };
    const logBase = {
      key: a.message_key, customerId: s.customer_id, orderId: s.order_id, phone: snap.phone,
      template: a.channel === "template" ? snap.template_name : null, preview: snap.rich_text,
      payload: { order_name: s.shopify_order_name, attempt_no: a.attempt_no, channel: a.channel, response: r.data ?? null },
    };

    // ---- the attempt was already closed (claim expired / ambiguous) ----
    if (a.outcome !== null) {
      if ((a.outcome === "ambiguous" || a.outcome === "claim_expired") && r.outcome === "accepted" && r.wamid) {
        await c.query(
          `UPDATE shopify_order_bill_attempts SET outcome = 'accepted', wamid = $2,
                  proof = COALESCE(proof, 'accepted') WHERE id = $1`, [a.id, r.wamid]);
        await outbound.markSentInTx(c, { key: a.message_key, wamid: r.wamid });
        if (s.bill_state === "unknown" || s.bill_state === "failed") {
          await c.query(
            `UPDATE shopify_order_sources SET bill_state = 'sent', bill_proof = 'accepted', bill_outcome = 'accepted',
                    bill_done_at = now() WHERE id = $1`, [s.id]);
        }
        return { outcome: "late_accepted", wamid: r.wamid };
      }
      alertIds.push(await alerts.insert(c, { sourceId: s.id, kind: "finalize_conflict",
        detail: { shopify_order_id: s.shopify_order_id, attempt: a.attempt_no, recorded: a.outcome, result: transport,
                  summary: "a send result arrived for an attempt that was already closed" } }));
      return { outcome: "conflict" };
    }

    const sendingThis = s.bill_state === "sending" && String(s.bill_current_attempt_id) === String(a.id);
    const used = s.bill_attempts - s.bill_attempt_budget_base;

    if (r.outcome === "accepted" && r.wamid) {
      await c.query(
        `UPDATE shopify_order_bill_attempts SET outcome = 'accepted', retryable = false, transport = $2, wamid = $3,
                proof = 'accepted', finished_at = now() WHERE id = $1`, [a.id, transport, r.wamid]);
      await outbound.logInTx(c, { ...logBase, wamid: r.wamid, status: "sent" });
      if (sendingThis) {
        await c.query(
          `UPDATE shopify_order_sources SET bill_state = 'sent', bill_proof = 'accepted', bill_outcome = 'accepted',
                  bill_done_at = now() WHERE id = $1`, [s.id]);
      }
      return { outcome: "sent", wamid: r.wamid };
    }

    const outcome = r.outcome === "not_sent" || r.outcome === "refused" ? r.outcome : "ambiguous";
    await c.query(
      `UPDATE shopify_order_bill_attempts SET outcome = $2, retryable = $3, transport = $4, finished_at = now()
        WHERE id = $1`, [a.id, outcome, outcome !== "ambiguous" && Boolean(r.retryable), transport]);
    await outbound.logInTx(c, { ...logBase, wamid: null, status: outcome === "ambiguous" ? "queued" : "failed" });
    if (!sendingThis) {
      alertIds.push(await alerts.insert(c, { sourceId: s.id, kind: "finalize_conflict",
        detail: { shopify_order_id: s.shopify_order_id, attempt: a.attempt_no, result: transport,
                  summary: "the bill changed state while this attempt was in flight" } }));
      return { outcome: "conflict" };
    }

    if (outcome === "ambiguous") {
      await c.query(`UPDATE shopify_order_sources SET bill_state = 'unknown', bill_outcome = 'ambiguous' WHERE id = $1`, [s.id]);
      alertIds.push(await alerts.insert(c, { sourceId: s.id, kind: "bill_unknown",
        detail: { shopify_order_id: s.shopify_order_id, order_name: s.shopify_order_name, attempt: a.attempt_no,
                  phone: snap.phone, transport,
                  summary: "send outcome unknown - check the customer's chat before any resend" } }));
      return { outcome: "unknown" };
    }
    if (r.retryable && used < billMaxAttempts()) {
      const backoff = r.retryVia === "template" ? 0 : Math.min(3600, BILL_BASE_BACKOFF_S * 2 ** Math.max(0, used - 1));
      await c.query(
        `UPDATE shopify_order_sources SET bill_state = 'pending', bill_outcome = $2,
                bill_next_attempt_at = now() + make_interval(secs => $3) WHERE id = $1`, [s.id, outcome, backoff]);
      return { outcome: r.retryVia === "template" ? "retry_template" : "retry" };
    }
    await c.query(`UPDATE shopify_order_sources SET bill_state = 'failed', bill_outcome = $2 WHERE id = $1`, [s.id, outcome]);
    alertIds.push(await alerts.insert(c, { sourceId: s.id, kind: "bill_failed",
      detail: { shopify_order_id: s.shopify_order_id, order_name: s.shopify_order_name, attempt: a.attempt_no,
                transport, summary: `bill not sent (${r.metaCode || r.errorCode || outcome})` } }));
    return { outcome: "failed" };
  });
  if (alertIds.length) await alerts.dispatch(db, alertIds);
  if (out.wamid) await receipts.replay(db, { wamid: out.wamid });
  return out.outcome;
}

async function finalizeWithRetry(db, attemptId, token, r) {
  const until = Date.now() + FINALIZE_RETRY_MS;
  let wait = 500;
  for (;;) {
    try {
      return await finalize(db, attemptId, token, r);
    } catch (e) {
      if (Date.now() + wait > until) {
        // Not swallowed: the claim will expire -> 'unknown', and this line is
        // the reconciliation evidence (it carries the wamid if Meta accepted).
        console.error(`[grocery] CRITICAL bill attempt ${attemptId} could not be finalized: ${e.message} ` +
                      `RESULT ${JSON.stringify({ ...r, data: undefined })}`);
        return "unfinalized";
      }
      console.error(`[grocery] bill attempt ${attemptId} finalize failed (retrying): ${e.message}`);
      await new Promise((res) => setTimeout(res, wait));
      wait = Math.min(wait * 2, 30000);
    }
  }
}

/** T2 -> T3 -> T4 for one source. Returns an outcome string or null. Never throws. */
async function processBill(db, sourceId) {
  try {
    // A 131047 refusal (nothing sent) is retried at once as a template; any
    // other retry waits for its backoff and the sweeper.
    for (let round = 0; round < 2; round++) {
      if (!(await switches.billsEnabled(db))) return null;
      const cl = await claim(db, sourceId);
      if (!cl) return null;
      if (cl.done) return cl.done;
      const r = await notify.sendBillSnapshot(cl.snapshot, cl.channel);
      console.log(`   Bill attempt ${cl.attemptId} (${cl.channel}): ${r.outcome}${r.wamid ? ` ${r.wamid}` : ""}`);
      const out = await finalizeWithRetry(db, cl.attemptId, cl.token, r);
      if (out !== "retry_template") return out;
    }
    return "retry_template";
  } catch (e) {
    console.error(`[grocery] bill for source ${sourceId} failed before sending: ${e.message}`);
    return null;
  }
}

/** Sweeper: a claim that never finalized becomes 'unknown' (never re-sent automatically). */
async function expireClaims(db, { olderThanMin = CLAIM_EXPIRY_MIN } = {}) {
  const { rows } = await db.query(
    `SELECT a.id FROM shopify_order_bill_attempts a
       JOIN shopify_order_sources s ON s.bill_current_attempt_id = a.id AND s.bill_state = 'sending'
      WHERE a.outcome IS NULL AND a.claimed_at < now() - $1::numeric * interval '1 minute'`, [olderThanMin]);
  let n = 0;
  for (const r of rows) {
    const alertIds = [];
    try {
      const done = await db.tx(async (c) => {
        const a = (await c.query(`SELECT * FROM shopify_order_bill_attempts WHERE id = $1 AND outcome IS NULL FOR UPDATE`, [r.id])).rows[0];
        if (!a) return false;
        const s = (await c.query(`SELECT * FROM shopify_order_sources WHERE id = $1 FOR NO KEY UPDATE`, [a.source_id])).rows[0];
        if (s.bill_state !== "sending" || String(s.bill_current_attempt_id) !== String(a.id)) return false;
        const snap = (await c.query(`SELECT * FROM shopify_order_bill_snapshots WHERE source_id = $1`, [a.source_id])).rows[0];
        await c.query(
          `UPDATE shopify_order_bill_attempts SET outcome = 'claim_expired', retryable = false,
                  transport = $2, finished_at = now() WHERE id = $1`, [a.id, { reason: "claim_expired" }]);
        await outbound.logInTx(c, {
          key: a.message_key, customerId: s.customer_id, orderId: s.order_id, phone: snap.phone,
          template: a.channel === "template" ? snap.template_name : null, preview: snap.rich_text,
          wamid: null, status: "queued", payload: { order_name: s.shopify_order_name, attempt_no: a.attempt_no, claim_expired: true },
        });
        await c.query(`UPDATE shopify_order_sources SET bill_state = 'unknown', bill_outcome = 'claim_expired' WHERE id = $1`, [s.id]);
        alertIds.push(await alerts.insert(c, { sourceId: s.id, kind: "bill_unknown",
          detail: { shopify_order_id: s.shopify_order_id, order_name: s.shopify_order_name, attempt: a.attempt_no,
                    phone: snap.phone, summary: "send never finalized - check the chat and the logs before any resend" } }));
        return true;
      });
      if (done) n++;
      if (alertIds.length) await alerts.dispatch(db, alertIds);
    } catch (e) {
      console.error(`[grocery] could not expire bill claim ${r.id}: ${e.message}`);
    }
  }
  return n;
}

module.exports = { claim, finalize, finalizeWithRetry, processBill, expireClaims,
                   billMaxAttempts, BILL_MAX_AGE_H, CLAIM_EXPIRY_MIN };
