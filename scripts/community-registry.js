#!/usr/bin/env node
// ============================================================================
// ASB PIPELINE — scripts/community-registry.js
//
// Bootstrap and reconcile the Community product/variant registry
// (community_products, community_variants - migration 016).
//
// DRY RUN BY DEFAULT. Nothing is written without --apply.
//
//   # one-time bootstrap from the checked-in snapshot (no Shopify access needed)
//   node scripts/community-registry.js --snapshot db/community/registry-snapshot-2026-10-08.json
//   node scripts/community-registry.js --snapshot db/community/registry-snapshot-2026-10-08.json --apply
//
//   # reconcile against live Shopify (needs SHOPIFY_SHOP_DOMAIN, SHOPIFY_ADMIN_TOKEN
//   # with read_products; SHOPIFY_API_VERSION optional)
//   node scripts/community-registry.js --from-shopify
//   node scripts/community-registry.js --from-shopify --apply
//
// --from-shopify reads (a) every product that carries a Community signal and
// (b) every product already in the registry, so a product that LOST its
// signals is re-read and flagged (signals_ok = false) instead of silently
// staying "fine". It only ever READS Shopify.
// ============================================================================

"use strict";

const fs = require("fs");
const registry = require("../community/registry");

const COMMUNITY_QUERY = "product_type:'Community Internal' OR tag:asb-community-internal OR sku:ASB-COM-*";

const PRODUCT_FIELDS = `
  id legacyResourceId title status productType vendor tags
  variants(first: 100) { nodes { id legacyResourceId sku title price } }`;

/** GraphQL product -> the REST/webhook shape registry.upsertProduct() takes. */
function fromGraphqlProduct(n) {
  return {
    id: n.legacyResourceId || registry.numericId(n.id),
    title: n.title,
    status: String(n.status || "").toLowerCase(),
    product_type: n.productType,
    vendor: n.vendor,
    tags: n.tags || [],
    variants: (n.variants?.nodes || []).map((v) => ({
      id: v.legacyResourceId || registry.numericId(v.id),
      sku: v.sku,
      title: v.title,
      price: v.price,
    })),
  };
}

async function shopifyGraphql(fetchImpl, env, query, variables) {
  const domain = env.SHOPIFY_SHOP_DOMAIN;
  const token = env.SHOPIFY_ADMIN_TOKEN;
  const version = env.SHOPIFY_API_VERSION || "2025-10";
  if (!domain || !token) throw new Error("SHOPIFY_SHOP_DOMAIN and SHOPIFY_ADMIN_TOKEN are required for --from-shopify");
  const res = await fetchImpl(`https://${domain}/admin/api/${version}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) throw new Error(`Shopify GraphQL failed: ${JSON.stringify(body.errors || res.status).slice(0, 300)}`);
  return body.data;
}

/** Every Community-signalled product, plus every product already registered. */
async function fetchShopifyProducts(fetchImpl, env, registeredIds) {
  const out = new Map();
  let after = null;
  for (let page = 0; page < 50; page++) {
    const d = await shopifyGraphql(fetchImpl, env,
      `query($q: String!, $after: String) { products(first: 50, query: $q, after: $after) {
         nodes { ${PRODUCT_FIELDS} } pageInfo { hasNextPage endCursor } } }`,
      { q: COMMUNITY_QUERY, after });
    for (const n of d.products.nodes) out.set(String(n.legacyResourceId), fromGraphqlProduct(n));
    if (!d.products.pageInfo.hasNextPage) break;
    after = d.products.pageInfo.endCursor;
  }
  const missing = registeredIds.filter((id) => !out.has(String(id)));
  for (let i = 0; i < missing.length; i += 50) {
    const ids = missing.slice(i, i + 50).map((id) => registry.productGid(id));
    const d = await shopifyGraphql(fetchImpl, env,
      `query($ids: [ID!]!) { nodes(ids: $ids) { ... on Product { ${PRODUCT_FIELDS} } } }`, { ids });
    d.nodes.forEach((n, k) => {
      const id = registry.numericId(ids[k]);
      // A registered product Shopify no longer has: keep it, mark it deleted.
      out.set(id, n && n.legacyResourceId ? fromGraphqlProduct(n) : { id, __deleted: true });
    });
  }
  return [...out.values()];
}

/** Describe what applying `products` would change, without writing. */
async function plan(q, products) {
  const lines = [];
  for (const p of products) {
    const id = registry.numericId(p.id);
    const { rows } = await q.query(
      `SELECT signals_ok, shopify_status,
              (SELECT count(*)::int FROM community_variants v WHERE v.shopify_product_id = cp.shopify_product_id) AS variants
         FROM community_products cp WHERE shopify_product_id = $1`, [id]);
    const now = rows[0];
    if (p.__deleted) { lines.push(`  ${id}  DELETED in Shopify${now ? " (will be marked deleted)" : " (not registered - ignored)"}`); continue; }
    const sig = registry.productSignals(p);
    const verdict = !sig.length && !now ? "not Community - ignored"
      : !now ? `NEW (${p.variants.length} variants)`
      : !sig.length ? "SIGNALS LOST - lines will go to review"
      : `refresh (${now.variants} -> ${p.variants.length} variants, ${now.shopify_status} -> ${p.status})`;
    lines.push(`  ${id}  ${p.title}  [${p.status}; signals: ${sig.join("+") || "none"}]  ${verdict}`);
  }
  return lines;
}

async function apply(db, products, via) {
  return db.tx(async (c) => {
    let registered = 0;
    for (const p of products) {
      if (p.__deleted) { if (await registry.markProductDeleted(c, p.id)) registered++; continue; }
      const r = await registry.upsertProduct(c, p, via);
      if (r.registered) registered++;
    }
    return registered;
  });
}

async function main() {
  const args = process.argv.slice(2);
  const APPLY = args.includes("--apply");
  const snapIdx = args.indexOf("--snapshot");
  const fromShopify = args.includes("--from-shopify");
  if ((snapIdx < 0) === !fromShopify) {
    console.error("Use exactly one of --snapshot <file> or --from-shopify. Add --apply to write.");
    process.exit(2);
  }
  const db = require("../db");

  let products;
  let via;
  if (snapIdx >= 0) {
    const file = args[snapIdx + 1];
    products = JSON.parse(fs.readFileSync(file, "utf8")).products;
    via = "snapshot";
  } else {
    const { rows } = await db.query(`SELECT shopify_product_id FROM community_products`);
    products = await fetchShopifyProducts(fetch, process.env, rows.map((r) => r.shopify_product_id));
    via = "reconcile";
  }

  console.log(`[community-registry] ${products.length} product(s) from ${via}:`);
  for (const l of await plan(db, products)) console.log(l);

  if (!APPLY) {
    console.log("\n[community-registry] dry run - nothing written. Re-run with --apply.");
  } else {
    const n = await apply(db, products, via);
    const { rows } = await db.query(
      `SELECT (SELECT count(*) FROM community_products) AS products,
              (SELECT count(*) FROM community_variants) AS variants`);
    console.log(`\n[community-registry] applied: ${n} product(s) registered/refreshed. ` +
      `Registry now holds ${rows[0].products} products, ${rows[0].variants} variants.`);
  }
  await db.shutdown();
}

if (require.main === module) {
  main().catch((e) => { console.error("[community-registry] failed:", e.message); process.exit(1); });
}

module.exports = { fromGraphqlProduct, fetchShopifyProducts, plan, apply, COMMUNITY_QUERY };
