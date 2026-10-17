// ============================================================================
// ASB PIPELINE — grocery/alerts.js
//
// Alert OUTBOX. An alert row is inserted in the same transaction as the state
// change it reports; it is delivered (web push to the inbox devices) only
// AFTER that transaction commits, and retried by the sweeper. Delivering an
// alert never touches grocery or bill state, so it can never roll one back.
// ============================================================================

"use strict";


/** Inside the caller's transaction. Returns the alert id. */
async function insert(client, { sourceId = null, kind, detail = {} }) {
  const { rows } = await client.query(
    `INSERT INTO grocery_alerts (source_id, kind, detail) VALUES ($1, $2, $3) RETURNING id`,
    [sourceId, kind, detail]);
  console.warn(`[grocery] ALERT ${kind}${sourceId ? ` source ${sourceId}` : ""}: ${JSON.stringify(detail).slice(0, 300)}`);
  return rows[0].id;
}

const TITLES = {
  review: "Order needs review",
  bill_failed: "Bill NOT sent",
  bill_unknown: "Bill send UNKNOWN - check the chat",
  bill_stale: "Bill held back (too old)",
  compose_error: "Bill could not be composed",
  duplicate_anomaly: "Shopify order arrived again with DIFFERENT content",
  bill_delivery_failed: "WhatsApp says the bill was not delivered",
  finalize_conflict: "Bill result could not be recorded",
  receipt_unlinked: "Delivery receipt for an unknown message",
  invalid_order: "Shopify order without an order id",
};

// Alert push is an explicit switch: GROCERY_ALERT_PUSH=on. Off (the default),
// alerts are still recorded and shown in /healthz and grocery:review - they
// simply wait, untouched, as 'pending'. push.js additionally suppresses every
// push on a database marked as a rehearsal copy.
const pushOn = () => String(process.env.GROCERY_ALERT_PUSH || "off").toLowerCase() === "on";
const baseBackoff = () => Number(process.env.GROCERY_ALERT_BASE_BACKOFF_S ?? 60);
const maxAttempts = () => Number(process.env.GROCERY_ALERT_MAX_ATTEMPTS || 10);

// Overridable in tests. Returns push.notifyAll's result: { devices, delivered, suppressed?, error? }.
let deliver = async (db, alert) => {
  const push = require("../push");
  return push.notifyAll(db, {
    title: `ASB: ${TITLES[alert.kind] || alert.kind}`,
    body: `${alert.detail?.order_name || alert.detail?.shopify_order_id || ""} ${alert.detail?.summary || ""}`.trim().slice(0, 180) || alert.kind,
    url: "/inbox",
    tag: `grocery-alert-${alert.id}`,
    topic: `ga${alert.id}`.slice(0, 32),
  });
};

/**
 * After commit: try to deliver due pending alerts (all, or the given ids).
 * An alert counts as SENT only when at least one device accepted it. No
 * subscribed device, every device failing, or an error -> retried with
 * backoff, then 'gave_up'. Suppressed push -> nothing is touched. Never throws.
 */
async function dispatch(db, ids = null) {
  if (!pushOn()) return { sent: 0, failed: 0, suppressed: "GROCERY_ALERT_PUSH is off" };
  let rows;
  try {
    rows = (await db.query(
      `SELECT * FROM grocery_alerts WHERE state = 'pending' AND next_attempt_at <= now()
          ${ids ? "AND id = ANY($1)" : ""} ORDER BY id LIMIT 50`,
      ids ? [ids] : [])).rows;
  } catch (e) {
    console.error("[grocery] alert dispatch could not read the outbox:", e.message);
    return { sent: 0, failed: 0 };
  }
  let sent = 0, failed = 0;
  for (const a of rows) {
    let r;
    try { r = await deliver(db, a); } catch (e) { r = { devices: 0, delivered: 0, error: e.message }; }
    if (r && r.suppressed) return { sent, failed, suppressed: r.suppressed };
    try {
      if (r && Number(r.delivered) >= 1) {
        await db.query(`UPDATE grocery_alerts SET state = 'sent', attempts = attempts + 1, sent_at = now(), last_error = NULL
                         WHERE id = $1 AND state = 'pending'`, [a.id]);
        sent++;
        continue;
      }
      failed++;
      const why = r?.error ? `push error: ${r.error}` : r?.devices ? `0 of ${r.devices} device(s) accepted` : "no subscribed devices";
      await db.query(
        `UPDATE grocery_alerts SET attempts = attempts + 1, last_error = $2,
                state = CASE WHEN attempts + 1 >= $3 THEN 'gave_up' ELSE 'pending' END,
                next_attempt_at = now() + make_interval(secs => LEAST(3600, $4::double precision * power(2, attempts)))
          WHERE id = $1 AND state = 'pending'`, [a.id, why.slice(0, 500), maxAttempts(), baseBackoff()]);
    } catch (e2) {
      console.error("[grocery] could not record alert delivery:", e2.message);
    }
  }
  return { sent, failed };
}

const defaultDeliver = deliver;
function _setDeliver(fn) { deliver = fn || defaultDeliver; }

module.exports = { insert, dispatch, _setDeliver, pushOn };
