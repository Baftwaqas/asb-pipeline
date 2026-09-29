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

module.exports = { sendOrderBill, windowOpen };
