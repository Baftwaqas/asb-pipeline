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
const LOCKS = "2026-11-08T15:00:00Z"; // Sunday 8 pm PKT
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
     VALUES ('ONION-5KG', $1, 'gid://shopify/ProductVariant/5', 'g', 5000, 80000, 4, 72000)`, [w.rows[0].id]);
});
after(async () => { if (db) await db.end(); });

const tierId = async () => (await db.query("SELECT id FROM community_hero_tiers WHERE tier_code='ONION-5KG'")).rows[0].id;
async function commit(q, version, packs, extra = {}) {
  const t = await tierId();
  const r = await db.query(
    `INSERT INTO community_commitments (commitment_key, quote_id, quote_version, line_id, cycle_code, locks_at,
       household_key, door, tier_id, packs, ceiling_line_paisa)
     VALUES ($1::text || ':' || $2::int || ':L1', $1, $2::int, 'L1', $3, $4, $5, $6, $7, $8::int, 80000 * $8::int) RETURNING id`,
    [q, version, extra.cycle || CYCLE, LOCKS, extra.household || "hh-" + q, extra.door || "community_order", t, packs]);
  return r.rows[0].id;
}
const verify = (id, at = "2026-11-07T11:00:00Z") => db.query(
  `UPDATE community_commitments SET verification_state='verified', verified_at=$2,
     verification_policy_version='ADR-002-VERIFY-001' WHERE id=$1`, [id, at]);
const meter = async () => (await db.query("SELECT * FROM community_rate_meter WHERE tier_code='ONION-5KG'")).rows[0];
const verifiedKg = async () => Number((await meter()).verified_packs) * 5;

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
     VALUES ('BAD', $1, 'gid://shopify/ProductVariant/11', 'g', 5000, 80000, 3, 90000)`, [w]), /unlock_not_above_ceiling/);
});

test("F02 Apna and Bhao Tao cannot hold commitments", async () => {
  await assert.rejects(commit("Q-apna", 1, 1, { door: "apna_order" }), /door_check/);
  await assert.rejects(commit("Q-bhao", 1, 1, { door: "bhao_tao" }), /door_check/);
});

test("T10 a commitment cannot use a tier from another cycle", async () => {
  await assert.rejects(commit("Q-x", 1, 1, { cycle: "THU-2026-11-12" }), /belongs to cycle/);
});

test("policy test 1: a pending reservation contributes 0 kg", async () => {
  const before = await verifiedKg();
  await commit("Q-pending", 1, 2);
  assert.equal(await verifiedKg(), before);
  assert.ok(Number((await meter()).pending_packs) >= 2);
});

test("policy test 2: a replayed commitment is the same row (unique key)", async () => {
  await commit("Q-replay", 1, 1);
  await assert.rejects(commit("Q-replay", 1, 1), /commitment_key/);
});

test("ChatGPT caution 3: v1 10 kg verified, edited to v2 5 kg verified -> meter counts 5 kg once", async () => {
  const base = await verifiedKg();
  const v1 = await commit("Q-edit", 1, 2);
  await verify(v1);
  assert.equal(await verifiedKg(), base + 10);
  // inserting v2 while v1 is live is refused: no silent double count
  await assert.rejects(commit("Q-edit", 2, 1), /live older version/);
  await db.query("BEGIN");
  const n = (await db.query("SELECT community_supersede_quote('Q-edit', 2) AS n")).rows[0].n;
  const v2 = await commit("Q-edit", 2, 1);
  await db.query("COMMIT");
  assert.equal(n, 1);
  assert.equal(await verifiedKg(), base, "policy test 3: the edited version counts 0 until re-confirmed");
  await verify(v2);
  assert.equal(await verifiedKg(), base + 5);
  const old = (await db.query("SELECT verification_state, superseded_by_version FROM community_commitments WHERE id=$1", [v1])).rows[0];
  assert.deepEqual(old, { verification_state: "cancelled", superseded_by_version: 2 });
  await assert.rejects(commit("Q-edit", 1, 9), /commitment_key|newer version/);
});

test("policy test 5: a quote chain cannot move to another cycle", async () => {
  const w = await db.query(
    `INSERT INTO community_hero_weeks (hero_week_code, cycle_code, canonical_product_id, created_by)
     VALUES ('HW-THU', 'THU-2026-11-12', 'ASB-CANON-ONION', 'test') RETURNING id`);
  await db.query(
    `INSERT INTO community_hero_tiers (tier_code, hero_week_id, pack_variant_gid, unit, pack_qty, ceiling_pack_paisa)
     VALUES ('ONION-5KG-THU', $1, 'gid://shopify/ProductVariant/5', 'g', 5000, 80000)`, [w.rows[0].id]);
  await commit("Q-cyc", 1, 1);
  await db.query("SELECT community_supersede_quote('Q-cyc', 2)");
  const thuTier = (await db.query("SELECT id FROM community_hero_tiers WHERE tier_code='ONION-5KG-THU'")).rows[0].id;
  await assert.rejects(db.query(
    `INSERT INTO community_commitments (commitment_key, quote_id, quote_version, line_id, cycle_code, locks_at,
       household_key, door, tier_id, packs, ceiling_line_paisa)
     VALUES ('Q-cyc:2:L1', 'Q-cyc', 2, 'L1', 'THU-2026-11-12', '2026-11-11T15:00:00Z', 'hh', 'community_order', $1, 1, 80000)`,
    [thuTier]), /another cycle/);
});

