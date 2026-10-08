#!/usr/bin/env node
// ============================================================================
// ASB PIPELINE — scripts/community-registry.js
//
// Bootstrap and reconcile the Community product/variant registry
// (community_products, community_variants - migration 016).
//
// DRY RUN BY DEFAULT. Nothing is written without --apply.
//
//   # ONE-TIME bootstrap from the dated snapshot (no Shopify access needed).
//   # Refused when the registry already holds anything: the snapshot is
//   # bootstrap/recovery material, not ongoing reconciliation.
//   node scripts/community-registry.js --snapshot db/community/registry-snapshot-2026-10-08.json
//   node scripts/community-registry.js --snapshot db/community/registry-snapshot-2026-10-08.json --apply
//   # recovery only - re-apply over a populated registry (audited):
//   node scripts/community-registry.js --snapshot <file> --force-bootstrap --by "Waqas" --reason "..." --apply
//
//   # ongoing refresh is ALWAYS --from-shopify (below).
//
//   # reconcile against live Shopify (needs SHOPIFY_SHOP_DOMAIN, SHOPIFY_ADMIN_TOKEN
//   # with read_products; set SHOPIFY_API_VERSION=2026-10 explicitly in production)
//   node scripts/community-registry.js --from-shopify
//   node scripts/community-registry.js --from-shopify --apply
//
//   # deactivate / reactivate a mistaken registration (guarded, audited)
//   node scripts/community-registry.js --deactivate-product <id> --by "Waqas" --reason "..." [--apply]
//   node scripts/community-registry.js --deactivate-variant <id> --by "Waqas" --reason "..." [--apply]
//   node scripts/community-registry.js --reactivate-product <id> --by "Waqas" --reason "..." [--apply]
//   node scripts/community-registry.js --reactivate-variant <id> --by "Waqas" --reason "..." [--apply]
//
// Deactivation never touches community_intake: lines already captured stay
// Community and go to review. A product can only be deactivated once Shopify
// no longer marks it Community (fix it in Shopify first).
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

// Admin GraphQL API version used when SHOPIFY_API_VERSION is not set. Set it
// explicitly in production (SHOPIFY_API_VERSION=2026-10) so an upgrade of this
// default can never change behaviour silently.
const DEFAULT_API_VERSION = "2026-10";

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
  const version = env.SHOPIFY_API_VERSION || DEFAULT_API_VERSION;
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

/**
 * Apply a dated snapshot as the registry's FIRST content. Refused when either
 * registry table already has rows (a stale snapshot would overwrite newer
 * webhook/reconcile data), unless force is given - which needs an actor, a
 * reason and apply, and is audited. Checked under a table lock, so a webhook
 * cannot register something between the check and the write.
 */
async function bootstrapSnapshot(db, products, { file, apply: doApply = false, force = false, actor, reason } = {}) {
  if (force) {
    registry.requireWho(actor, reason);
    if (!doApply) throw new registry.GuardError("--force-bootstrap needs --apply (there is no forced dry run)");
  }
  const run = async (c) => {
    if (doApply) await c.query(`LOCK TABLE community_products, community_variants IN SHARE ROW EXCLUSIVE MODE`);
    const before = (await c.query(
      `SELECT (SELECT count(*) FROM community_products)::int AS products,
              (SELECT count(*) FROM community_variants)::int AS variants`)).rows[0];
    const populated = before.products > 0 || before.variants > 0;
    if (populated && !force) {
      throw new registry.GuardError(
        `registry already holds ${before.products} products / ${before.variants} variants - the snapshot is ` +
        `bootstrap-only and could overwrite newer data. Use --from-shopify to refresh; ` +
        `--force-bootstrap --by --reason --apply only for recovery.`);
    }
    if (!doApply) return { applied: false, before };
    let registered = 0;
    for (const p of products) {
      const r = await registry.upsertProduct(c, p, "snapshot");
      if (r.registered) registered++;
    }
    const after = (await c.query(
      `SELECT (SELECT count(*) FROM community_products)::int AS products,
              (SELECT count(*) FROM community_variants)::int AS variants`)).rows[0];
    await registry.audit(c, {
      actor: actor || "cli", action: force ? "force_bootstrap_snapshot" : "bootstrap_snapshot",
      targetType: "registry", targetId: file || "snapshot",
      reason: reason || "initial registry bootstrap from dated snapshot", before, after,
    });
    return { applied: true, registered, before, after };
  };
  return doApply ? db.tx(run) : run(db);
}

