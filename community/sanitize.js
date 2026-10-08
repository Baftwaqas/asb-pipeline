// ============================================================================
// ASB PIPELINE — community/sanitize.js
//
// The grocery-only view of a MIXED Shopify order (grocery + Community lines).
//
// This is the only order object the grocery pipeline ever sees for a mixed
// cart: persistOrder() reads it, stores it on orders.source_payload, and the
// grocery bill is built from the rows it creates. So it is built by ALLOW-LIST:
// the fields the grocery code uses, the grocery lines, and nothing else.
//
//   * Community lines are removed.
//   * Order money totals (total_price, subtotal_price, tax/discount/shipping
//     arrays, *_set variants, ...) are DROPPED, not recalculated: Shopify's
//     figures include the Community packs, and a half-corrected copy is worse
//     than none. Grocery money comes from order_items, as it always has.
//   * refunds / fulfillments / line-level arrays that could carry Community
//     lines are dropped.
//   * asb_community_split records what was removed and where it went.
//
// The untouched original order lives in community_intake.order_payload
// (immutable) and webhook_events.payload. An order with NO Community lines is
// never passed through here - it reaches the grocery pipeline exactly as on
// main.
// ============================================================================

"use strict";

// Every top-level field the grocery path reads (server.js persistOrder + the
// fallback confirmation). Anything not listed is dropped.
const GROCERY_ORDER_FIELDS = [
  "id", "name", "order_number", "created_at", "note", "phone", "email",
  "customer", "shipping_address", "billing_address", "currency",
];

function groceryOnlyOrder(rawOrder, { groceryLines, communityLines, eventRowId }) {
  const out = {};
  for (const k of GROCERY_ORDER_FIELDS) {
    if (rawOrder && Object.prototype.hasOwnProperty.call(rawOrder, k)) out[k] = rawOrder[k];
  }
  out.line_items = groceryLines;
  out.asb_community_split = {
    note: "Community lines removed before the grocery pipeline; order totals dropped (they included them). " +
          "Original order: community_intake.order_payload / webhook_events.payload.",
    webhook_event_id: eventRowId || null,
    removed_line_item_ids: communityLines.map((c) => String(c.line.id)),
    community_intake_ids: communityLines.map((c) => c.intakeId).filter(Boolean),
  };
  return out;
}

module.exports = { groceryOnlyOrder, GROCERY_ORDER_FIELDS };
