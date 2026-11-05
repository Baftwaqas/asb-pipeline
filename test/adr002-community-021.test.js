// ADR-002 Lane C — migration 021 database guards and the Rate Meter view.
// Needs a scratch Postgres (TEST_PG_URL, default postgres://postgres@localhost:54330).
//   node --test test/adr002-community-021.test.js
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { Client } = require("pg");
const H = require("./support/harness");

const ROOT = path.join(__dirname, "..");
const CYCLE = "MON-2026-11-09";
let db;

before(async () => {
  const url = await H.createDatabase("asb_test_021", ROOT, { grocery: false });
  db = new Client({ connectionString: url });
  await db.connect();
  const w = await db.query(
    `INSERT INTO community_hero_weeks (hero_week_code, cycle_code, canonical_product_id, created_by)
     VALUES ('HW-1', $1, 'ASB-CANON-ONION', 'test') RETURNING id`, [CYCLE]);
  await db.query(
    `INSERT INTO community_hero_tiers (tier_code, hero_week_id, pack_variant_gid, unit, pack_qty,
       ceiling_pack_paisa, unlock_verified_packs, unlock_pack_paisa)
     VALUES ('ONION-10KG', $1, 'gid://shopify/ProductVariant/10', 'g', 10000, 150000, 3, 135000)`, [w.rows[0].id]);
});
after(async () => { if (db) await db.end(); });

const tierId = async (code = "ONION-10KG") => (await db.query("SELECT id FROM community_hero_tiers WHERE tier_code=$1", [code])).rows[0].id;
async function commit(q, line, extra = {}) {
  const t = await tierId();
  const r = await db.query(
    `INSERT INTO community_commitments (commitment_key, quote_id, quote_version, line_id, cycle_code,
       household_key, door, tier_id, packs, ceiling_line_paisa)
     VALUES ($1 || ':1:' || $2, $1, 1, $2, $3, $4, $5, $6, 1, 150000) RETURNING id`,
    [q, line, extra.cycle || CYCLE, extra.household || "hh-1", extra.door || "community_order", t]);
  return r.rows[0].id;
}
const verify = (id) => db.query(
  `UPDATE community_commitments SET status='verified', verified_at=now(), verification_rule_version='E1-test' WHERE id=$1`, [id]);
const meter = async () => (await db.query("SELECT * FROM community_rate_meter WHERE tier_code='ONION-10KG'")).rows[0];

test("021 applies through scripts/migrate.js and the meter starts empty", async () => {
  const m = await meter();
  assert.equal(m.cycle_code, CYCLE);
  assert.equal(Number(m.verified_packs), 0);
  assert.equal(m.unlocked, false);
});

test("F05 an unlock price above the tier ceiling is refused", async () => {
  const w = (await db.query("SELECT id FROM community_hero_weeks WHERE hero_week_code='HW-1'")).rows[0].id;
  await assert.rejects(db.query(
    `INSERT INTO community_hero_tiers (tier_code, hero_week_id, pack_variant_gid, unit, pack_qty,
       ceiling_pack_paisa, unlock_verified_packs, unlock_pack_paisa)
     VALUES ('BAD', $1, 'gid://shopify/ProductVariant/11', 'g', 5000, 80000, 3, 90000)`, [w]),
    /unlock_not_above_ceiling/);
});

test("F02 Apna and Bhao Tao cannot hold commitments", async () => {
  await assert.rejects(commit("Q-apna", "L1", { door: "apna_order" }), /community_commitments_door_check/);
  await assert.rejects(commit("Q-bhao", "L1", { door: "bhao_tao" }), /community_commitments_door_check/);
});

test("T10 a commitment cannot use a tier from another cycle", async () => {
  await assert.rejects(commit("Q-x", "L1", { cycle: "THU-2026-11-12" }), /belongs to cycle/);
});

test("F13 / T0 a replayed commitment is the same row (unique key)", async () => {
  await commit("Q-replay", "L1");
  await assert.rejects(commit("Q-replay", "L1"), /commitment_key/);
});

test("F13 pending does not count; verified does; the meter unlocks at 3 verified packs", async () => {
  const a = await commit("Q-a", "L1", { household: "hh-a" });
  const b = await commit("Q-b", "L1", { household: "hh-b" });
  const c = await commit("Q-c", "L1", { household: "hh-c" });
  const before = await meter();
  assert.equal(Number(before.verified_packs), 0);
  await verify(a); await verify(b);
  assert.equal((await meter()).unlocked, false);
  await verify(c);
  const m = await meter();
  assert.equal(Number(m.verified_packs), 3);
  assert.equal(m.unlocked, true);
});

test("R3 a commitment cannot be verified without its verification event", async () => {
  const id = await commit("Q-noevent", "L1");
  await assert.rejects(db.query("UPDATE community_commitments SET status='verified' WHERE id=$1", [id]),
    /verified_statuses_have_event/);
});

test("R3 the verification event cannot be changed once recorded", async () => {
  const id = await commit("Q-event", "L1");
  await verify(id);
  await assert.rejects(db.query(
    "UPDATE community_commitments SET verification_rule_version='E1-forged' WHERE id=$1", [id]), /cannot change once set/);
});

test("F13 status only moves forward; final states are final", async () => {
  const id = await commit("Q-life", "L1");
  await assert.rejects(db.query("UPDATE community_commitments SET status='paid' WHERE id=$1", [id]), /pending -> paid/);
  await verify(id);
  await db.query("UPDATE community_commitments SET status='locked' WHERE id=$1", [id]);
  await db.query("UPDATE community_commitments SET status='fulfilled' WHERE id=$1", [id]);
  await db.query("UPDATE community_commitments SET status='paid' WHERE id=$1", [id]);
  await assert.rejects(db.query("UPDATE community_commitments SET status='refused' WHERE id=$1", [id]), /paid -> refused/);
  const ev = await db.query("SELECT from_status, to_status FROM community_commitment_events WHERE commitment_id=$1 ORDER BY id", [id]);
  assert.deepEqual(ev.rows.map(r => r.to_status), ["pending", "verified", "locked", "fulfilled", "paid"]);
});

test("committed facts are immutable: a change is a new quote version", async () => {
  const id = await commit("Q-imm", "L1");
  await assert.rejects(db.query("UPDATE community_commitments SET packs=2 WHERE id=$1", [id]), /immutable/);
});

test("commitments, events and tiers are never deleted or truncated", async () => {
  const id = await commit("Q-del", "L1");
  await assert.rejects(db.query("DELETE FROM community_commitments WHERE id=$1", [id]), /never deleted/);
  await assert.rejects(db.query("DELETE FROM community_commitment_events WHERE commitment_id=$1", [id]), /not allowed/);
  await assert.rejects(db.query("DELETE FROM community_hero_tiers"), /not allowed/);
  await assert.rejects(db.query("TRUNCATE community_commitments CASCADE"), /not allowed/);
});

test("a cancelled commitment leaves the verified count unchanged", async () => {
  const before = Number((await meter()).verified_packs);
  const id = await commit("Q-cancel", "L1", { household: "hh-z" });
  await db.query("UPDATE community_commitments SET status='cancelled' WHERE id=$1", [id]);
  const m = await meter();
  assert.equal(Number(m.verified_packs), before);
  assert.ok(Number(m.cancelled_packs) >= 1);
});
