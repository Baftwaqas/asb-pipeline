// ADR-002 Lane C — migration 021 database guards, atomic quote replacement,
// two-connection races and the frozen meter at lock.
// Needs a scratch Postgres (TEST_PG_URL, default postgres://postgres@localhost:54330).
//   node --test test/adr002-community-021.test.js
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { Client } = require("pg");
const H = require("./support/harness");

const ROOT = path.join(__dirname, "..");
const CYCLE = "MON-TEST";
let db, db2, url, LOCKS, TIER;

before(async () => {
  url = await H.createDatabase("asb_test_021", ROOT, { grocery: false });
  db = new Client({ connectionString: url }); await db.connect();
  db2 = new Client({ connectionString: url }); await db2.connect();
  LOCKS = (await db.query("SELECT (now() + interval '3 days') AS t")).rows[0].t; // a future cutoff
  TIER = await tier(CYCLE, "ONION-5KG", 4, 72000);
});
after(async () => { if (db) await db.end(); if (db2) await db2.end(); });

async function tier(cycle, code, unlockPacks = null, unlockPaisa = null) {
  const w = await db.query(
    `INSERT INTO community_hero_weeks (hero_week_code, cycle_code, canonical_product_id, created_by)
     VALUES ($1, $2, $3, 'test') RETURNING id`, ["HW-" + code, cycle, "ASB-CANON-" + code]);
  return (await db.query(
    `INSERT INTO community_hero_tiers (tier_code, hero_week_id, pack_variant_gid, unit, pack_qty,
       ceiling_pack_paisa, unlock_verified_packs, unlock_pack_paisa)
     VALUES ($1, $2, 'gid://shopify/ProductVariant/5', 'g', 5000, 80000, $3, $4) RETURNING id`,
    [code, w.rows[0].id, unlockPacks, unlockPaisa])).rows[0].id;
}
async function commit(q, packs, extra = {}) {
  const r = await (extra.client || db).query(
    `INSERT INTO community_commitments (commitment_key, quote_id, quote_version, line_id, cycle_code, locks_at,
       household_key, door, tier_id, packs, ceiling_line_paisa)
     VALUES ($1::text || ':' || $2::int || ':L1', $1, $2::int, 'L1', $3, $4, $5, $6, $7, $8::int, 80000 * $8::int) RETURNING id`,
    [q, extra.version || 1, extra.cycle || CYCLE, extra.locks || LOCKS, "hh-" + q, extra.door || "community_order",
     extra.tier || TIER, packs]);
  return r.rows[0].id;
}
const linesFor = (q, packs, t = TIER) => JSON.stringify([{ line_id: "L1", household_key: "hh-" + q, door: "community_order",
  tier_id: t, packs, ceiling_line_paisa: 80000 * packs }]);
const replace = (q, v, packs, client = db) =>
  client.query("SELECT community_replace_quote($1, $2, $3::jsonb) AS id", [q, v, linesFor(q, packs)]);
// Option A evidence as the server would resolve it from trusted sources.
async function evidenceFor(id, over = {}, client = db) {
  const c = (await client.query(
    `SELECT quote_id, quote_version, household_key, clock_timestamp() AS now FROM community_commitments WHERE id=$1`, [id])).rows[0];
  const now = new Date(c.now);
  const iso = (ms) => new Date(now.getTime() + ms).toISOString();
  const e = {
    order: { serverOrderId: "srv-" + c.quote_id, quoteId: c.quote_id, quoteVersion: c.quote_version,
             acceptedAt: iso(-60000) },
    whatsapp: { quoteId: c.quote_id, quoteVersion: c.quote_version, fromPhone: "+923000000000", messageId: "wamid." + id,
                webhookSignatureValid: true, action: "confirm", confirmationTokenId: "tok-" + id, receivedAt: iso(-30000) },
    address: { householdKey: c.household_key, approved: true },
    risk: { flagged: false },
  };
  for (const [k, v] of Object.entries(over)) e[k] = v === null ? undefined : { ...e[k], ...v };
  return e;
}
const verifyWith = (id, evidence, client = db) => client.query(
  "SELECT community_verify_commitment($1, 'ADR-002-VERIFY-001', $2::jsonb, 'ops-reviewer-1') AS outcome",
  [id, JSON.stringify(evidence)]);
