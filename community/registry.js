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

/** Registered AND active (an operator-deactivated product no longer counts). */
async function isRegisteredProduct(q, productId) {
  const id = numericId(productId);
  if (!id) return false;
  const { rows } = await q.query(
    `SELECT 1 FROM community_products WHERE shopify_product_id = $1 AND is_active`, [id]);
  return rows.length > 0;
}

async function productRow(q, productId) {
  const { rows } = await q.query(
    `SELECT * FROM community_products WHERE shopify_product_id = $1`, [numericId(productId)]);
  return rows[0] || null;
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
  const existing = await productRow(q, pid);
  const already = Boolean(existing);       // registered at all (active or deactivated)
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

  // An operator deactivated this product, but Shopify marks it Community
  // again: Community wins (fail closed). Recorded in the audit log.
  let reactivated = false;
  if (existing && !existing.is_active && signals.length) {
    await q.query(
      `UPDATE community_products
          SET is_active = TRUE, deactivated_at = NULL, deactivated_by = NULL, deactivation_reason = NULL
        WHERE shopify_product_id = $1`, [pid]);
    await audit(q, {
      actor: "system", action: "auto_reactivate_product", targetType: "product", targetId: pid,
      reason: `Shopify marks it Community again (${signals.join("+")}) via ${via}`,
      before: { is_active: false, deactivated_by: existing.deactivated_by, deactivation_reason: existing.deactivation_reason },
      after: { is_active: true },
    });
    reactivated = true;
  }

  return { registered: true, signals, reactivated };
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

// ---------------------------------------------------------------------------
// Operator actions (scripts/community-registry.js). Every one is
//   * dry-run unless apply === true,
//   * refused without an actor and a reason,
//   * written with an append-only community_audit row,
//   * NEVER touches community_intake: rows already captured stay Community.
//     Their pending lines go to review (product_deactivated /
//     variant_deactivated) - they can never become grocery.
// ---------------------------------------------------------------------------

class GuardError extends Error {
  constructor(msg) { super(msg); this.name = "GuardError"; this.code = "ASB_COMMUNITY_GUARD"; }
}

async function audit(q, { actor, action, targetType, targetId, reason, before, after }) {
  await q.query(
    `INSERT INTO community_audit (actor, action, target_type, target_id, reason, before, after)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [actor, action, targetType, String(targetId), reason, before || null, after || null]);
}

function requireWho(actor, reason) {
  if (!actor || !String(actor).trim()) throw new GuardError("--by <name> is required");
  if (!reason || String(reason).trim().length < 10) {
    throw new GuardError("--reason is required (at least 10 characters, say why)");
  }
}

/** What an operator action would affect: the registry rows and the intake rows by status. */
async function impact(q, { productId, variantId }) {
  const where = variantId ? `shopify_variant_id = $1` : `shopify_product_id = $1 OR shopify_variant_id IN
                   (SELECT shopify_variant_id FROM community_variants WHERE shopify_product_id = $1)`;
  const id = variantId || productId;
  const { rows } = await q.query(
    `SELECT status, count(*)::int AS n FROM community_intake WHERE ${where} GROUP BY status ORDER BY status`, [id]);
  return Object.fromEntries(rows.map((r) => [r.status, r.n]));
}

/**
 * Deactivate a product registered by mistake. Allowed only once Shopify no
 * longer marks it Community (signals_ok = false): otherwise the next product
 * webhook would rightly re-register it, so the fix belongs in Shopify first.
 */
async function deactivateProduct(db, { productId, actor, reason, apply = false }) {
  requireWho(actor, reason);
  const pid = numericId(productId);
  const run = async (q) => {
    const p = (await q.query(
      `SELECT * FROM community_products WHERE shopify_product_id = $1 ${apply ? "FOR UPDATE" : ""}`, [pid])).rows[0];
    if (!p) throw new GuardError(`product ${pid} is not in the Community registry`);
    if (!p.is_active) throw new GuardError(`product ${pid} is already deactivated (by ${p.deactivated_by})`);
    if (p.signals_ok) {
      throw new GuardError(
        `product ${pid} ("${p.title}") is still marked Community in Shopify ` +
        `(type "${p.product_type}", tags ${JSON.stringify(p.tags)}). Remove the Community product type, ` +
        `the asb-community-internal tag and any ASB-COM- SKU in Shopify first; the products/update webhook ` +
        `(or --from-shopify --apply) then records signals_ok = false.`);
    }
    const intake = await impact(q, { productId: pid });
    const plan = { action: "deactivate_product", product: { id: pid, title: p.title, status: p.shopify_status },
                   intake_rows_unchanged: intake,
                   effect: "future lines of this product are no longer Community BY REGISTRY; " +
                           "pending intake rows go to review (product_deactivated), never to grocery" };
    if (!apply) return { applied: false, plan };
    await q.query(
      `UPDATE community_products
          SET is_active = FALSE, deactivated_at = now(), deactivated_by = $2, deactivation_reason = $3
        WHERE shopify_product_id = $1`, [pid, actor, reason]);
    await audit(q, { actor, action: "deactivate_product", targetType: "product", targetId: pid, reason,
                     before: { is_active: true }, after: { is_active: false }, });
    return { applied: true, plan };
  };
  return apply ? db.tx(run) : run(db);
}

/**
 * Deactivate one variant (e.g. a pack that must stop resolving). While its
 * product stays registered, lines for it are still Community and go to review
 * (variant_deactivated).
 */
async function deactivateVariant(db, { variantId, actor, reason, apply = false }) {
  requireWho(actor, reason);
  const vid = numericId(variantId);
  const run = async (q) => {
    const v = (await q.query(
      `SELECT v.*, p.title AS product_title, p.is_active AS product_active
         FROM community_variants v JOIN community_products p USING (shopify_product_id)
        WHERE v.shopify_variant_id = $1 ${apply ? "FOR UPDATE OF v" : ""}`, [vid])).rows[0];
    if (!v) throw new GuardError(`variant ${vid} is not in the Community registry`);
    if (!v.is_active) throw new GuardError(`variant ${vid} is already deactivated (by ${v.deactivated_by})`);
    const intake = await impact(q, { variantId: vid });
    const plan = { action: "deactivate_variant",
                   variant: { id: vid, sku: v.sku, title: v.variant_title, product: v.product_title },
                   intake_rows_unchanged: intake,
                   effect: v.product_active
                     ? "lines for this variant stay Community (product still registered) and go to review (variant_deactivated)"
                     : "product already deactivated; this variant no longer counts as Community by registry" };
    if (!apply) return { applied: false, plan };
    await q.query(
      `UPDATE community_variants
          SET is_active = FALSE, deactivated_at = now(), deactivated_by = $2, deactivation_reason = $3
        WHERE shopify_variant_id = $1`, [vid, actor, reason]);
    await audit(q, { actor, action: "deactivate_variant", targetType: "variant", targetId: vid, reason,
                     before: { is_active: true }, after: { is_active: false } });
    return { applied: true, plan };
  };
  return apply ? db.tx(run) : run(db);
}

async function reactivate(db, { kind, id, actor, reason, apply = false }) {
  requireWho(actor, reason);
  const table = kind === "product" ? "community_products" : "community_variants";
  const key = kind === "product" ? "shopify_product_id" : "shopify_variant_id";
  const nid = numericId(id);
  const run = async (q) => {
    const r = (await q.query(`SELECT * FROM ${table} WHERE ${key} = $1 ${apply ? "FOR UPDATE" : ""}`, [nid])).rows[0];
    if (!r) throw new GuardError(`${kind} ${nid} is not in the Community registry`);
    if (r.is_active) throw new GuardError(`${kind} ${nid} is already active`);
    const plan = { action: `reactivate_${kind}`, id: nid,
                   effect: "Community again by registry; intake rows in review are NOT re-queued automatically" };
    if (!apply) return { applied: false, plan };
    await q.query(
      `UPDATE ${table} SET is_active = TRUE, deactivated_at = NULL, deactivated_by = NULL, deactivation_reason = NULL
        WHERE ${key} = $1`, [nid]);
    await audit(q, { actor, action: `reactivate_${kind}`, targetType: kind, targetId: nid, reason,
                     before: { is_active: false, deactivated_by: r.deactivated_by, deactivation_reason: r.deactivation_reason },
                     after: { is_active: true } });
    return { applied: true, plan };
  };
  return apply ? db.tx(run) : run(db);
}

module.exports = {
  GuardError,
  audit,
  requireWho,
  deactivateProduct,
  deactivateVariant,
  reactivate,
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
