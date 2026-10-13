#!/usr/bin/env node
"use strict";

const reconcile = require("../grocery/compat-bill-reconcile");
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
      console.log(JSON.stringify(await reconcile.apply(db, {
        ...opts, planSha: arg("--plan-sha"), by: arg("--by"), reason: arg("--reason"),
      }), null, 2));
    } else {
      const p = await reconcile.plan(db, opts);
      console.log(JSON.stringify({ dry_run: true, ...p }, null, 2));
      console.log(`\nplan_sha256 ${p.plan_sha256}  (${p.rows.length} compat source(s))`);
    }
  } catch (e) {
    console.error(`[compat-bill-reconcile] REFUSED: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await db.shutdown();
  }
}
if (require.main === module) main();
