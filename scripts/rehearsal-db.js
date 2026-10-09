#!/usr/bin/env node
// ============================================================================
// ASB PIPELINE — scripts/rehearsal-db.js
//
// Safety gate for a Neon REHEARSAL branch (a copy of production). Nothing here
// is used in production.
//
// Every mode first checks the host in DATABASE_URL, BEFORE connecting:
//   * EXPECTED_REHEARSAL_DB_HOST must be supplied and equal it EXACTLY;
//   * PRODUCTION_DB_HOST must be supplied, and neither the host nor its Neon
//     endpoint id (ep-..., with or without -pooler) may match production's;
//   * a pooled (-pooler) host is refused - the rehearsal uses the DIRECT one.
// Marking production as 'rehearsal' would silently suppress every production
// push notification, so the write is impossible unless all of that holds.
//
//   node scripts/rehearsal-db.js --check                   read-only: host + marker
//   node scripts/rehearsal-db.js --mark                    dry run: host, current marker
//   node scripts/rehearsal-db.js --mark --apply            write asb_environment='rehearsal'
//   node scripts/rehearsal-db.js --assert-source <id>      read-only: --check + the source is a
//   node scripts/rehearsal-db.js --assert-attempt <id>       rehearsal order (#REH-...), found
//   node scripts/rehearsal-db.js --assert-duplicate <id>     directly or via the attempt/duplicate
//
// Exit 0 = OK, 2 = REFUSED (nothing written).
// ============================================================================

"use strict";

class Refused extends Error {}

const endpointId = (host) => String(host).toLowerCase().split(".")[0].replace(/-pooler$/, "");

/** Pure host check. Returns the verified host; throws Refused. */
function checkHost({ databaseUrl, expectedHost, productionHost }) {
  if (!databaseUrl) throw new Refused("DATABASE_URL is not set");
  if (!expectedHost || !String(expectedHost).trim()) throw new Refused("EXPECTED_REHEARSAL_DB_HOST is not set");
  if (!productionHost || !String(productionHost).trim()) throw new Refused("PRODUCTION_DB_HOST is not set (the known production endpoint host)");
  let actual;
  try { actual = new URL(databaseUrl).hostname.toLowerCase(); } catch { throw new Refused("DATABASE_URL is not a valid URL"); }
  const expected = String(expectedHost).trim().toLowerCase();
  const production = String(productionHost).trim().toLowerCase();
  if (actual === production || endpointId(actual) === endpointId(production)) {
    throw new Refused(`DATABASE_URL points at the PRODUCTION endpoint (${actual})`);
  }
  if (expected === production || endpointId(expected) === endpointId(production)) {
    throw new Refused("EXPECTED_REHEARSAL_DB_HOST is the production endpoint");
  }
  if (actual !== expected) {
    throw new Refused(`DATABASE_URL host ${actual} does not exactly match EXPECTED_REHEARSAL_DB_HOST ${expected}`);
  }
  if (/-pooler\./.test(actual)) throw new Refused(`${actual} is a pooled host - use the rehearsal branch's DIRECT connection`);
  return actual;
}

async function marker(db) {
  return (await db.query(`SELECT value FROM app_settings WHERE key = 'asb_environment'`)).rows[0]?.value ?? null;
}

const REH = `shopify_order_name LIKE '#REH-%'`;
const SOURCE_OF = {
  source: `SELECT id, shopify_order_name, (${REH}) AS rehearsal FROM shopify_order_sources WHERE id = $1`,
  attempt: `SELECT s.id, s.shopify_order_name, (s.${REH}) AS rehearsal FROM shopify_order_bill_attempts a
              JOIN shopify_order_sources s ON s.id = a.source_id WHERE a.id = $1`,
  duplicate: `SELECT s.id, s.shopify_order_name, (s.${REH}) AS rehearsal FROM shopify_order_source_duplicates d
                JOIN shopify_order_sources s ON s.id = d.source_id WHERE d.id = $1`,
};

/** Runs one mode. db is required lazily, only after the host check passed. */
async function run(argv, env = process.env, { log = console.log, getDb = () => require("../db") } = {}) {
  const has = (n) => argv.includes(n);
  const arg = (n) => { const i = argv.indexOf(n); return i > -1 ? argv[i + 1] : null; };
  const host = checkHost({ databaseUrl: env.DATABASE_URL, expectedHost: env.EXPECTED_REHEARSAL_DB_HOST,
                           productionHost: env.PRODUCTION_DB_HOST });
  log(`[rehearsal-db] host ${host} = EXPECTED_REHEARSAL_DB_HOST, endpoint ${endpointId(host)} is not production (${endpointId(env.PRODUCTION_DB_HOST)})`);
  const db = getDb();
  if (has("--mark")) {
    const before = await marker(db);
    log(`[rehearsal-db] asb_environment now: ${before === null ? "(not set)" : `'${before}'`}`);
    if (!has("--apply")) { log("[rehearsal-db] dry run - add --apply to write asb_environment='rehearsal'"); return { host, marker: before, wrote: false }; }
    await db.query(
      `INSERT INTO app_settings (key, value) VALUES ('asb_environment', 'rehearsal')
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`);
    const after = await marker(db);
    log(`[rehearsal-db] wrote asb_environment = '${after}'`);
    return { host, marker: after, wrote: true };
  }
  const m = await marker(db);
  if (m !== "rehearsal") throw new Refused(`database is not marked as a rehearsal copy (asb_environment = ${m === null ? "not set" : `'${m}'`})`);
  const has017 = (await db.query(`SELECT to_regclass('public.shopify_order_sources') IS NOT NULL AS x`)).rows[0].x;
  log(`[rehearsal-db] asb_environment = 'rehearsal', migration 017 present: ${has017}`);
  for (const kind of ["source", "attempt", "duplicate"]) {
    const id = arg(`--assert-${kind}`);
    if (id === null) continue;
    if (!/^\d+$/.test(String(id))) throw new Refused(`--assert-${kind} needs a numeric id`);
    const row = (await db.query(SOURCE_OF[kind], [id])).rows[0];
    if (!row) throw new Refused(`${kind} ${id} not found`);
    if (!row.rehearsal) throw new Refused(`${kind} ${id} belongs to source ${row.id} (${row.shopify_order_name}) - NOT a rehearsal order (#REH-...)`);
    log(`[rehearsal-db] OK: ${kind} ${id} -> source ${row.id} ${row.shopify_order_name}`);
    return { host, marker: m, has017, source: row };
  }
  return { host, marker: m, has017 };
}

async function main() {
  let db = null;
  try {
    await run(process.argv.slice(2), process.env, { getDb: () => (db = require("../db")) });
    process.exitCode = 0;
  } catch (e) {
    console.error(`[rehearsal-db] ${e instanceof Refused ? "REFUSED" : "failed"}: ${e.message}`);
    process.exitCode = 2;
  } finally {
    if (db) await db.shutdown();
  }
}

if (require.main === module) main();

module.exports = { checkHost, endpointId, run, Refused };
