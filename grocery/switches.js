// ============================================================================
// ASB PIPELINE — grocery/switches.js
//
// Two production kill switches, each needing BOTH an environment flag and a
// recorded activation (scripts/grocery-activate.js, --by/--reason, audited):
//
//   worker:  GROCERY_SOURCE_WORKER=on  + backfill marker + worker activation
//   bills:   GROCERY_BILL_SEND=on      + bill-send activation
//
// The env flag defaults to OFF and always wins: an emergency stop is one
// Render change. Finishing the backfill never activates anything by itself.
// ============================================================================

"use strict";

const KEYS = {
  backfill: "grocery_backfill_marker",
  worker: "grocery_worker_activation",
  bills: "grocery_bill_send_activation",
};

const envOn = (name) => String(process.env[name] || "off").toLowerCase() === "on";

async function settings(q) {
  const { rows } = await q.query(`SELECT key, value FROM app_settings WHERE key = ANY($1)`, [Object.values(KEYS)]);
  const m = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return { backfill: m[KEYS.backfill] || null, worker: m[KEYS.worker] || null, bills: m[KEYS.bills] || null };
}

/** Everything /healthz and the gates need, in one read. */
async function status(q) {
  const s = await settings(q);
  const workerEnv = envOn("GROCERY_SOURCE_WORKER");
  const billsEnv = envOn("GROCERY_BILL_SEND");
  return {
    worker_env: workerEnv, bills_env: billsEnv,
    backfill_marker: Boolean(s.backfill), worker_activated: Boolean(s.worker), bills_activated: Boolean(s.bills),
    worker_enabled: workerEnv && Boolean(s.backfill) && Boolean(s.worker),
    bills_enabled: billsEnv && Boolean(s.bills),
  };
}

async function workerEnabled(q) {
  if (!envOn("GROCERY_SOURCE_WORKER")) return false;
  return (await status(q)).worker_enabled;
}

async function billsEnabled(q) {
  if (!envOn("GROCERY_BILL_SEND")) return false;
  return (await status(q)).bills_enabled;
}

module.exports = { KEYS, status, workerEnabled, billsEnabled, settings };
