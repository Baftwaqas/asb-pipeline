// ADR-002 Lane C — community/kernel.js. Pure: no database needed.
//   node --test test/adr002-community-kernel.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const K = require("../community/kernel");

const CYCLE = "MON-2026-11-09";
const tiers = {
  "ONION-10KG": { heroWeekId: "HW-1", cycleCode: CYCLE, packVariantGid: "gid://shopify/ProductVariant/10", unit: "g", packQty: 10000, maxPacksPerLine: 1, active: true },
  "ONION-5KG": { heroWeekId: "HW-1", cycleCode: CYCLE, packVariantGid: "gid://shopify/ProductVariant/5", unit: "g", packQty: 5000, maxPacksPerLine: 1, active: true },
  "EGG-30": { heroWeekId: "HW-1", cycleCode: CYCLE, packVariantGid: "gid://shopify/ProductVariant/30", unit: "piece", packQty: 30, maxPacksPerLine: 2, active: true },
};
let n = 0;
const line = (door, variant, qty, ceiling, tierId, extra = {}) => ({
  lineId: "L" + (++n), door, shopifyVariantGid: "gid://shopify/ProductVariant/" + variant,
  unit: extra.unit || "g", qty, ceilingLinePaisa: ceiling,
  heroTier: tierId ? { heroWeekId: "HW-1", tierId } : null, ...extra,
});
const elig = (lines) => K.eligibilityByDoor({ cycleCode: CYCLE, lines, tiersById: tiers });

// ---------- F03: two gates, ceiling price ----------
test("F03 qualifying Hero line at ceiling >= Rs 1,200 makes Community eligible", () => {
  const r = elig([line("community_order", 10, 10000, 150000, "ONION-10KG")]);
  assert.equal(r.community_order.qualifyingCeilingPaisa, 150000);
  assert.equal(r.community_order.eligible, true);
});
test("F03 exactly Rs 1,200 qualifies; Rs 1,199.99 does not", () => {
  assert.equal(elig([line("community_order", 10, 10000, 120000, "ONION-10KG")]).community_order.eligible, true);
  assert.equal(elig([line("community_order", 10, 10000, 119999, "ONION-10KG")]).community_order.eligible, false);
});
test("F03 a non-Hero line never counts toward the Rs 1,200", () => {
  const r = elig([line("community_order", 99, 10000, 200000, null)]);
  assert.equal(r.community_order.qualifyingCeilingPaisa, 0);
});
test("F03 a Hero line that is not its tier's pack variant does not count", () => {
  const r = elig([line("community_order", 5, 10000, 150000, "ONION-10KG")]);
  assert.equal(r.community_order.eligible, false);
});

// ---------- F01 / T7: no cross-door pooling ----------
test("T7 Rs 700 Dish + Rs 600 Community does NOT qualify either door", () => {
  const r = elig([
    line("dish_to_cart", 5, 5000, 70000, "ONION-5KG"),
    line("community_order", 5, 5000, 60000, "ONION-5KG"),
  ]);
  assert.equal(r.dish_to_cart.eligible, false);
  assert.equal(r.community_order.eligible, false);
});
test("F01 Apna spending never creates Community eligibility, however large", () => {
  const r = elig([line("apna_order", 10, 10000, 2000000, "ONION-10KG")]);
  for (const d of K.ELIGIBLE_DOORS) assert.equal(r[d].qualifyingCeilingPaisa, 0);
  assert.equal(r.apna_order, undefined);
});
test("F01 Bhao Tao lines never create grocery Community eligibility", () => {
  const r = elig([line("bhao_tao", 10, 10000, 500000, "ONION-10KG")]);
  for (const d of K.ELIGIBLE_DOORS) assert.equal(r[d].eligible, false);
});
test("F01 Dish-to-Cart qualifies on its own tier-qualified Hero lines", () => {
  const r = elig([line("dish_to_cart", 10, 10000, 130000, "ONION-10KG")]);
  assert.equal(r.dish_to_cart.eligible, true);
  assert.equal(r.community_order.eligible, false);
});