const verify = async (id, client = db) => verifyWith(id, await evidenceFor(id, {}, client), client);
const meter = async (code = "ONION-5KG") => (await db.query("SELECT * FROM community_rate_meter WHERE tier_code=$1", [code])).rows[0];
const verifiedKg = async (code) => Number((await meter(code)).verified_packs) * 5;

test("021 applies through scripts/migrate.js and the meter starts empty", async () => {
  const m = await meter();
  assert.equal(m.cycle_code, CYCLE);
  assert.equal(Number(m.verified_packs), 0);
  assert.equal(m.unlocked, false);
});

test("F05 an unlock price above the tier ceiling is refused", async () => {
  await assert.rejects(tier(CYCLE, "BAD", 3, 90000), /unlock_not_above_ceiling/);
});

test("F02 Apna and Bhao Tao cannot hold commitments", async () => {
  await assert.rejects(commit("Q-apna", 1, { door: "apna_order" }), /door_check/);
  await assert.rejects(commit("Q-bhao", 1, { door: "bhao_tao" }), /door_check/);
});

test("T10 a commitment cannot use a tier from another cycle", async () => {
  await assert.rejects(commit("Q-x", 1, { cycle: "THU-TEST" }), /belongs to cycle/);
});

test("policy test 1: a pending reservation contributes 0 kg", async () => {
  const before = await verifiedKg();
  await commit("Q-pending", 2);
  assert.equal(await verifiedKg(), before);
});

test("policy test 2: a replayed commitment is the same row (unique key)", async () => {
  await commit("Q-replay", 1);
  await assert.rejects(commit("Q-replay", 1), /commitment_key/);
});

test("caution 3: v1 10 kg verified, replaced by v2 5 kg -> 0 kg until re-confirmed, then 5 kg", async () => {
  const base = await verifiedKg();
  const v1 = await commit("Q-edit", 2);
  await verify(v1);
  assert.equal(await verifiedKg(), base + 10);
  const v2 = (await replace("Q-edit", 2, 1)).rows[0].id;
  assert.equal(await verifiedKg(), base, "policy test 3");
  await verify(v2);
  assert.equal(await verifiedKg(), base + 5);
  const old = (await db.query("SELECT verification_state, superseded_by_version FROM community_commitments WHERE id=$1", [v1])).rows[0];
  assert.deepEqual(old, { verification_state: "cancelled", superseded_by_version: 2 });
});

test("B4 a direct insert of version 2 is refused; only community_replace_quote() writes it", async () => {
  await commit("Q-direct", 1);
  await assert.rejects(commit("Q-direct", 1, { version: 2 }), /must be written by community_replace_quote/);
});

test("B4 a replacement must carry lines: verified demand cannot be cancelled without its new version", async () => {
  const id = await commit("Q-empty", 1);
  await verify(id);
  await assert.rejects(db.query("SELECT community_replace_quote('Q-empty', 2, '[]'::jsonb)"), /must carry/);
  const s = (await db.query("SELECT verification_state FROM community_commitments WHERE id=$1", [id])).rows[0];
  assert.equal(s.verification_state, "verified");
});

test("B4 an older version cannot be written after a newer one", async () => {
  await commit("Q-order", 1);
  await replace("Q-order", 3, 1);
  await assert.rejects(replace("Q-order", 2, 1), /version 2 or newer/);
});

test("B4 / policy 4: no commitment, verification or replacement after the cutoff (database clock)", async () => {
  const soon = (await db.query("SELECT (clock_timestamp() + interval '1 second') AS t")).rows[0].t;
  const id = await commit("Q-cut", 1, { locks: soon });
  await db.query("SELECT pg_sleep(1.2)");
  await assert.rejects(commit("Q-cut2", 1, { locks: soon }), /past its cutoff; no new commitments/);
  await assert.rejects(verify(id), /cannot be verified now|verified_before_lock|out of order/);
  await assert.rejects(replace("Q-cut", 2, 1), /past its cutoff; it cannot be replaced/);
});

test("policy test 5: a quote chain cannot move to another cycle", async () => {
  const thu = await tier("THU-TEST", "ONION-5KG-THU");
  await commit("Q-cyc", 1);
  await assert.rejects(db.query("SELECT community_replace_quote($1, 2, $2::jsonb)", ["Q-cyc", linesFor("Q-cyc", 1, thu)]),
    /belongs to cycle/);
});

test("policy test 4: under_review counts 0; verified after review counts", async () => {
  const base = await verifiedKg();
  const id = await commit("Q-review", 1);
  await db.query("UPDATE community_commitments SET verification_state='under_review' WHERE id=$1", [id]);
  assert.equal(await verifiedKg(), base);
  await verify(id);
  assert.equal(await verifiedKg(), base + 5);
});

