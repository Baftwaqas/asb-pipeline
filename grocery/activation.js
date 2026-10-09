// ============================================================================
// ASB PIPELINE — grocery/activation.js
//
// The recorded half of each kill switch (the other half is the env flag).
// Each activation is a separate, audited decision:
//
//   worker  requires the backfill marker
//   bills   requires the worker activation
//
// Completing the backfill never activates anything.
// ============================================================================

"use strict";

const { KEYS } = require("./switches");
const { LOCK_KEY } = require("./backfill");

const WHAT = {
  worker: { key: KEYS.worker, on: "worker_activation", off: "worker_revocation" },
  bills: { key: KEYS.bills, on: "bill_send_activation", off: "bill_send_revocation" },
};

function need(by, reason) {
  if (!by || !String(by).trim() || !reason || !String(reason).trim()) throw new Error("needs --by and --reason");
}

async function activate(db, { what, by, reason }) {
  const w = WHAT[what];
  if (!w) throw new Error(`unknown switch ${what} (worker | bills)`);
  need(by, reason);
  return db.tx(async (c) => {
    await c.query(`SELECT pg_advisory_xact_lock($1)`, [LOCK_KEY]);
    const have = new Set((await c.query(`SELECT key FROM app_settings WHERE key = ANY($1)`,
                                        [[KEYS.backfill, KEYS.worker, KEYS.bills]])).rows.map((r) => r.key));
    if (what === "worker" && !have.has(KEYS.backfill)) throw new Error("the backfill has not completed - the worker cannot be activated");
    if (what === "bills" && !have.has(KEYS.worker)) throw new Error("activate the worker first");
    if (have.has(w.key)) return { already: true };
    const audit = (await c.query(
      `INSERT INTO shopify_order_source_audit (action, actor, reason) VALUES ($1, $2, $3) RETURNING id`,
      [w.on, by, reason])).rows[0].id;
    await c.query(`INSERT INTO app_settings (key, value) VALUES ($1, $2)`,
                  [w.key, JSON.stringify({ by, reason, at: new Date().toISOString(), audit })]);
    return { activated: what, audit };
  });
}

async function revoke(db, { what, by, reason }) {
  const w = WHAT[what];
  if (!w) throw new Error(`unknown switch ${what} (worker | bills)`);
  need(by, reason);
  return db.tx(async (c) => {
    const r = await c.query(`DELETE FROM app_settings WHERE key = $1`, [w.key]);
    if (!r.rowCount) return { already: true };
    const audit = (await c.query(
      `INSERT INTO shopify_order_source_audit (action, actor, reason) VALUES ($1, $2, $3) RETURNING id`,
      [w.off, by, reason])).rows[0].id;
    return { revoked: what, audit };
  });
}

module.exports = { activate, revoke };