// ---------- F11: pack-tier integrity ----------
test("F11 two 5 kg packs (as 10 kg of the 5 kg variant) do not earn the 10 kg tier", () => {
  const q = K.lineQualifiesForTier(line("community_order", 5, 10000, 150000, "ONION-10KG"), tiers, CYCLE);
  assert.deepEqual(q, { qualifies: false, reason: "NOT_THE_TIER_PACK" });
});
test("F11 more packs than the tier allows per line do not qualify", () => {
  const q = K.lineQualifiesForTier(line("community_order", 5, 10000, 150000, "ONION-5KG"), tiers, CYCLE);
  assert.equal(q.reason, "TOO_MANY_PACKS");
});
test("F11 a partial pack quantity does not qualify", () => {
  const q = K.lineQualifiesForTier(line("community_order", 10, 9000, 150000, "ONION-10KG"), tiers, CYCLE);
  assert.equal(q.reason, "NOT_WHOLE_PACKS");
});
test("F11 piece tiers work in whole packs", () => {
  const q = K.lineQualifiesForTier(line("community_order", 30, 60, 90000, "EGG-30", { unit: "piece" }), tiers, CYCLE);
  assert.deepEqual(q, { qualifies: true, packs: 2 });
});
test("T10 a tier from another cycle does not qualify", () => {
  const q = K.lineQualifiesForTier(line("community_order", 10, 10000, 150000, "ONION-10KG"), tiers, "THU-2026-11-12");
  assert.equal(q.reason, "TIER_OTHER_CYCLE");
});
test("a tampered heroWeekId on the line does not qualify (T3)", () => {
  const l = line("community_order", 10, 10000, 150000, "ONION-10KG");
  l.heroTier.heroWeekId = "HW-FORGED";
  assert.equal(K.lineQualifiesForTier(l, tiers, CYCLE).reason, "HERO_WEEK_MISMATCH");
});
test("duplicate line ids and unknown doors fail closed", () => {
  const a = line("community_order", 10, 10000, 150000, "ONION-10KG");
  assert.throws(() => elig([a, { ...a }]), /DUPLICATE_LINE_ID/);
  assert.throws(() => elig([line("vip_door", 10, 10000, 150000, null)]), /UNKNOWN_DOOR/);
});

// ---------- F04 / R1: sticky eligibility ----------
test("F04 a collective price drop below Rs 1,200 never revokes eligibility", () => {
  const prev = { eligible: true, qualifyingCeilingPaisa: 125000 };
  assert.equal(K.eligibilityAfterChange({ previous: prev, reason: "collective_price_drop" }), prev);
});
test("R1 an ASB shortage (10 kg packed as 9.6 kg) keeps the locked tier", () => {
  const prev = { eligible: true, qualifyingCeilingPaisa: 150000 };
  assert.equal(K.eligibilityAfterChange({ previous: prev, reason: "asb_shortage" }), prev);
});
test("F04 a customer edit is recomputed at ceiling", () => {
  const r = K.eligibilityAfterChange({
    previous: { eligible: true },
    reason: "customer_edit",
    recompute: () => elig([line("community_order", 10, 10000, 110000, "ONION-10KG")]).community_order,
  });
  assert.equal(r.eligible, false);
});
test("an unknown change reason fails closed", () => {
  assert.throws(() => K.eligibilityAfterChange({ previous: {}, reason: "because" }), /UNKNOWN_CHANGE_REASON/);
});

// ---------- F05 / R2: line ceilings and rounding ----------
test("F05 overpacking 1,080 g at Rs 95/kg never exceeds the Rs 100 line ceiling", () => {
  assert.equal(K.lineBilledPaisa({ unit: "g", packedQty: 1080, ratePaisa: 9500, ceilingLinePaisa: 10000 }), 10000);
});
test("F05 underpacking bills delivered weight at the locked rate", () => {
  assert.equal(K.lineBilledPaisa({ unit: "g", packedQty: 920, ratePaisa: 9500, ceilingLinePaisa: 10000 }), 8740);
});
test("R2 125 g x 43,333 paisa/kg rounds half-up to 5,417 paisa", () => {
  assert.equal(K.lineBilledPaisa({ unit: "g", packedQty: 125, ratePaisa: 43333, ceilingLinePaisa: 999999 }), 5417);
});
test("F08 / T6 an exact 40 g line bills exactly", () => {
  assert.equal(K.lineBilledPaisa({ unit: "g", packedQty: 40, ratePaisa: 43500, ceilingLinePaisa: 5000 }), 1740);
});
test("nothing packed is never billed", () => {
  assert.equal(K.lineBilledPaisa({ unit: "g", packedQty: 0, ratePaisa: 9500, ceilingLinePaisa: 10000 }), 0);
});
test("piece lines bill pieces x rate, capped at ceiling", () => {
  assert.equal(K.lineBilledPaisa({ unit: "piece", packedQty: 31, ratePaisa: 3000, ceilingLinePaisa: 90000 }), 90000);
});
test("R2 COD payable rounds DOWN once to a whole rupee with a rounding credit", () => {
  const r = K.codPayable({ lineBilledPaisa: [5417, 10260, 1740], orderCeilingPaisa: 999999 });
  assert.deepEqual(r, { billedPaisa: 17417, payablePaisa: 17400, roundingCreditPaisa: 17 });
});
test("F05 the order total is capped at the order ceiling", () => {
  assert.equal(K.codPayable({ lineBilledPaisa: [60000, 60000], orderCeilingPaisa: 110000 }).payablePaisa, 110000);
});
test("float or negative money fails closed", () => {
  assert.throws(() => K.lineBilledPaisa({ unit: "g", packedQty: 1.5, ratePaisa: 9500, ceilingLinePaisa: 10000 }), /INVALID_INTEGER/);
  assert.throws(() => K.codPayable({ lineBilledPaisa: [-1], orderCeilingPaisa: 100 }), /INVALID_INTEGER/);
});