test("policy test 4: under_review counts 0; verified after review counts", async () => {
  const base = await verifiedKg();
  const id = await commit("Q-review", 1, 1);
  await db.query("UPDATE community_commitments SET verification_state='under_review' WHERE id=$1", [id]);
  assert.equal(await verifiedKg(), base);
  await verify(id);
  assert.equal(await verifiedKg(), base + 5);
});

test("policy test 4: verification after lock is refused", async () => {
  const id = await commit("Q-late", 1, 1);
  await assert.rejects(verify(id, "2026-11-08T15:00:01Z"), /verified_before_lock/);
});

test("R3 verified needs its event, and the event never changes", async () => {
  const id = await commit("Q-event", 1, 1);
  await assert.rejects(db.query("UPDATE community_commitments SET verification_state='verified' WHERE id=$1", [id]), /verified_has_event/);
  await verify(id);
  await assert.rejects(db.query(
    "UPDATE community_commitments SET verification_policy_version='forged' WHERE id=$1", [id]), /cannot change once set/);
});

test("fulfillment only for verified; it moves forward; refused leaves the meter and is reported", async () => {
  const p = await commit("Q-unverified", 1, 1);
  await assert.rejects(db.query("UPDATE community_commitments SET fulfillment_state='locked' WHERE id=$1", [p]), /fulfillment_needs_verified|only a verified/);
  const base = await verifiedKg();
  const id = await commit("Q-life", 1, 1);
  await verify(id);
  assert.equal(await verifiedKg(), base + 5);
  await assert.rejects(db.query("UPDATE community_commitments SET fulfillment_state='paid' WHERE id=$1", [id]), /none -> paid/);
  await db.query("UPDATE community_commitments SET fulfillment_state='locked' WHERE id=$1", [id]);
  await assert.rejects(db.query("UPDATE community_commitments SET verification_state='cancelled' WHERE id=$1", [id]), /verified -> cancelled/);
  await db.query("UPDATE community_commitments SET fulfillment_state='packed' WHERE id=$1", [id]);
  await db.query("UPDATE community_commitments SET fulfillment_state='refused' WHERE id=$1", [id]);
  assert.equal(await verifiedKg(), base);
  assert.ok(Number((await meter()).refused_packs) >= 1);
  const ev = await db.query("SELECT dimension, to_state FROM community_commitment_events WHERE commitment_id=$1 ORDER BY id", [id]);
  assert.deepEqual(ev.rows.map(r => r.dimension + ":" + r.to_state),
    ["created:pending", "verification:verified", "fulfillment:locked", "fulfillment:packed", "fulfillment:refused"]);
});

test("a locked quote cannot be superseded (post-lock changes follow the amendment policy)", async () => {
  const id = await commit("Q-locked", 1, 1);
  await verify(id);
  await db.query("UPDATE community_commitments SET fulfillment_state='locked' WHERE id=$1", [id]);
  await assert.rejects(db.query("SELECT community_supersede_quote('Q-locked', 2)"), /already locked/);
});

test("policy test 6: payment security needs a provider reference and never moves down", async () => {
  const id = await commit("Q-pay", 1, 1);
  await assert.rejects(db.query("UPDATE community_commitments SET payment_security_state='deposit_confirmed' WHERE id=$1", [id]),
    /secured_needs_provider_ref/);
  await db.query("UPDATE community_commitments SET payment_security_state='deposit_confirmed', payment_provider_ref='psp-tx-1' WHERE id=$1", [id]);
  await assert.rejects(db.query("UPDATE community_commitments SET payment_security_state='unsecured_cod' WHERE id=$1", [id]), /cannot change/);
  await verify(id);
  assert.ok(Number((await meter()).payment_secured_packs) >= 1);
});

test("the meter unlocks at the tier's verified-pack threshold", async () => {
  const m = await meter();
  assert.equal(m.unlocked, Number(m.verified_packs) >= Number(m.unlock_verified_packs));
});

test("committed facts are immutable; rows, events and tiers are never deleted or truncated", async () => {
  const id = await commit("Q-imm", 1, 1);
  await assert.rejects(db.query("UPDATE community_commitments SET packs=2 WHERE id=$1", [id]), /immutable/);
  await assert.rejects(db.query("DELETE FROM community_commitments WHERE id=$1", [id]), /never deleted/);
  await assert.rejects(db.query("DELETE FROM community_commitment_events WHERE commitment_id=$1", [id]), /not allowed/);
  await assert.rejects(db.query("DELETE FROM community_hero_tiers"), /not allowed/);
  await assert.rejects(db.query("TRUNCATE community_commitments CASCADE"), /not allowed/);
});
