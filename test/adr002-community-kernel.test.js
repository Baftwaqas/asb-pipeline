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

// ---------- Option A verification (ADR-002-VERIFY-001) ----------
const POLICY = {
  policyVersion: "ADR-002-VERIFY-001",
  requireOrderBeforeCutoff: true, requireOrderSpecificWhatsappConfirmation: true,
  requireServiceableHouseholdAddress: true, requireRiskGateApproval: true,
  countPendingTowardUnlock: false, allowTrustedSkipWhatsapp: false,
};
const CM = { quoteId: "Q1", quoteVersion: 2, customerPhone: "+923001234567", locksAt: "2026-11-08T15:00:00Z", paymentSecurityRequired: false };
const EV = () => ({
  order: { serverOrderId: "gid://shopify/Order/1", acceptedAt: "2026-11-07T10:00:00Z", cutoffAt: "2026-11-08T15:00:00Z" },
  whatsapp: { quoteId: "Q1", quoteVersion: 2, fromPhone: "+923001234567", messageId: "wamid.1", webhookSignatureValid: true },
  address: { state: "serviceable" },
  risk: { state: "passed" },
  at: "2026-11-07T11:00:00Z",
});
const v = (ev, cm = CM, policy = POLICY) => K.verifyCommitment({ commitment: cm, policy, evidence: ev });

test("Option A all four evidence classes verify, with the policy version recorded", () => {
  assert.deepEqual(v(EV()), { state: "verified", reasons: [], policyVersion: "ADR-002-VERIFY-001" });
});
test("Option A a weakened policy can never verify (WhatsApp-only, pending counted, skip WhatsApp)", () => {
  for (const k of ["requireOrderBeforeCutoff", "requireServiceableHouseholdAddress", "requireRiskGateApproval", "requireOrderSpecificWhatsappConfirmation"]) {
    const r = v(EV(), CM, { ...POLICY, [k]: false });
    assert.equal(r.state, "pending"); assert.match(r.reasons[0], /BASELINE_WEAKENED/);
  }
  assert.equal(v(EV(), CM, { ...POLICY, countPendingTowardUnlock: true }).state, "pending");
  assert.equal(v(EV(), CM, { ...POLICY, allowTrustedSkipWhatsapp: true }).state, "pending");
  assert.equal(v(EV(), CM, null).state, "pending");
});
test("policy test 1: a Shopify order with no WhatsApp acknowledgment stays pending", () => {
  const ev = EV(); delete ev.whatsapp;
  assert.deepEqual(v(ev).reasons, ["NO_VALID_WHATSAPP_CONFIRMATION"]);
});
test("policy test 3: a WhatsApp reply to a superseded quote version does not verify", () => {
  const ev = EV(); ev.whatsapp.quoteVersion = 1;
  assert.deepEqual(v(ev).reasons, ["WHATSAPP_FOR_OTHER_QUOTE_VERSION"]);
});
test("Option A a reply from another phone, or an unsigned webhook, does not verify", () => {
  const a = EV(); a.whatsapp.fromPhone = "+923009999999";
  assert.deepEqual(v(a).reasons, ["WHATSAPP_FROM_OTHER_PHONE"]);
  const b = EV(); b.whatsapp.webhookSignatureValid = false;
  assert.deepEqual(v(b).reasons, ["NO_VALID_WHATSAPP_CONFIRMATION"]);
});
test("Option A an order accepted at or after cutoff does not verify", () => {
  const ev = EV(); ev.order.acceptedAt = ev.order.cutoffAt;
  assert.deepEqual(v(ev).reasons, ["ORDER_NOT_BEFORE_CUTOFF"]);
});
test("Option A an unserviceable address does not verify; a trusted delivered address does", () => {
  const a = EV(); a.address.state = "incomplete";
  assert.deepEqual(v(a).reasons, ["ADDRESS_NOT_SERVICEABLE"]);
  const b = EV(); b.address.state = "trusted_delivered";
  assert.equal(v(b).state, "verified");
});
test("policy test 4: a risk-flagged order goes under_review, and an operator override with a reason verifies", () => {
  const a = EV(); a.risk = { state: "flagged" };
  assert.equal(v(a).state, "under_review");
  const b = EV(); b.risk = { state: "overridden", operator: "ops-reviewer-1" };
  assert.equal(v(b).state, "pending"); // override without a reason is not enough
  const c = EV(); c.risk = { state: "overridden", operator: "ops-reviewer-1", reason: "family shares one phone" };
  assert.equal(v(c).state, "verified");
});
test("policy test 4: verification after lock never counts", () => {
  const ev = EV(); ev.at = "2026-11-08T15:00:01Z";
  assert.deepEqual(v(ev).reasons, ["AFTER_LOCK_OR_NO_TIME"]);
});
test("policy test 6: required payment security needs a provider-confirmed reference, not a screenshot", () => {
  const cm = { ...CM, paymentSecurityRequired: true };
  const a = EV(); a.payment = { state: "deposit_confirmed" };
  assert.deepEqual(v(a, cm).reasons, ["PAYMENT_SECURITY_NOT_PROVIDER_CONFIRMED"]);
  const b = EV(); b.payment = { state: "deposit_confirmed", providerRef: "psp-tx-88" };
  assert.equal(v(b, cm).state, "verified");
});