// ---------- R3 / E1: verification is configured, fail closed ----------
const pending = { commitmentId: "C1", status: "pending" };
const allEvidence = { server_order_before_cutoff: true, whatsapp_confirmation: true };
test("R3 with no approved rule, a commitment stays pending", () => {
  assert.equal(K.verifyCommitment({ commitment: pending, rule: null, evidence: allEvidence }).status, "pending");
  assert.equal(K.verifyCommitment({ commitment: pending, rule: { version: "E1-proposed", approved: false, requires: ["whatsapp_confirmation"] }, evidence: allEvidence }).status, "pending");
});
test("R3 an approved rule verifies only when every required evidence is present", () => {
  const rule = { version: "E1-v1", approved: true, requires: ["server_order_before_cutoff", "whatsapp_confirmation"] };
  assert.equal(K.verifyCommitment({ commitment: pending, rule, evidence: { server_order_before_cutoff: true } }).status, "pending");
  assert.deepEqual(K.verifyCommitment({ commitment: pending, rule, evidence: allEvidence }), { status: "verified", changed: true, ruleVersion: "E1-v1" });
});

// ---------- F02 / F13: Rate Meter ----------
const c = (id, status, packs = 1, extra = {}) => ({ commitmentId: id, status, packs, tierId: "ONION-10KG", cycleCode: CYCLE, door: "community_order", ...extra });
test("F13 pending commitments never count toward the meter", () => {
  const m = K.rateMeter({ cycleCode: CYCLE, commitments: [c("A", "pending", 3)] });
  assert.equal(m["ONION-10KG"].verifiedPacks, 0);
  assert.equal(m["ONION-10KG"].pendingPacks, 3);
});
test("F13 verified, locked, fulfilled and paid count; cancelled and refused do not", () => {
  const m = K.rateMeter({ cycleCode: CYCLE, commitments: [
    c("A", "verified"), c("B", "locked"), c("C", "fulfilled"), c("D", "paid"), c("E", "cancelled"), c("F", "refused"),
  ] });
  assert.equal(m["ONION-10KG"].verifiedPacks, 4);
  assert.equal(m["ONION-10KG"].cancelledPacks, 1);
  assert.equal(m["ONION-10KG"].refusedPacks, 1);
});
test("F13 / T0 a replayed commitment is counted once", () => {
  const m = K.rateMeter({ cycleCode: CYCLE, commitments: [c("A", "verified", 2), c("A", "verified", 2)] });
  assert.equal(m["ONION-10KG"].verifiedPacks, 2);
});
test("F13 a conflicting duplicate commitment fails closed", () => {
  assert.throws(() => K.rateMeter({ cycleCode: CYCLE, commitments: [c("A", "verified", 2), c("A", "verified", 5)] }), /CONFLICTING_DUPLICATE/);
});
test("F02 Dish and Budget commitments add to the same supplier meter", () => {
  const m = K.rateMeter({ cycleCode: CYCLE, commitments: [
    c("A", "verified"), c("B", "verified", 1, { door: "dish_to_cart" }), c("C", "verified", 1, { door: "budget_to_cart" }),
  ] });
  assert.equal(m["ONION-10KG"].verifiedPacks, 3);
});
test("F02 Apna can never commit to the meter", () => {
  assert.throws(() => K.rateMeter({ cycleCode: CYCLE, commitments: [c("A", "verified", 1, { door: "apna_order" })] }), /DOOR_CANNOT_COMMIT/);
});
test("T10 commitments from the other cycle are ignored", () => {
  const m = K.rateMeter({ cycleCode: CYCLE, commitments: [c("A", "verified", 1, { cycleCode: "THU-2026-11-12" })] });
  assert.deepEqual(m, {});
});
