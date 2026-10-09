// ============================================================================
// ASB PIPELINE — grocery/worker.js
//
// Runs the grocery pipeline after the 200, durably:
//
//   kick(db, sourceId)  right after a webhook's capture commits: apply that
//                       order, then send its bill - same latency as before.
//   start(db)           the sweeper (boot + every GROCERY_SWEEP_MS):
//                         * expired leases       -> retryable_error / review
//                         * due received/retry   -> apply        (worker switch)
//                         * due pending bills    -> send         (bill switch)
//                         * claims never closed  -> unknown      (always)
//                         * unapplied receipts   -> replay       (always)
//                         * unlinked receipts    -> alert        (always)
//                         * pending alerts       -> deliver      (always)
//
// Single-flight per process; claims are row-level, so a kick and a sweep (or
// two instances during a deploy overlap) never apply or send the same thing
// twice.
// ============================================================================

"use strict";

const apply = require("./apply");
const billing = require("./billing");
const receipts = require("./receipts");
const alerts = require("./alerts");
const switches = require("./switches");

async function runSource(db, sourceId) {
  if (!(await switches.workerEnabled(db))) return null;
  const outcome = await apply.processSource(db, sourceId);
  if (outcome === "applied") await billing.processBill(db, sourceId);
  return outcome;
}

/** Fire-and-forget after the 200. */
function kick(db, sourceId) {
  if (!sourceId) return;
  setImmediate(() => {
    runSource(db, sourceId).catch((e) => console.error(`[grocery] kick for source ${sourceId} failed: ${e.message}`));
  });
}

async function runOnce(db, { limit = 50 } = {}) {
  const tally = { expired: 0, applied: 0, bills: 0, claims_expired: 0, receipts: 0, unlinked: 0, alerts: 0 };
  tally.expired = await apply.expireLeases(db);

  const st = await switches.status(db);
  if (st.worker_enabled) {
    const { rows } = await db.query(
      `SELECT id FROM shopify_order_sources
        WHERE status IN ('received','retryable_error') AND next_attempt_at <= now()
        ORDER BY id LIMIT $1`, [limit]);
    for (const r of rows) {
      const o = await apply.processSource(db, r.id);
      if (o) tally.applied++;
    }
  }
  if (st.bills_enabled) {
    const { rows } = await db.query(
      `SELECT id FROM shopify_order_sources
        WHERE bill_state = 'pending' AND bill_hold_reason IS NULL
          AND (bill_next_attempt_at IS NULL OR bill_next_attempt_at <= now())
        ORDER BY id LIMIT $1`, [limit]);
    for (const r of rows) if (await billing.processBill(db, r.id)) tally.bills++;
  }
  tally.claims_expired = await billing.expireClaims(db);
  tally.receipts = await receipts.replay(db);
  tally.unlinked = await receipts.alertUnlinked(db);
  tally.alerts = (await alerts.dispatch(db)).sent;
  if (Object.values(tally).some(Boolean)) console.log(`[grocery] sweep: ${JSON.stringify(tally)}`);
  return tally;
}

let sweeping = null;
let again = false;
function sweep(db) {
  if (sweeping) { again = true; return sweeping; }
  sweeping = (async () => {
    try {
      do { again = false; await runOnce(db); } while (again);
    } catch (e) {
      console.error("[grocery] sweep failed:", e.message);
    } finally {
      sweeping = null;
    }
  })();
  return sweeping;
}

/** Always started: the switches gate the work inside each sweep. */
function start(db, { intervalMs = Number(process.env.GROCERY_SWEEP_MS || 60_000) } = {}) {
  setImmediate(() => sweep(db));
  const t = setInterval(() => sweep(db), intervalMs);
  t.unref();
  console.log(`[grocery] sweeper every ${Math.round(intervalMs / 1000)}s ` +
              `(GROCERY_SOURCE_WORKER=${process.env.GROCERY_SOURCE_WORKER || "off"}, ` +
              `GROCERY_BILL_SEND=${process.env.GROCERY_BILL_SEND || "off"})`);
  return t;
}

module.exports = { kick, runSource, runOnce, sweep, start };