test("R3 verified needs its event; the event can't be back-dated before creation or changed", async () => {
  const id = await commit("Q-event", 1);
  await assert.rejects(db.query("UPDATE community_commitments SET verification_state='verified' WHERE id=$1", [id]),
    /only by community_verify_commitment/);
  await assert.rejects(db.query(
    `UPDATE community_commitments SET verification_state='verified', verified_at=created_at - interval '1 day',
       verification_policy_version='X' WHERE id=$1`, [id]), /only by community_verify_commitment/);
  await verify(id);
  const c = (await db.query("SELECT verified_at, created_at FROM community_commitments WHERE id=$1", [id])).rows[0];
  assert.ok(c.verified_at >= c.created_at); // stamped by the database clock
  await assert.rejects(db.query(
    "UPDATE community_commitments SET verification_policy_version='forged' WHERE id=$1", [id]), /cannot change once set/);
});

// ---------- hardening: the only way to verify (Lane A "DB writers cannot bypass Option A") ----------
test("SQL B1: a cancel / edit / free-form reply or a missing confirmation token never verifies", async () => {
  const id = await commit("Q-sqlb1", 1);
  for (const action of ["cancel", "edit", "reply", null]) {
    await assert.rejects(verifyWith(id, await evidenceFor(id, { whatsapp: { action } })), /token-bound WhatsApp CONFIRM/);
  }
  await assert.rejects(verifyWith(id, await evidenceFor(id, { whatsapp: { confirmationTokenId: " " } })), /token-bound/);
  assert.equal((await db.query("SELECT verification_state FROM community_commitments WHERE id=$1", [id])).rows[0].verification_state, "pending");
});

test("SQL B2: evidence must be in order accepted <= received <= now <= cutoff, for THIS quote version", async () => {
  const id = await commit("Q-sqlb2", 1);
  const future = new Date(Date.now() + 3600e3).toISOString();
  await assert.rejects(verifyWith(id, await evidenceFor(id, { whatsapp: { receivedAt: future } })), /out of order/);
  await assert.rejects(verifyWith(id, await evidenceFor(id, { order: { acceptedAt: future } })), /out of order/);
  await assert.rejects(verifyWith(id, await evidenceFor(id, { whatsapp: { receivedAt: null } })), /out of order/);
  await assert.rejects(verifyWith(id, await evidenceFor(id, { whatsapp: { quoteVersion: 2 } })), /another quote or version/);
  await assert.rejects(verifyWith(id, await evidenceFor(id, { address: null })), /order, whatsapp, address and risk/);
});

test("SQL: a risk flag sends the commitment to under_review (counts 0); evidence is append-only", async () => {
  const base = await verifiedKg();
  const id = await commit("Q-risk", 1);
  const r = await verifyWith(id, await evidenceFor(id, { risk: { flagged: true, reason: "new address" } }));
  assert.equal(r.rows[0].outcome, "under_review");
  assert.equal(await verifiedKg(), base);
  assert.equal((await verify(id)).rows[0].outcome, "verified"); // cleared on review
  assert.equal(await verifiedKg(), base + 5);
  const ev = (await db.query("SELECT outcome FROM community_verification_evidence WHERE commitment_id=$1 ORDER BY id", [id])).rows;
  assert.deepEqual(ev.map((e) => e.outcome), ["under_review", "verified"]);
  await assert.rejects(db.query("UPDATE community_verification_evidence SET outcome='verified' WHERE commitment_id=$1", [id]), /not allowed/);
  await assert.rejects(db.query("DELETE FROM community_verification_evidence WHERE commitment_id=$1", [id]), /not allowed/);
  await assert.rejects(verify(id), /is verified; it cannot be verified/);
});

test("SQL: forging the session setting without an evidence row is still refused", async () => {
  const id = await commit("Q-forge", 1);
  await db.query("BEGIN");
  await db.query("SELECT set_config('asb021.verifying', $1, true)", [String(id)]);
  await assert.rejects(db.query(
    `UPDATE community_commitments SET verification_state='verified', verified_at=clock_timestamp(),
       verification_policy_version='X' WHERE id=$1`, [id]), /no matching verified evidence/);
  await db.query("ROLLBACK");
});

