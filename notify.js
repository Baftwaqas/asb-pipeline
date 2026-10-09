// ============================================================================
// ASB PIPELINE — notify.js
//
// Getting a bill to a customer, by the cheapest route WhatsApp allows.
//
//   * She wrote to us in the last 24 hours  -> the full bill as a normal
//     message. Free, and it keeps the exact layout.
//   * She did not                           -> the approved asb_order_bill
//     template. Meta charges for it, but it is the only thing allowed.
//
// Used by the Shopify webhook (server.js) and the inbox (inbox.js), so both
// doors send the same bill the same way.
// ============================================================================

"use strict";

const wa = require("./whatsapp");
const T = require("./templates");

async function windowOpen(db, phone) {
  try {
    const { rows } = await db.query(
      `SELECT window_open FROM asb_conversations WHERE phone = $1`, [phone]
    );
    return Boolean(rows[0]?.window_open);
  } catch (_) {
    return false;
  }
}

/**
 * composed: bill.orderConfirmation(...) output.
 * Returns { result, via: 'text' | 'template', template }.
 */
async function sendOrderBill(db, phone, composed) {
  if (await windowOpen(db, phone)) {
    const result = await wa.sendText(phone, composed.rich);
    return { result, via: "text", template: null };
  }
  const t = T.TEMPLATES.orderBill;
  const result = await wa.sendTemplate(phone, t.name, T.orderBillParams(composed), { lang: t.language });
  return { result, via: "template", template: t.name };
}

/**
 * Send a FROZEN bill snapshot (migration 017) on an already-chosen channel.
 * No database work, no re-composition: exactly the stored text, or exactly
 * the stored template parameters. Returns the structured transport result
 * (whatsapp.js). A result without `outcome` (an older client or a test stub)
 * is accepted only with a wamid; anything else is treated as ambiguous.
 */
async function sendBillSnapshot(snapshot, channel) {
  let r;
  try {
    r = channel === "text"
      ? await wa.sendText(snapshot.phone, snapshot.rich_text)
      : await wa.sendTemplate(snapshot.phone, snapshot.template_name, snapshot.template_params,
                              { lang: snapshot.template_lang });
  } catch (e) {
    r = { outcome: "ambiguous", retryable: false, phase: "request", errorMessage: e.message };
  }
  if (!r || !r.outcome) {
    const ok = Boolean(r?.ok && r?.wamid);
    r = { ...(r || {}), outcome: ok ? "accepted" : "ambiguous", retryable: false, retryVia: null,
          phase: "response", wamid: r?.wamid || null };
  }
  return r;
}

module.exports = { sendOrderBill, sendBillSnapshot, windowOpen };
