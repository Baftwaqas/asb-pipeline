#!/usr/bin/env node
// ============================================================================
// ASB PIPELINE — scripts/grocery-backfill.js   (npm run grocery:backfill)
//
// Maps every Shopify order the pre-017 code handled, so it is never applied or
// billed again (grocery/backfill.js explains the rules).
//
//   node scripts/grocery-backfill.js --shop <x.myshopify.com>            dry run: rows + plan_sha256
//   node scripts/grocery-backfill.js --shop <x> --apply --plan-sha <hash> --by "Waqas" --reason "..."
//
// --shop defaults to SHOPIFY_SHOP_DOMAIN. The apply refuses unless the plan
// computed at that moment has exactly the approved hash. It runs in one
// transaction and writes the readiness marker last. It does NOT activate the
// worker: that is scripts/grocery-activate.js, a separate approval.
// ============================================================================
"use strict";
const backfill = require("../grocery/backfill");

const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };

async function main() {
  const db = require("../db");
  const shop = arg("--shop") || process.env.SHOPIFY_SHOP_DOMAIN;
  try {
    if (process.argv.includes("--apply")) {
      const r = await backfill.apply(db, { shop, by: arg("--by"), reason: arg("--reason"), planSha: arg("--plan-sha") });
      console.log(JSON.stringify(r, null, 2));
    } else {
      const p = await backfill.plan(db, { shop });
      console.log(JSON.stringify({ dry_run: true, marker: await backfill.markerOf(db), ...p }, null, 2));
      console.log(`\nplan_sha256 ${p.plan_sha256}  (${p.rows.length} row(s))`);
    }
  } catch (e) {
    console.error(`[backfill] REFUSED: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await db.shutdown();
  }
}
if (require.main === module) main();