test("isolation contract: replace / verify / lock refuse REPEATABLE READ and SERIALIZABLE", async () => {
  const id = await commit("Q-iso", 1);
  for (const level of ["REPEATABLE READ", "SERIALIZABLE"]) {
    await db2.query("BEGIN ISOLATION LEVEL " + level);
    await assert.rejects(verify(id, db2), /only under READ COMMITTED/);
    await db2.query("ROLLBACK");
    await db2.query("BEGIN ISOLATION LEVEL " + level);
    await assert.rejects(replace("Q-iso", 2, 1, db2), /only under READ COMMITTED/);
    await db2.query("ROLLBACK");
    await db2.query("BEGIN ISOLATION LEVEL " + level);
    await assert.rejects(db2.query("SELECT community_lock_meter('MON-TEST', 'x')"), /only under READ COMMITTED/);
    await db2.query("ROLLBACK");
  }
});

test("invariant: at most one live row per (quote, line), even for a writer that skips the chain lock", async () => {
  const ix = (await db.query(
    "SELECT indexdef FROM pg_indexes WHERE indexname='uq_community_commitments_live_line'")).rows[0];
  assert.match(ix.indexdef, /UNIQUE INDEX .* \(quote_id, line_id\) WHERE \(verification_state <> ALL/);
});

test("fulfillment only for verified; it moves forward; refused leaves the live meter", async () => {
  const p = await commit("Q-unverified", 1);
  await assert.rejects(db.query("UPDATE community_commitments SET fulfillment_state='locked' WHERE id=$1", [p]), /fulfillment_needs_verified|only a verified/);
  const base = await verifiedKg();
  const id = await commit("Q-life", 1);
  await verify(id);
  await assert.rejects(db.query("UPDATE community_commitments SET fulfillment_state='paid' WHERE id=$1", [id]), /none -> paid/);
  await db.query("UPDATE community_commitments SET fulfillment_state='locked' WHERE id=$1", [id]);
  await assert.rejects(db.query("UPDATE community_commitments SET verification_state='cancelled' WHERE id=$1", [id]), /verified -> cancelled/);
  await assert.rejects(replace("Q-life", 2, 1), /already locked for fulfillment/);
  await db.query("UPDATE community_commitments SET fulfillment_state='packed' WHERE id=$1", [id]);
  await db.query("UPDATE community_commitments SET fulfillment_state='refused' WHERE id=$1", [id]);
  assert.equal(await verifiedKg(), base);
  const ev = await db.query("SELECT dimension, to_state FROM community_commitment_events WHERE commitment_id=$1 ORDER BY id", [id]);
  assert.deepEqual(ev.rows.map(r => r.dimension + ":" + r.to_state),
    ["created:pending", "verification:verified", "fulfillment:locked", "fulfillment:packed", "fulfillment:refused"]);
});

test("policy test 6: payment security needs a non-empty provider reference; deposit may upgrade to prepaid", async () => {
  const id = await commit("Q-pay", 1);
  await assert.rejects(db.query("UPDATE community_commitments SET payment_security_state='deposit_confirmed', payment_provider_ref='  ' WHERE id=$1", [id]),
    /secured_needs_provider_ref/);
  await db.query("UPDATE community_commitments SET payment_security_state='deposit_confirmed', payment_provider_ref='psp-tx-1' WHERE id=$1", [id]);
  await db.query("UPDATE community_commitments SET payment_security_state='prepaid_confirmed', payment_provider_ref='psp-tx-2' WHERE id=$1", [id]);
  await assert.rejects(db.query("UPDATE community_commitments SET payment_security_state='unsecured_cod' WHERE id=$1", [id]), /cannot change/);
});

test("committed facts are immutable; rows, events and tiers are never deleted or truncated", async () => {
  const id = await commit("Q-imm", 1);
  await assert.rejects(db.query("UPDATE community_commitments SET packs=2 WHERE id=$1", [id]), /immutable/);
  await assert.rejects(db.query("DELETE FROM community_commitments WHERE id=$1", [id]), /never deleted/);
  await assert.rejects(db.query("DELETE FROM community_commitment_events WHERE commitment_id=$1", [id]), /not allowed/);
  await assert.rejects(db.query("DELETE FROM community_hero_tiers"), /not allowed/);
  await assert.rejects(db.query("TRUNCATE community_commitments CASCADE"), /not allowed/);
});

// ---------- two-connection races (READ COMMITTED, the default) ----------
test("race: two concurrent replacements to the same version -> exactly one wins", async () => {
  await commit("Q-race", 1);
  await db.query("BEGIN");
  await replace("Q-race", 2, 1);                         // A holds the chain lock
  const b = replace("Q-race", 2, 2, db2).then(() => "ok", e => e.message); // B waits
  await new Promise(r => setTimeout(r, 300));
  await db.query("COMMIT");
  assert.match(await b, /version 2 or newer/);
  const rows = (await db.query("SELECT packs FROM community_commitments WHERE quote_id='Q-race' AND quote_version=2")).rows;
  assert.deepEqual(rows.map(r => r.packs), [1]);
});

test("race: a verifier waits on the chain lock, then cannot verify a superseded line", async () => {
  const v1 = await commit("Q-race2", 1);
  await db.query("BEGIN");
  await replace("Q-race2", 2, 1);                        // A cancels v1 (row lock held)
  const b = verify(v1, db2).then(() => "ok", e => e.message); // B waits on the chain lock
  await new Promise(r => setTimeout(r, 300));
  await db.query("COMMIT");
  assert.match(await b, /is cancelled; it cannot be verified/);
});

test("race: a verification in flight at cutoff is in the frozen meter (SHARE lock waits for it)", async () => {
  const t = await tier("RACE-LOCK", "ONION-RACE", 1, 70000);
  const soon = (await db.query("SELECT (clock_timestamp() + interval '1500 milliseconds') AS t")).rows[0].t;
  const id = await commit("Q-race4", 1, { cycle: "RACE-LOCK", tier: t, locks: soon });
  await db2.query("BEGIN");
  await verify(id, db2);                                   // verified before cutoff, not yet committed
  await db.query("SELECT pg_sleep(1.7)");                  // cutoff passes
  let done = false;
  const lock = db.query("SELECT community_lock_meter('RACE-LOCK', 'test-job') AS n").then((r) => { done = true; return r; });
  await new Promise(r => setTimeout(r, 300));
  assert.equal(done, false, "the freeze must wait for the in-flight verifier");
  await db2.query("COMMIT");
  assert.equal((await lock).rows[0].n, 1);
  const s = (await db.query("SELECT locked_verified_packs, locked_unlocked FROM community_meter_locks WHERE cycle_code='RACE-LOCK'")).rows[0];
  assert.deepEqual([s.locked_verified_packs, s.locked_unlocked], [1, true]);
});

// ---------- frozen meter at lock (review point b) ----------
test("lock snapshot: frozen at cutoff, refused before it, immutable, and a later refusal never revokes the unlock", async () => {
  const t = await tier("LOCK-TEST", "ONION-LOCK", 2, 70000);
  const soon = (await db.query("SELECT (clock_timestamp() + interval '1 second') AS t")).rows[0].t;
  const a = await commit("Q-L1", 1, { cycle: "LOCK-TEST", tier: t, locks: soon });
  const b = await commit("Q-L2", 1, { cycle: "LOCK-TEST", tier: t, locks: soon });
  await verify(a); await verify(b);
  await assert.rejects(db.query("SELECT community_lock_meter('LOCK-TEST', 'test-job')"), /has not reached its cutoff/);
  await db.query("SELECT pg_sleep(1.2)");
  assert.equal((await db.query("SELECT community_lock_meter('LOCK-TEST', 'test-job') AS n")).rows[0].n, 1);
  const snap = async () => (await db.query("SELECT * FROM community_meter_locks WHERE cycle_code='LOCK-TEST'")).rows[0];
  const s1 = await snap();
  assert.deepEqual([s1.locked_verified_packs, s1.locked_unlocked, Number(s1.locked_pack_paisa)], [2, true, 70000]);
  // one customer refuses at the door: the live view drops, the locked price does not
  await db.query("UPDATE community_commitments SET fulfillment_state='locked' WHERE id=$1", [a]);
  await db.query("UPDATE community_commitments SET fulfillment_state='refused' WHERE id=$1", [a]);
  assert.equal((await meter("ONION-LOCK")).unlocked, false);
  const s2 = await snap();
  assert.deepEqual([s2.locked_verified_packs, s2.locked_unlocked, Number(s2.locked_pack_paisa)], [2, true, 70000]);
  await assert.rejects(db.query("SELECT community_lock_meter('LOCK-TEST', 'test-job')"), /duplicate key|unique/);
  await assert.rejects(db.query("UPDATE community_meter_locks SET locked_unlocked=false WHERE cycle_code='LOCK-TEST'"), /not allowed/);
});
