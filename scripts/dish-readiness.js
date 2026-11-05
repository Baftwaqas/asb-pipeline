#!/usr/bin/env node
// ============================================================================
// ASB PIPELINE — scripts/dish-readiness.js
//
// READ-ONLY. Reads the Recipe Master and Product Master from Shopify and
// reports which recipes Dish-to-Cart could price today, and what blocks the
// rest (unverified recipe lines, unmapped or ambiguous products, missing
// conversions). Writes nothing anywhere.
//
//   SHOPIFY_SHOP_DOMAIN=... SHOPIFY_ADMIN_TOKEN=... SHOPIFY_API_VERSION=2026-10 \
//     node scripts/dish-readiness.js [--json] [--recipe RCP-000007]
//
// The token needs read_products and read_metaobjects only.
// ============================================================================
"use strict";

const kernel = require("../dish/kernel");
const source = require("../dish/recipe-source");
const { loadDishSources } = require("../dish/shopify-read");

const POLICY = Object.freeze({
  version: "DISH-READINESS-1", maxServings: 50, maxRecipes: 10, allowedScalingMethods: ["linear", "fixed"],
});

function adminGraphql(env, fetchImpl = fetch) {
  const domain = env.SHOPIFY_SHOP_DOMAIN, token = env.SHOPIFY_ADMIN_TOKEN;
  const version = env.SHOPIFY_API_VERSION || "2026-10";
  if (!domain || !token) throw new Error("SHOPIFY_SHOP_DOMAIN and SHOPIFY_ADMIN_TOKEN are required");
  return async (query, variables) => {
    if (!/^\s*query\b/.test(query)) throw new Error("dish-readiness: read-only, refusing a non-query");
    const res = await fetchImpl(`https://${domain}/admin/api/${version}/graphql.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
      body: JSON.stringify({ query, variables }),
    });
    const body = await res.json();
    if (!res.ok || body.errors) throw new Error(`Shopify GraphQL failed: ${JSON.stringify(body.errors || res.status).slice(0, 300)}`);
    return body.data;
  };
}

async function run({ graphql, recipeId = null }) {
  const s = await loadDishSources(graphql);
  const { catalog, issues } = source.mapCatalog(s);
  let recipes = source.mapRecipes(s);
  if (recipeId) recipes = { [recipeId]: recipes[recipeId] };
  const report = source.readiness({ recipes, catalog, kernel, policy: POLICY });
  return {
    counts: {
      recipes: report.recipes, ready: report.ready,
      sellableIngredients: Object.keys(catalog).length,
      catalogIssues: issues.length,
    },
    blockedByFirstProblem: report.byFirstProblem,
    catalogIssues: issues,
    recipes: report.rows,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const rIdx = args.indexOf("--recipe");
  const out = await run({ graphql: adminGraphql(process.env), recipeId: rIdx >= 0 ? args[rIdx + 1] : null });
  if (args.includes("--json")) { console.log(JSON.stringify(out, null, 2)); return; }
  console.log(`Dish-to-Cart readiness: ${out.counts.ready} of ${out.counts.recipes} recipes priceable today`);
  console.log(`Sellable ingredient keys: ${out.counts.sellableIngredients}; catalogue issues: ${out.counts.catalogIssues}`);
  console.log("Blocked recipes by first problem:");
  for (const [k, v] of Object.entries(out.blockedByFirstProblem).sort((a, b) => b[1] - a[1])) console.log(`  ${v}\t${k}`);
  const byCode = {};
  for (const i of out.catalogIssues) byCode[i.code] = (byCode[i.code] || 0) + 1;
  console.log("Catalogue issues:", byCode);
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { run, adminGraphql, POLICY };
