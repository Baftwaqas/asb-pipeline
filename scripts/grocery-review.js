#!/usr/bin/env node
// ============================================================================
// ASB PIPELINE — scripts/grocery-review.js   (npm run grocery:review)
//
// Lists grocery sources that need a person, and performs the audited manual
// actions (grocery/operator.js). Every action needs --by, --reason, --apply.
//
//   node scripts/grocery-review.js                         list
//   node scripts/grocery-review.js --action <a> --source <id> --by "Waqas" --reason "..." --apply
//     a: requeue | dismiss [--link-order <id>] | reopen-legacy [--with-bill] |
//        bill-resend | bill-compose | bill-confirm-sent | bill-abandon |
//        bill-hold | bill-release
//   node scripts/grocery-review.js --action link-receipt --attempt <attempt id> --wamid <wamid> --by ... --reason ... --apply
//   node scripts/grocery-review.js --action anomaly-ack --duplicate <id> --by ... --reason ... --apply
// ============================================================================
"use strict";
const op = require("../grocery/operator");

const arg = (n) => { const i = process.argv.indexOf(n); return i > -1 ? process.argv[i + 1] : null; };
const has = (n) => process.argv.includes(n);
const ACTIONS = {
  "requeue": op.requeue, "dismiss": op.dismiss, "reopen-legacy": op.reopenLegacy, "anomaly-ack": op.anomalyAck,
  "bill-resend": op.billResend, "bill-compose": op.billCompose, "bill-confirm-sent": op.billConfirmSent,
  "bill-abandon": op.billAbandon, "bill-hold": op.billHold, "bill-release": op.billRelease, "link-receipt": op.linkReceipt,
};

async function main() {
  const db = require("../db");
  try {
    const a = arg("--action");
    if (!a) {
      console.table(await op.attentionRows(db, { limit: arg("--limit") }));
      return;
    }
    const fn = ACTIONS[a];
    if (!fn) throw new Error(`unknown action ${a}`);
    const args = { sourceId: arg("--source"), duplicateId: arg("--duplicate"), linkOrderId: arg("--link-order"),
                   withBill: has("--with-bill"), wamid: arg("--wamid"), attemptId: arg("--attempt"), by: arg("--by"), reason: arg("--reason") };
    if (!has("--apply")) { console.log(`dry run: ${a} ${JSON.stringify(args)}. Add --apply.`); return; }
    console.log(JSON.stringify(await fn(db, args), null, 2));
  } catch (e) {
    console.error(`[review] REFUSED: ${e.message}`);
    process.exitCode = 1;
  } finally {
    await db.shutdown();
  }
}
if (require.main === module) main();
