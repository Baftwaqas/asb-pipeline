// ============================================================================
// ASB PIPELINE — community/classify.js
//
// CLASSIFICATION, NOT RESOLUTION.
//
// This decides one thing per Shopify order line: may it enter the grocery
// pipeline, or must it be diverted to community_intake? ANY Community signal
// diverts it. It never decides WHICH Offer Pack a line is - that is the
// worker's job, and only by exact registered variant id.
//
// Signals (any one is enough to divert):
//   registered_variant  line.variant_id is in community_variants
//   registered_product  line.product_id is in community_products
//   sku_prefix          line.sku starts with "ASB-COM-"
//   vendor              line.vendor is listed in COMMUNITY_VENDORS (env, comma
//                       separated; empty by default because today Community
//                       and grocery products share the vendor
//                       "Apna Sasta Bazaar")
//
//   classification = 'registered'  when the variant id itself is registered
//                  = 'suspect'     when only weaker signals fired (unknown
//                                  variant with a Community SKU, a registered
//                                  product with an unregistered variant, ...)
//
// Product type and tags are NOT available on order line items, which is why
// the registry exists.
// ============================================================================

"use strict";

const { numericId, hasCommunitySku } = require("./registry");

function communityVendors() {
  return String(process.env.COMMUNITY_VENDORS || "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/**
 * q: anything with .query. lines: Shopify line_items.
 * Returns [{ line, community, classification, signals }] in the same order.
 * One query for the whole order.
 */
async function classifyLines(q, lines) {
  const list = Array.isArray(lines) ? lines : [];
  const variantIds = [...new Set(list.map((l) => numericId(l?.variant_id)).filter(Boolean))];
  const productIds = [...new Set(list.map((l) => numericId(l?.product_id)).filter(Boolean))];

  let regVariants = new Set();
  let regProducts = new Set();
  if (variantIds.length || productIds.length) {
    const { rows } = await q.query(
      `SELECT 'v' AS k, shopify_variant_id AS id FROM community_variants
        WHERE shopify_variant_id = ANY($1::text[])
       UNION ALL
       SELECT 'p', shopify_product_id FROM community_products
        WHERE shopify_product_id = ANY($2::text[])`,
      [variantIds, productIds]
    );
    regVariants = new Set(rows.filter((r) => r.k === "v").map((r) => r.id));
    regProducts = new Set(rows.filter((r) => r.k === "p").map((r) => r.id));
  }

  const vendors = communityVendors();

  return list.map((line) => {
    const signals = [];
    const vid = numericId(line?.variant_id);
    const pid = numericId(line?.product_id);
    if (vid && regVariants.has(vid)) signals.push("registered_variant");
    if (pid && regProducts.has(pid)) signals.push("registered_product");
    if (hasCommunitySku(line?.sku)) signals.push("sku_prefix");
    if (line?.vendor && vendors.includes(String(line.vendor).trim().toLowerCase())) signals.push("vendor");
    return {
      line,
      community: signals.length > 0,
      classification: signals.includes("registered_variant") ? "registered" : (signals.length ? "suspect" : null),
      signals,
    };
  });
}

/**
 * Defence in depth for persistOrder(): the webhook already removed Community
 * lines, but if any code path ever hands one to the grocery writer, refuse the
 * whole transaction rather than create a products stub / order_items row.
 */
class CommunityLeakError extends Error {
  constructor(lines) {
    super(`refusing to write ${lines.length} Community line(s) into the grocery pipeline: ` +
      lines.map((l) => `${l.title || "?"} (variant ${l.variant_id || "?"}, sku ${l.sku || "-"})`).join("; "));
    this.name = "CommunityLeakError";
    this.code = "ASB_COMMUNITY_LEAK";
  }
}

async function assertNoCommunityLines(q, lines) {
  const out = await classifyLines(q, lines);
  const leaked = out.filter((c) => c.community).map((c) => c.line);
  if (leaked.length) throw new CommunityLeakError(leaked);
}

module.exports = { classifyLines, assertNoCommunityLines, CommunityLeakError, communityVendors };