// ---------- F02 / F13: Rate Meter ----------
const c = (id, ver, packs, extra = {}) => ({
  commitmentId: id + ":" + ver, quoteId: id, quoteVersion: ver, packs, tierId: "ONION-5KG", cycleCode: CYCLE,
  door: "community_order", verificationState: "verified", fulfillmentState: "none", paymentSecurityState: "unsecured_cod", ...extra,
});
const kg = (m) => m["ONION-5KG"].verifiedPacks * 5;
test("policy test 1: pending and under_review count 0", () => {
  const m = K.rateMeter({ cycleCode: CYCLE, commitments: [c("A", 1, 2, { verificationState: "pending" }), c("B", 1, 1, { verificationState: "under_review" })] });
  assert.equal(m["ONION-5KG"].verifiedPacks, 0);
  assert.equal(m["ONION-5KG"].pendingPacks, 2);
  assert.equal(m["ONION-5KG"].underReviewPacks, 1);
});
test("ChatGPT caution 3: v1 10 kg verified, edited to v2 5 kg verified -> meter counts 5 kg, not 15", () => {
  const m = K.rateMeter({ cycleCode: CYCLE, commitments: [c("Q1", 1, 2), c("Q1", 2, 1)] });
  assert.equal(kg(m), 5);
  assert.equal(m["ONION-5KG"].supersededPacks, 2);
});
test("policy test 3: an edited order whose new version is not yet confirmed counts 0, not its old version", () => {
  const m = K.rateMeter({ cycleCode: CYCLE, commitments: [c("Q1", 1, 2), c("Q1", 2, 1, { verificationState: "pending" })] });
  assert.equal(m["ONION-5KG"].verifiedPacks, 0);
});
test("policy test 2: repeated webhook delivery of the same commitment counts once", () => {
  const m = K.rateMeter({ cycleCode: CYCLE, commitments: [c("A", 1, 2), c("A", 1, 2)] });
  assert.equal(kg(m), 10);
});
test("F13 a conflicting duplicate commitment fails closed", () => {
  assert.throws(() => K.rateMeter({ cycleCode: CYCLE, commitments: [c("A", 1, 2), c("A", 1, 5)] }), /CONFLICTING_DUPLICATE/);
});
test("policy test 8: refused, cancelled and rejected are reported separately and never counted", () => {
  const m = K.rateMeter({ cycleCode: CYCLE, commitments: [
    c("A", 1, 1), c("B", 1, 1, { fulfillmentState: "paid" }), c("C", 1, 1, { fulfillmentState: "refused" }),
    c("D", 1, 1, { verificationState: "cancelled" }), c("E", 1, 1, { verificationState: "rejected" }),
  ] });
  const t = m["ONION-5KG"];
  assert.deepEqual([t.verifiedPacks, t.refusedPacks, t.cancelledOrRejectedPacks], [2, 1, 2]);
});
test("policy: payment-secured packs are reported separately from verified COD packs", () => {
  const m = K.rateMeter({ cycleCode: CYCLE, commitments: [c("A", 1, 2), c("B", 1, 1, { paymentSecurityState: "deposit_confirmed" })] });
  assert.deepEqual([m["ONION-5KG"].verifiedPacks, m["ONION-5KG"].paymentSecuredPacks], [3, 1]);
});
test("F02 Dish and Budget commitments add to the same supplier meter", () => {
  const m = K.rateMeter({ cycleCode: CYCLE, commitments: [c("A", 1, 1), c("B", 1, 1, { door: "dish_to_cart" }), c("C", 1, 1, { door: "budget_to_cart" })] });
  assert.equal(m["ONION-5KG"].verifiedPacks, 3);
});
test("F02 Apna can never commit to the meter", () => {
  assert.throws(() => K.rateMeter({ cycleCode: CYCLE, commitments: [c("A", 1, 1, { door: "apna_order" })] }), /DOOR_CANNOT_COMMIT/);
});
test("policy test 5: Monday commitments never count on Thursday; a quote chain cannot span cycles", () => {
  assert.deepEqual(K.rateMeter({ cycleCode: "THU-2026-11-12", commitments: [c("A", 1, 1)] }), {});
  assert.throws(() => K.rateMeter({ cycleCode: CYCLE, commitments: [c("A", 1, 1), c("A", 2, 1, { cycleCode: "THU-2026-11-12" })] }), /CROSSES_CYCLES/);
});
