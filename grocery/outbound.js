// ============================================================================
// ASB PIPELINE — grocery/outbound.js
//
// The WhatsApp log for grocery bills, written INSIDE the caller's transaction
// and never swallowed: if it fails, the whole finalize step rolls back.
//
// One whatsapp_messages row per send ATTEMPT, keyed by the attempt's
// message_key (attempt 1 = 'order_confirmed:shopify:<id>', exactly as before;
// attempt n = '...:attempt:<n>'). So a resend never collides with an earlier
// failed/queued row, every accepted wamid has its own row for receipts, and
// the history of attempts is visible in the inbox thread.
//
// Column values match server.js logOutbound() exactly (the golden test
// compares them).
// ============================================================================

"use strict";

class OutboundLogConflict extends Error {}

/** status: 'sent' | 'failed' | 'queued' (ambiguous). */
async function logInTx(client, { key, customerId, orderId, phone, template, preview, wamid, status, payload }) {
  const ins = await client.query(
    `INSERT INTO whatsapp_messages
       (idempotency_key, customer_id, order_id, phone, direction,
        template_name, template_lang, wamid, status, payload, sent_at,
        received_at, attempts, msg_type, body_preview)
     VALUES ($1, $2, $3, $4, 'outbound', $5, $6, $7, $8::msg_status, $9,
             CASE WHEN $8::text = 'sent' THEN now() ELSE NULL END,
             now(), 1, CASE WHEN $5::text IS NULL THEN 'text' ELSE 'template' END, $10)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id`,
    [key, customerId || null, orderId || null, phone, template || null, template ? "ur" : null,
     wamid || null, status, payload || {}, (preview || template || "").slice(0, 500)]);
  if (ins.rows.length) return ins.rows[0].id;

  // Same key again: only a re-run of the SAME finalize is acceptable.
  const ex = (await client.query(
    `SELECT id, wamid, status::text AS status FROM whatsapp_messages WHERE idempotency_key = $1`, [key])).rows[0];
  if (ex && (ex.wamid || null) === (wamid || null)) return ex.id;
  throw new OutboundLogConflict(
    `whatsapp_messages ${key} already holds wamid ${ex?.wamid || "(none)"}; refusing to record ${wamid || "(none)"}`);
}

/** Late finalize / operator link: a queued attempt row becomes sent with its wamid. */
async function markSentInTx(client, { key, wamid }) {
  const r = await client.query(
    `UPDATE whatsapp_messages
        SET wamid = COALESCE(wamid, $2),
            status = CASE WHEN asb_msg_status_rank(status::text) < 1 THEN 'sent'::msg_status ELSE status END,
            sent_at = COALESCE(sent_at, now())
      WHERE idempotency_key = $1 AND (wamid IS NULL OR wamid = $2)
      RETURNING id`, [key, wamid || null]);
  if (!r.rows.length) throw new OutboundLogConflict(`whatsapp_messages ${key}: no row, or it holds a different wamid`);
  return r.rows[0].id;
}

module.exports = { logInTx, markSentInTx, OutboundLogConflict };
