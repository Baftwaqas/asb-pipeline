// ============================================================================
// ASB PIPELINE — community/registry.js
//
// The local list of Shopify products/variants that are Community.
//
// WHY A LOCAL REGISTRY
// An orders/create webhook line item carries variant_id, product_id, sku,
// title and vendor - but NOT product_type or tags. The webhook transaction
// must not call Shopify (no network before the 200), so "is this line
// Community?" has to be answered from Postgres. This file keeps that answer
// current from three sources, all funnelled through upsertProduct():
//
//   * products/* webhooks      (inside the pre-200 transaction)
//   * productSync / inbox      (a product posted by the inbox rates screen)
//   * scripts/community-registry.js  (snapshot bootstrap + Admin API reconcile)
//
// RULES
//   * A product is Community if ANY signal says so: product_type
//     "Community Internal", tag "asb-community-internal", or any variant SKU
//     starting "ASB-COM-".
//   * Rows are never deleted. Once registered, an id stays Community. If its
//     Shopify data later stops looking Community, signals_ok becomes false and
//     the worker sends its lines to review - never to grocery.
//   * SKU is stored for information only. Nothing resolves by SKU.
// ============================================================================

"use strict";

const COMMUNITY_PRODUCT_TYPE = "community internal";
const COMMUNITY_TAG = "asb-community-internal";
const COMMUNITY_SKU_PREFIX = "ASB-COM-";

const productGid = (id) => `gid://shopify/Product/${id}`;
const variantGid = (id) => `gid://shopify/ProductVariant/${id}`;

/** Accepts a numeric id, a numeric string or a GID; returns the numeric id as text. */
function numericId(v) {
  if (v === null || v === undefined || v === "") return null;
  const m = String(v).match(/(\d+)\s*$/);
  return m ? m[1] : null;
}

function hasCommunitySku(sku) {
  return typeof sku === "string" && sku.trim().toUpperCase().startsWith(COMMUNITY_SKU_PREFIX);
}

/** Shopify REST webhooks send tags as "a, b, c"; GraphQL as an array. */
function tagList(tags) {
  if (Array.isArray(tags)) return tags.map((t) => String(t).trim()).filter(Boolean);
  if (typeof tags === "string") return tags.split(",").map((t) => t.trim()).filter(Boolean);
  return [];
}

/** Which Community signals does a Shopify product payload carry? */
function productSignals(p) {
  const out = [];
  if (String(p?.product_type || "").trim().toLowerCase() === COMMUNITY_PRODUCT_TYPE) out.push("product_type");
  if (tagList(p?.tags).some((t) => t.toLowerCase() === COMMUNITY_TAG)) out.push("tag");
  if ((p?.variants || []).some((v) => hasCommunitySku(v?.sku))) out.push("sku_prefix");
  return out;
}

async function isRegisteredProduct(q, productId) {
  const id = numericId(productId);
  if (!id) return false;
  const { rows } = await q.query(
    `SELECT 1 FROM community_products WHERE shopify_product_id = $1`, [id]);
  return rows.length > 0;
}

/**
 * Register (or refresh) one product from a Shopify REST-shaped payload:
 *   { id, title, status, product_type, vendor, tags, variants: [{ id, sku, title, price }] }
 * Registers it when it carries a Community signal OR is already registered.
 * `q` is anything with .query (a pool, the db module, or a transaction client).
 * Returns { registered: boolean, signals: string[] }.
 */
async function upsertProduct(q, p, via, { markMissingAbsent = true } = {}) {
  const pid = numericId(p?.id);
  if (!pid) return { registered: false, signals: [] };

  const signals = productSignals(p);
  const already = await isRegisteredProduct(q, pid);
  if (!signals.length && !already) return { registered: false, signals };

  // A payload without variants is partial (it cannot be a whole Shopify
  // product): never let it overwrite what the registry knows.
  if (!Array.isArray(p.variants) || !p.variants.length) {
    return { registered: already, signals, partial: true };
  }

  const status = p.status ? String(p.status).toLowerCase() : null;
  await q.query(
    `INSERT INTO community_products
       (shopify_product_id, product_gid, title, shopify_status, product_type, vendor, tags,
        signals_ok, registered_via, last_synced_at, deleted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), NULL)
     ON CONFLICT (shopify_product_id) DO UPDATE SET
       title          = EXCLUDED.title,
       shopify_status = EXCLUDED.shopify_status,
       product_type   = EXCLUDED.product_type,
       vendor         = EXCLUDED.vendor,
       tags           = EXCLUDED.tags,
       signals_ok     = EXCLUDED.signals_ok,
       last_synced_at = now(),
       deleted_at     = NULL`,
    [pid, productGid(pid), p.title || null, status, p.product_type || null,
     p.vendor || null, tagList(p.tags), signals.length > 0, via]
  );

  const seen = [];
  for (const v of p.variants || []) {
    const vid = numericId(v?.id);
    if (!vid) continue;
    seen.push(vid);
    await q.query(
      `INSERT INTO community_variants
         (shopify_variant_id, variant_gid, shopify_product_id, sku, variant_title, price,
          is_present, last_synced_at)
       VALUES ($1, $2, $3, $4, $5, $6, TRUE, now())
       ON CONFLICT (shopify_variant_id) DO UPDATE SET
         shopify_product_id = EXCLUDED.shopify_product_id,
         sku                = EXCLUDED.sku,
         variant_title      = EXCLUDED.variant_title,
         price              = EXCLUDED.price,
         is_present         = TRUE,
         last_synced_at     = now()`,
      [vid, variantGid(vid), pid, v.sku || null, v.title || null,
       v.price === undefined || v.price === null || v.price === "" ? null : Number(v.price)]
    );
  }

  // Variants Shopify no longer lists for this product stay registered (an old
  // cart can still check them out) but are marked absent.
  if (markMissingAbsent) await q.query(
    `UPDATE community_variants SET is_present = FALSE, last_synced_at = now()
      WHERE shopify_product_id = $1 AND is_present AND NOT (shopify_variant_id = ANY($2::text[]))`,
    [pid, seen]
  );

  return { registered: true, signals };
}

/** products/delete carries only { id }. Keep the rows; mark them deleted. */
async function markProductDeleted(q, productId) {
  const pid = numericId(productId);
  if (!pid) return false;
  const { rowCount } = await q.query(
    `UPDATE community_products
        SET shopify_status = 'deleted', deleted_at = now(), last_synced_at = now()
      WHERE shopify_product_id = $1`, [pid]);
  if (rowCount) {
    await q.query(
      `UPDATE community_variants SET is_present = FALSE, last_synced_at = now()
        WHERE shopify_product_id = $1`, [pid]);
  }
  return rowCount > 0;
}

/** Called from the pre-200 transaction for every products/* webhook. */
async function syncFromProductWebhook(q, topic, payload) {
  if (topic === "products/delete") {
    return { registered: await markProductDeleted(q, payload?.id), deleted: true };
  }
  return upsertProduct(q, payload, "webhook");
}

/**
 * Is this product payload Community (by signal or by registration)?
 * productSync uses this to refuse Community products before they can be
 * written into the grocery `products` table.
 */
async function isCommunityProduct(q, p) {
  if (productSignals(p).length) return true;
  return isRegisteredProduct(q, p?.id);
}

module.exports = {
  COMMUNITY_SKU_PREFIX,
  numericId,
  productGid,
  variantGid,
  hasCommunitySku,
  tagList,
  productSignals,
  upsertProduct,
  markProductDeleted,
  syncFromProductWebhook,
  isCommunityProduct,
  isRegisteredProduct,
};
