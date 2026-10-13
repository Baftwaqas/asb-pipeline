#!/usr/bin/env node
// ============================================================================
// ASB PIPELINE — scripts/grocery-rollback-reconcile.js
//
// Dry run:
//   node scripts/grocery-rollback-reconcile.js --shop <x.myshopify.com> --from <ISO> --to <ISO>
//
// Apply an explicitly approved plan:
//   node scripts/grocery-rollback-reconcile.js --shop <x> --from <ISO> --to <ISO> \\
//     --apply --plan-sha <hash> --by "Waqas" --reason "L3 rollback window recovery"
//
// The window is [from,to), max 72h. The original 017 backfill marker MUST
// already exist. Review rows are reported but never changed automatically.
// ============================================================================
"use strict";

const reconcile = require("../grocery/rollback-reconcile");
const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };

async function main() {
  const db = require("../db");
  const opts = {
    shop: arg("--shop") || process.env.SHOPIFY_SHOP_DOMAIN,
    from: arg("--from"),
    to: arg("--to"),
  };
  try {
    if (process.argv.includes("--apply")) {
      const r = await reconcile.apply(db, {
        ...opts, planSha: arg("--plan-sha"), by: arg("--by"), reason: arg("--reason"),
      });
      console.log(JSON.stringify(r, null, 2));
    } else {
      const p = await reconcile.plan(db, opts);
      console.log(JSON.stringify({ dry_run: true, ...p }, null, 2));
      console.log(`\nplan_sha256 ${p.plan_sha256}  (${p.rows.length} candidate order(s))`);
    }
  } catch (e) {
    console.error(`[rollback-reconcile] REFUSED: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await db.shutdown();
  }
}
if (require.main === module) main();