function argValue(args, flag) {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

async function operatorAction(db, args, APPLY) {
  const by = argValue(args, "--by");
  const reason = argValue(args, "--reason");
  let r;
  if (args.includes("--deactivate-product")) {
    r = await registry.deactivateProduct(db, { productId: argValue(args, "--deactivate-product"), actor: by, reason, apply: APPLY });
  } else if (args.includes("--deactivate-variant")) {
    r = await registry.deactivateVariant(db, { variantId: argValue(args, "--deactivate-variant"), actor: by, reason, apply: APPLY });
  } else if (args.includes("--reactivate-product")) {
    r = await registry.reactivate(db, { kind: "product", id: argValue(args, "--reactivate-product"), actor: by, reason, apply: APPLY });
  } else {
    r = await registry.reactivate(db, { kind: "variant", id: argValue(args, "--reactivate-variant"), actor: by, reason, apply: APPLY });
  }
  console.log(JSON.stringify(r.plan, null, 2));
  console.log(r.applied ? "\n[community-registry] APPLIED and recorded in community_audit."
                        : "\n[community-registry] dry run - nothing written. Re-run with --apply.");
}

const OPERATOR_FLAGS = ["--deactivate-product", "--deactivate-variant", "--reactivate-product", "--reactivate-variant"];

async function main() {
  const args = process.argv.slice(2);
  const APPLY = args.includes("--apply");
  const snapIdx = args.indexOf("--snapshot");
  const fromShopify = args.includes("--from-shopify");
  const operator = OPERATOR_FLAGS.filter((f) => args.includes(f));
  const modes = (snapIdx >= 0 ? 1 : 0) + (fromShopify ? 1 : 0) + operator.length;
  if (modes !== 1) {
    console.error("Use exactly one of --snapshot <file>, --from-shopify, " + OPERATOR_FLAGS.join(", ") +
                  ". Add --apply to write.");
    process.exit(2);
  }
  const db = require("../db");

  if (operator.length) {
    try {
      await operatorAction(db, args, APPLY);
    } catch (e) {
      console.error(`[community-registry] REFUSED: ${e.message}`);
      process.exitCode = 3;
    }
    await db.shutdown();
    return;
  }

  let products;
  let via;
  if (snapIdx >= 0) {
    const file = args[snapIdx + 1];
    products = JSON.parse(fs.readFileSync(file, "utf8")).products;
    console.log(`[community-registry] ${products.length} product(s) from snapshot ${file}:`);
    for (const l of await plan(db, products)) console.log(l);
    try {
      const r = await bootstrapSnapshot(db, products, {
        file, apply: APPLY, force: args.includes("--force-bootstrap"),
        actor: argValue(args, "--by"), reason: argValue(args, "--reason"),
      });
      console.log(r.applied
        ? `\n[community-registry] bootstrap applied (audited): ${r.before.products}/${r.before.variants} -> ` +
          `${r.after.products} products / ${r.after.variants} variants.`
        : `\n[community-registry] dry run - registry currently ${r.before.products} products / ` +
          `${r.before.variants} variants; bootstrap allowed. Re-run with --apply.`);
    } catch (e) {
      console.error(`\n[community-registry] REFUSED: ${e.message}`);
      process.exitCode = 3;
    }
    await db.shutdown();
    return;
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

module.exports = { fromGraphqlProduct, fetchShopifyProducts, plan, apply, bootstrapSnapshot,
                   COMMUNITY_QUERY, DEFAULT_API_VERSION };
