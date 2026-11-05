// ADR-002 Lane C — migration 023: Community Order locks with the weekly price
// lock (asb_lock_cycle), atomically, and prices every line at lock.
// Needs a scratch Postgres (TEST_PG_URL, default postgres://postgres@localhost:54330).
//   node --test test/adr002-community-023.test.js
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { Client } = require("pg");
const H = require("./support/harness");
const kernel = require("../community/kernel");

const ROOT = path.join(__dirname, "..");
let db, n = 0;

before(async () => {
  const url = await H.createDatabase("asb_test_023", ROOT, { grocery: false });
  db = new Client({ connectionString: url });
  await db.connect();
});
after(async () => { if (db) await db.end(); });

const q = (sql, args) => db.query(sql, args);
const sleep = (ms) => q(`SELECT pg_sleep(${ms / 1000})`);

/** A grocery cycle whose cutoff is `ms` from now, plus one Hero tier on it. */
async function cycleWithTier({ ms = 1500, unlockPacks = 3, unlockPaisa = 70000, ceiling = 80000 } = {}) {
  n += 1;
  const code = "CYC-" + n;
  const c = (await q(
    `INSERT INTO cycles (code, cycle_date, opens_at, locks_at, delivery_date, status)
     VALUES ($1, current_date, now() - interval '1 day', clock_timestamp() + ($2 || ' milliseconds')::interval,
             current_date + 1, 'open') RETURNING id, locks_at`, [code, String(ms)])).rows[0];
  const w = (await q(
    `INSERT INTO community_hero_weeks (hero_week_code, cycle_code, canonical_product_id, created_by)
     VALUES ($1, $2, 'ASB-CANON-ONION', 'test') RETURNING id`, ["HW-" + code, code])).rows[0].id;
  const tier = (await q(
    `INSERT INTO community_hero_tiers (tier_code, hero_week_id, pack_variant_gid, unit, pack_qty, max_packs_per_line,
       ceiling_pack_paisa, unlock_verified_packs, unlock_pack_paisa)
     VALUES ($1, $2, 'gid://shopify/ProductVariant/77', 'g', 5000, 4, $3, $4, $5) RETURNING id`,
    ["T-" + code, w, ceiling, unlockPacks, unlockPaisa])).rows[0].id;
  return { code, id: c.id, locksAt: c.locks_at, tier, ceiling };
}

async function commit(cyc, quote, packs, { door = "community_order", locks = null } = {}) {
  return (await q(
    `INSERT INTO community_commitments (commitment_key, quote_id, quote_version, line_id, cycle_code, locks_at,
       household_key, door, tier_id, packs, ceiling_line_paisa)
     VALUES ($1 || ':1:L1', $1, 1, 'L1', $2, COALESCE($3::timestamptz, (SELECT locks_at FROM cycles WHERE code = $2)),
             $4, $5, $6, $7, $8) RETURNING id`,
    [quote, cyc.code, locks, "hh-" + quote, door, cyc.tier, packs, packs * cyc.ceiling])).rows[0].id;
}

async function verify(id, { flagged = false } = {}) {
  const c = (await q(`SELECT quote_id, quote_version, household_key, clock_timestamp() AS now
                        FROM community_commitments WHERE id = $1`, [id])).rows[0];
  const at = (ms) => new Date(new Date(c.now).getTime() + ms).toISOString();
  const e = {
    order: { quoteId: c.quote_id, quoteVersion: c.quote_version, acceptedAt: at(-60000) },
    whatsapp: { quoteId: c.quote_id, quoteVersion: c.quote_version, action: "confirm",
                confirmationTokenId: "tok-" + id, receivedAt: at(-30000) },
    address: { householdKey: c.household_key }, risk: { flagged },
  };
  return q(`SELECT community_verify_commitment($1, 'ADR-002-VERIFY-001', $2::jsonb, 'ops-reviewer-1')`, [id, JSON.stringify(e)]);
}

const lockCycle = (cyc) => q(`SELECT * FROM asb_lock_cycle($1)`, [cyc.id]);
const lines = async (cyc) => (await q(
  `SELECT quote_id, counted, door_eligible, tier_unlocked, price_basis, locked_pack_paisa::int AS pack,
          locked_line_paisa::int AS line, ceiling_line_paisa::int AS ceil
     FROM community_cycle_lock_lines WHERE cycle_code = $1 ORDER BY quote_id`, [cyc.code])).rows;

