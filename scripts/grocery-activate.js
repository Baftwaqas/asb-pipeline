#!/usr/bin/env node
// ============================================================================
// ASB PIPELINE — scripts/grocery-activate.js   (npm run grocery:activate)
//
// The recorded half of a kill switch. Each is a separate, explicit decision.
//
//   node scripts/grocery-activate.js --status
//   node scripts/grocery-activate.js --worker --by "Waqas" --reason "..." --apply
//   node scripts/grocery-activate.js --bills  --by "Waqas" --reason "..." --apply
//   node scripts/grocery-activate.js --revoke --worker|--bills --by ... --reason ... --apply
//
// The env flags GROCERY_SOURCE_WORKER / GROCERY_BILL_SEND must ALSO be "on".
// ============================================================================
"use strict";
const activation = require("../grocery/activation");
const switches = require("../grocery/switches");

const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
const has = (n) => process.argv.includes(n);

async function main() {
  const db = require("../db");
  try {
    const what = has("--worker") ? "worker" : has("--bills") ? "bills" : null;
    if (has("--status") || !what) {
      console.log(JSON.stringify(await switches.status(db), null, 2));
    } else if (!has("--apply")) {
      console.log(`dry run: would ${has("--revoke") ? "revoke" : "activate"} ${what}. Add --apply.`);
      console.log(JSON.stringify(await switches.status(db), null, 2));
    } else {
      const fn = has("--revoke") ? activation.revoke : activation.activate;
      console.log(JSON.stringify(await fn(db, { what, by: arg("--by"), reason: arg("--reason") }), null, 2));
    }
  } catch (e) {
    console.error(`[activate] REFUSED: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await db.shutdown();
  }
}
if (require.main === module) main();
