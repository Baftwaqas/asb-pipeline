#!/usr/bin/env node
// Test helper: on a FRESH test database, run the real 017 backfill (dry run ->
// approved hash -> apply) and the real activations, as an operator would.
//   node test/support/grocery-ready.js <repoDir> <databaseUrl> [shop]
"use strict";
const path = require("path");
const { Pool } = require("pg");

async function main() {
  const [repoDir, url, shop = "0du4xf-6j.myshopify.com"] = process.argv.slice(2);
  const pool = new Pool({ connectionString: url, max: 2 });
  const db = {
    query: (t, p) => pool.query(t, p),
    tx: async (fn) => {
      const c = await pool.connect();
      try { await c.query("BEGIN"); const r = await fn(c); await c.query("COMMIT"); return r; }
      catch (e) { await c.query("ROLLBACK"); throw e; } finally { c.release(); }
    },
  };
  try {
    const backfill = require(path.join(repoDir, "grocery", "backfill.js"));
    const activation = require(path.join(repoDir, "grocery", "activation.js"));
    const p = await backfill.plan(db, { shop });
    await backfill.apply(db, { shop, by: "test-harness", reason: "fresh test database", planSha: p.plan_sha256 });
    await activation.activate(db, { what: "worker", by: "test-harness", reason: "tests drive the worker" });
    await activation.activate(db, { what: "bills", by: "test-harness", reason: "tests drive the bills" });
  } finally {
    await pool.end();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