test("SQL threshold equals the kernel's (Rs 1,200 at ceiling)", async () => {
  assert.equal(Number((await q("SELECT community_threshold_paisa() AS t")).rows[0].t), kernel.THRESHOLD_PAISA);
});

test("asb_lock_cycle locks Community in the same transaction and prices every line", async () => {
  const cyc = await cycleWithTier(); // unlock at 3 verified packs: Rs 800 -> Rs 700 per pack
  const a = await commit(cyc, "QA", 2);  // 2 x Rs 800 = Rs 1,600 >= Rs 1,200 -> eligible
  const b = await commit(cyc, "QB", 1);  // Rs 800 < Rs 1,200 -> counts for the meter, pays ceiling
  const c = await commit(cyc, "QC", 2);  // never confirmed
  const d = await commit(cyc, "QD", 2);  // risk-flagged, still under review
  await verify(a); await verify(b); await verify(d, { flagged: true });
  const pricesBefore = (await q("SELECT count(*)::int n FROM cycle_prices")).rows[0].n;
  await sleep(1700);
  await lockCycle(cyc);

  assert.equal((await q("SELECT status::text FROM cycles WHERE id=$1", [cyc.id])).rows[0].status, "locked");
  const m = (await q("SELECT locked_verified_packs, locked_unlocked, locked_pack_paisa::int p FROM community_meter_locks WHERE cycle_code=$1",
    [cyc.code])).rows[0];
  assert.deepEqual([m.locked_verified_packs, m.locked_unlocked, m.p], [3, true, 70000]); // pending/under-review count 0
  assert.deepEqual(await lines(cyc), [
    { quote_id: "QA", counted: true, door_eligible: true, tier_unlocked: true, price_basis: "tier_unlocked", pack: 70000, line: 140000, ceil: 160000 },
    { quote_id: "QB", counted: true, door_eligible: false, tier_unlocked: true, price_basis: "ceiling_door_not_eligible", pack: 80000, line: 80000, ceil: 80000 },
    { quote_id: "QC", counted: false, door_eligible: false, tier_unlocked: true, price_basis: "not_verified", pack: 80000, line: 160000, ceil: 160000 },
    { quote_id: "QD", counted: false, door_eligible: false, tier_unlocked: true, price_basis: "not_verified", pack: 80000, line: 160000, ceil: 160000 },
  ]);
  const f = (await q("SELECT quote_id, fulfillment_state FROM community_commitments WHERE cycle_code=$1 ORDER BY quote_id",
    [cyc.code])).rows.map((r) => r.quote_id + ":" + r.fulfillment_state);
  assert.deepEqual(f, ["QA:locked", "QB:locked", "QC:none", "QD:none"]);
  // 016 isolation: Community never enters the grocery price book.
  assert.equal((await q("SELECT count(*)::int n FROM cycle_prices")).rows[0].n, pricesBefore);
  const t = (await q("SELECT * FROM community_cycle_household_totals WHERE cycle_code=$1 AND quote_id='QA'", [cyc.code])).rows[0];
  assert.deepEqual([Number(t.locked_paisa), Number(t.community_saving_paisa)], [140000, 20000]);
});

test("tier not unlocked: everyone pays the ceiling, eligible or not", async () => {
  const cyc = await cycleWithTier({ unlockPacks: 10 });
  const a = await commit(cyc, "QE", 2);
  await verify(a);
  await sleep(1700);
  await lockCycle(cyc);
  const [l] = await lines(cyc);
  assert.deepEqual([l.price_basis, l.line], ["ceiling_tier_not_unlocked", 160000]);
});

test("eligibility is per door: Rs 800 Community + Rs 800 Dish in one quote does not reach Rs 1,200", async () => {
  const cyc = await cycleWithTier({ unlockPacks: 1 });
  // two lines of one quote, different doors
  const a = (await q(
    `INSERT INTO community_commitments (commitment_key, quote_id, quote_version, line_id, cycle_code, locks_at,
       household_key, door, tier_id, packs, ceiling_line_paisa)
     SELECT v.k, 'QF', 1, v.l, $1, cy.locks_at, 'hh-QF', v.d, $2, 1, 80000
       FROM cycles cy, (VALUES ('QF:1:L1','L1','community_order'), ('QF:1:L2','L2','dish_to_cart')) v(k, l, d)
      WHERE cy.code = $1 RETURNING id`,
    [cyc.code, cyc.tier])).rows.map((r) => r.id);
  for (const id of a) await verify(id);
  await sleep(1700);
  await lockCycle(cyc);
  assert.deepEqual((await lines(cyc)).map((l) => l.price_basis), ["ceiling_door_not_eligible", "ceiling_door_not_eligible"]);
});

test("a Community cycle cannot lock before its cutoff; grocery lock rolls back with it", async () => {
  const cyc = await cycleWithTier({ ms: 3600e3 });
  await commit(cyc, "QG", 2);
  await assert.rejects(lockCycle(cyc), /has Community demand and its cutoff/);
  assert.equal((await q("SELECT status::text FROM cycles WHERE id=$1", [cyc.id])).rows[0].status, "open");
  assert.equal((await q("SELECT count(*)::int n FROM community_meter_locks WHERE cycle_code=$1", [cyc.code])).rows[0].n, 0);
});

test("a commitment whose cutoff differs from the cycle's is refused at insert, and at lock if the cycle moved", async () => {
  const cyc = await cycleWithTier();
  const other = (await q("SELECT (locks_at + interval '200 milliseconds') AS t FROM cycles WHERE id=$1", [cyc.id])).rows[0].t;
  await assert.rejects(commit(cyc, "QH", 1, { locks: other }), /differs from cycle/);
  await commit(cyc, "QH2", 1);
  await q("UPDATE cycles SET locks_at = locks_at - interval '1 second' WHERE id=$1", [cyc.id]); // cutoff moved
  await sleep(1700);
  await assert.rejects(lockCycle(cyc), /reconcile before locking/);
  assert.equal((await q("SELECT status::text FROM cycles WHERE id=$1", [cyc.id])).rows[0].status, "open");
});

test("unlock + relock reuses the frozen snapshot; a later refusal never revokes the price", async () => {
  const cyc = await cycleWithTier({ unlockPacks: 2 });
  const a = await commit(cyc, "QI", 2);
  await verify(a);
  await sleep(1700);
  await lockCycle(cyc);
  const first = await lines(cyc);
  // refusal at the door, then a grocery correction unlocks and relocks the cycle
  await q("UPDATE community_commitments SET fulfillment_state='refused' WHERE id=$1", [a]);
  await q("SELECT asb_unlock_cycle($1, 'grocery price correction')", [cyc.id]);
  await lockCycle(cyc);
  assert.deepEqual(await lines(cyc), first);
  const r = (await q("SELECT * FROM community_lock_cycle($1, 'ops')", [cyc.code])).rows[0];
  assert.equal(r.reused, true);
  await assert.rejects(q("UPDATE community_cycle_lock_lines SET locked_line_paisa=1 WHERE cycle_code=$1", [cyc.code]), /not allowed/);
  await assert.rejects(q("DELETE FROM community_cycle_lock_lines WHERE cycle_code=$1", [cyc.code]), /not allowed/);
});

test("a cycle with no Community demand locks exactly as before", async () => {
  n += 1;
  const c = (await q(
    `INSERT INTO cycles (code, cycle_date, opens_at, locks_at, delivery_date, status)
     VALUES ($1, current_date, now() - interval '1 day', now() + interval '1 day', current_date + 1, 'open') RETURNING id`,
    ["PLAIN-" + n])).rows[0];
  await q("SELECT * FROM asb_lock_cycle($1)", [c.id]); // even before its cutoff, as today
  assert.equal((await q("SELECT status::text FROM cycles WHERE id=$1", [c.id])).rows[0].status, "locked");
});

test("no locked line exceeds its accepted ceiling (DB constraint)", async () => {
  const def = (await q(`SELECT pg_get_constraintdef(oid) d FROM pg_constraint WHERE conname='locked_line_within_ceiling'`)).rows[0].d;
  assert.match(def, /locked_line_paisa <= ceiling_line_paisa/);
});
