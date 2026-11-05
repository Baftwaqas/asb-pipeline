// ============================================================================
// ASB PIPELINE — community/kernel.js
// ADR-002 Lane C: Community eligibility, line ceilings, COD rounding and the
// collective Rate Meter. PURE functions: no database, no Shopify, no clock.
//
// Implements docs/quote-contract-v1.md (accepted 5 Nov 2026, R1-R3) and the
// frozen rules F01-F05, F11-F13. Money is integer paisa; quantities are
// positive integers in "g" or "piece". Nothing here is checkout enforcement:
// callers must pass SERVER-RESOLVED tiers, lines and commitments.
// ============================================================================
"use strict";

const THRESHOLD_PAISA = 120000; // Rs 1,200, measured at CEILING (F03)

// Doors that may hold Community eligibility. Apna never does (F06);
// Bhao Tao is non-grocery (contract §1.5).
const ELIGIBLE_DOORS = Object.freeze(["community_order", "dish_to_cart", "budget_to_cart"]);
const ALL_DOORS = new Set([...ELIGIBLE_DOORS, "apna_order", "bhao_tao"]);
const UNITS = new Set(["g", "piece"]);


class KernelError extends Error {
  constructor(code, detail) { super(code + (detail ? ": " + detail : "")); this.code = code; }
}

function posInt(n, name) {
  if (!Number.isSafeInteger(n) || n <= 0) throw new KernelError("INVALID_INTEGER", name + " must be a positive safe integer");
  return n;
}
function nonNegInt(n, name) {
  if (!Number.isSafeInteger(n) || n < 0) throw new KernelError("INVALID_INTEGER", name + " must be a non-negative safe integer");
  return n;
}
function str(s, name) {
  if (typeof s !== "string" || !s.trim()) throw new KernelError("INVALID_STRING", name + " must be a nonempty string");
  return s;
}
function checkedSum(a, b) {
  const v = a + b;
  if (!Number.isSafeInteger(v)) throw new KernelError("OVERFLOW");
  return v;
}

/**
 * Does one quote line satisfy its OWN Hero tier? (F03 gate 2, F11)
 *
 * tiersById[tierId] = { heroWeekId, cycleCode, packVariantGid, unit, packQty,
 *                       maxPacksPerLine, active }
 * A line qualifies only when it is the tier's distinct pack variant, in the
 * tier's unit, for a whole number of packs within maxPacksPerLine, in the same
 * cycle. Two 5 kg packs never earn a 10 kg tier: the 10 kg tier names its own
 * pack variant (F11).
 */
function lineQualifiesForTier(line, tiersById, cycleCode) {
  if (!line.heroTier) return { qualifies: false, reason: "NOT_A_HERO_LINE" };
  const tierId = str(line.heroTier.tierId, "heroTier.tierId");
  const tier = tiersById && Object.prototype.hasOwnProperty.call(tiersById, tierId) ? tiersById[tierId] : null;
  if (!tier) return { qualifies: false, reason: "UNKNOWN_TIER" };
  if (tier.active !== true) return { qualifies: false, reason: "TIER_INACTIVE" };
  if (tier.cycleCode !== cycleCode) return { qualifies: false, reason: "TIER_OTHER_CYCLE" };
  if (line.heroTier.heroWeekId !== tier.heroWeekId) return { qualifies: false, reason: "HERO_WEEK_MISMATCH" };
  if (line.shopifyVariantGid !== tier.packVariantGid) return { qualifies: false, reason: "NOT_THE_TIER_PACK" };
  if (line.unit !== tier.unit) return { qualifies: false, reason: "UNIT_MISMATCH" };
  const packQty = posInt(tier.packQty, "tier.packQty");
  const maxPacks = posInt(tier.maxPacksPerLine, "tier.maxPacksPerLine");
  if (line.qty % packQty !== 0) return { qualifies: false, reason: "NOT_WHOLE_PACKS" };
  const packs = line.qty / packQty;
  if (packs > maxPacks) return { qualifies: false, reason: "TOO_MANY_PACKS" };
  return { qualifies: true, packs };
}

/**
 * Feature-local Community eligibility (F01, F03; contract §1.2).
 * Sums CEILING line totals of tier-qualified Hero lines, separately per door.
 * Never adds one door's lines to another's subtotal.
 */
function eligibilityByDoor({ cycleCode, lines, tiersById }) {
  str(cycleCode, "cycleCode");
  if (!Array.isArray(lines)) throw new KernelError("INVALID_LINES");
  const out = {};
  for (const door of ELIGIBLE_DOORS) out[door] = { qualifyingCeilingPaisa: 0, eligible: false, qualifyingLineIds: [] };
  const seen = new Set();
  for (const line of lines) {
    str(line.lineId, "lineId");
    if (seen.has(line.lineId)) throw new KernelError("DUPLICATE_LINE_ID", line.lineId);
    seen.add(line.lineId);
    if (!ALL_DOORS.has(line.door)) throw new KernelError("UNKNOWN_DOOR", line.door);
    if (!UNITS.has(line.unit)) throw new KernelError("UNKNOWN_UNIT", line.unit);
    posInt(line.qty, "qty");
    nonNegInt(line.ceilingLinePaisa, "ceilingLinePaisa");
    if (!out[line.door]) continue; // apna_order, bhao_tao: never eligible
    const q = lineQualifiesForTier(line, tiersById, cycleCode);
    if (!q.qualifies) continue;
    const d = out[line.door];
    d.qualifyingCeilingPaisa = checkedSum(d.qualifyingCeilingPaisa, line.ceilingLinePaisa);
    d.qualifyingLineIds.push(line.lineId);
  }
  for (const door of ELIGIBLE_DOORS) out[door].eligible = out[door].qualifyingCeilingPaisa >= THRESHOLD_PAISA;
  return out;
}

/**
 * Sticky eligibility (F04, R1). What happens to an already-accepted
 * eligibility when something changes before or at lock.
 *
 *   collective_price_drop  keep: a lower price never revokes eligibility
 *   asb_shortage           keep: ASB's short pack never revokes it (F12/R1)
 *   customer_edit          recompute at ceiling on the NEW committed lines
 */
function eligibilityAfterChange({ previous, reason, recompute }) {
  if (!previous || typeof previous !== "object") throw new KernelError("INVALID_PREVIOUS");
  if (reason === "collective_price_drop" || reason === "asb_shortage") return previous;
  if (reason === "customer_edit") {
    if (typeof recompute !== "function") throw new KernelError("RECOMPUTE_REQUIRED");
    return recompute();
  }
  throw new KernelError("UNKNOWN_CHANGE_REASON", String(reason));
}

/** round-half-up of a non-negative BigInt ratio, as a safe Number */
function roundHalfUpDiv(numer, denom) {
  const q = numer / denom, r = numer % denom;
  const v = r * 2n >= denom ? q + 1n : q;
  const n = Number(v);
  if (!Number.isSafeInteger(n)) throw new KernelError("OVERFLOW");
  return n;
}

/**
 * Billed amount for one line after weighing (F05, R2, contract §7).
 *
 *   unit "g":     rate is paisa per kg;    amount = round-half-up(g × rate / 1000)
 *   unit "piece": rate is paisa per piece; amount = pieces × rate
 *   billed = min(ceilingLinePaisa, amount); nothing packed => 0.
 *
 * Overpacking never raises the bill above the accepted line ceiling; a short
 * pack bills delivered quantity at the locked rate.
 */
function lineBilledPaisa({ unit, packedQty, ratePaisa, ceilingLinePaisa }) {
  if (!UNITS.has(unit)) throw new KernelError("UNKNOWN_UNIT", unit);
  nonNegInt(packedQty, "packedQty");
  nonNegInt(ratePaisa, "ratePaisa");
  nonNegInt(ceilingLinePaisa, "ceilingLinePaisa");
  if (packedQty === 0) return 0;
  const amount = unit === "g"
    ? roundHalfUpDiv(BigInt(packedQty) * BigInt(ratePaisa), 1000n)
    : (() => { const v = packedQty * ratePaisa; if (!Number.isSafeInteger(v)) throw new KernelError("OVERFLOW"); return v; })();
  return Math.min(ceilingLinePaisa, amount);
}

/**
 * Cash-on-delivery payable (R2): sum lines in paisa, round DOWN once to a
 * whole rupee, show the difference as a rounding credit. Never above the
 * order ceiling.
 */
function codPayable({ lineBilledPaisa: lines, orderCeilingPaisa }) {
  if (!Array.isArray(lines)) throw new KernelError("INVALID_LINES");
  let total = 0;
  for (const p of lines) total = checkedSum(total, nonNegInt(p, "lineBilledPaisa"));
  nonNegInt(orderCeilingPaisa, "orderCeilingPaisa");
  const capped = Math.min(total, orderCeilingPaisa);
  const payable = Math.floor(capped / 100) * 100;
  return { billedPaisa: capped, payablePaisa: payable, roundingCreditPaisa: capped - payable };
}

// ---------------------------------------------------------------------------
// Verification (docs/community-verification-policy-v1.md, ADR-002-VERIFY-001,
// founder-approved 5 Nov 2026). Three SEPARATE dimensions:
//   verificationState   pending | under_review | verified | rejected | cancelled
//   fulfillmentState    none | locked | packed | fulfilled | paid | refused
//   paymentSecurityState unsecured_cod | deposit_confirmed | prepaid_confirmed
// ---------------------------------------------------------------------------
const VERIFICATION_STATES = new Set(["pending", "under_review", "verified", "rejected", "cancelled"]);
const FULFILLMENT_STATES = new Set(["none", "locked", "packed", "fulfilled", "paid", "refused"]);
const SECURED = new Set(["deposit_confirmed", "prepaid_confirmed"]);

/**
 * The V1 baseline is NOT optional: a policy that switches off any of the four
 * evidence classes, counts pending, or skips WhatsApp is refused outright, so
 * configuration can never approve a weaker rule (fail closed).
 */
function validatePolicy(policy) {
  if (!policy || typeof policy !== "object") return { ok: false, reason: "NO_POLICY" };
  if (typeof policy.policyVersion !== "string" || !policy.policyVersion.trim()) return { ok: false, reason: "NO_POLICY_VERSION" };
  for (const k of ["requireOrderBeforeCutoff", "requireOrderSpecificWhatsappConfirmation",
                   "requireServiceableHouseholdAddress", "requireRiskGateApproval"]) {
    if (policy[k] !== true) return { ok: false, reason: "BASELINE_WEAKENED:" + k };
  }
  if (policy.countPendingTowardUnlock !== false) return { ok: false, reason: "BASELINE_WEAKENED:countPendingTowardUnlock" };
  if (policy.allowTrustedSkipWhatsapp !== false) return { ok: false, reason: "BASELINE_WEAKENED:allowTrustedSkipWhatsapp" };
  return { ok: true };
}

const time = (v) => { const t = typeof v === "string" ? Date.parse(v) : NaN; return Number.isFinite(t) ? t : null; };

/**
 * Decide a commitment's verification state from SERVER-SIDE evidence records
 * (never client booleans). Returns { state, reasons, policyVersion? }.
 *
 * commitment: { quoteId, quoteVersion, customerPhone, locksAt,
 *               paymentSecurityRequired, paymentSecurityState }
 * evidence:
 *   order    { serverOrderId, acceptedAt, cutoffAt }             // class 1
 *   whatsapp { quoteId, quoteVersion, fromPhone, messageId,
 *              webhookSignatureValid }                             // class 2
 *   address  { state: "serviceable" | "trusted_delivered" | ... }  // class 3
 *   risk     { state: "passed" | "overridden" | "flagged" | ..., operator?, reason? } // class 4
 *   payment  { state, providerRef }   only when security is required // class 5
 *   at       ISO time of this verification decision
 */
function verifyCommitment({ commitment, policy, evidence }) {
  const p = validatePolicy(policy);
  if (!p.ok) return { state: "pending", reasons: [p.reason] };
  if (!commitment || typeof commitment !== "object") return { state: "pending", reasons: ["NO_COMMITMENT"] };
  const e = evidence || {};
  const reasons = [];

  // 1. accepted on ASB's server before the cutoff
  const accepted = e.order && time(e.order.acceptedAt), cutoff = e.order && time(e.order.cutoffAt);
  if (!e.order || typeof e.order.serverOrderId !== "string" || !e.order.serverOrderId) reasons.push("NO_SERVER_ORDER");
  else if (accepted === null || cutoff === null || accepted >= cutoff) reasons.push("ORDER_NOT_BEFORE_CUTOFF");

  // 2. order-specific WhatsApp confirmation for THIS quote version, from the customer's phone
  const w = e.whatsapp;
  if (!w || w.webhookSignatureValid !== true || typeof w.messageId !== "string" || !w.messageId) reasons.push("NO_VALID_WHATSAPP_CONFIRMATION");
  else if (w.quoteId !== commitment.quoteId || w.quoteVersion !== commitment.quoteVersion) reasons.push("WHATSAPP_FOR_OTHER_QUOTE_VERSION");
  else if (!commitment.customerPhone || w.fromPhone !== commitment.customerPhone) reasons.push("WHATSAPP_FROM_OTHER_PHONE");

  // 3. serviceable household address
  if (!e.address || (e.address.state !== "serviceable" && e.address.state !== "trusted_delivered")) reasons.push("ADDRESS_NOT_SERVICEABLE");

  // 5. payment security, only when required for this order: provider-confirmed only
  if (commitment.paymentSecurityRequired === true) {
    if (!e.payment || !SECURED.has(e.payment.state) || typeof e.payment.providerRef !== "string" || !e.payment.providerRef) {
      reasons.push("PAYMENT_SECURITY_NOT_PROVIDER_CONFIRMED");
    }
  }

  // verification after lock never counts
  const at = time(e.at), locksAt = time(commitment.locksAt);
  if (at === null || locksAt === null || at > locksAt) reasons.push("AFTER_LOCK_OR_NO_TIME");

  // 4. risk gate: a flag sends the commitment to human review, not rejection
  const risk = e.risk && e.risk.state;
  const riskPassed = risk === "passed" || (risk === "overridden" && typeof e.risk.operator === "string" && e.risk.operator && typeof e.risk.reason === "string" && e.risk.reason);
  if (!riskPassed) {
    if (risk === "flagged") return { state: "under_review", reasons: ["RISK_FLAGGED", ...reasons] };
    reasons.push("RISK_GATE_NOT_PASSED");
  }

  if (reasons.length) return { state: "pending", reasons };
  return { state: "verified", reasons: [], policyVersion: policy.policyVersion };
}

/**
 * Collective Rate Meter for one cycle (F02, F13; policy tests 1-5, 8).
 * Counts packs only from commitments that are:
 *   - in THIS cycle, from Community / Dish-to-Cart / Budget-to-Cart,
 *   - verificationState "verified" and fulfillmentState not "refused",
 *   - the LATEST version of their quote chain (an edited order supersedes its
 *     earlier versions, whatever state they were left in).
 * A replay of the same commitment counts once; a conflicting replay fails.
 */
function rateMeter({ cycleCode, commitments }) {
  str(cycleCode, "cycleCode");
  if (!Array.isArray(commitments)) throw new KernelError("INVALID_COMMITMENTS");
  const byId = new Map();
  for (const c of commitments) {
    str(c.commitmentId, "commitmentId");
    str(c.quoteId, "quoteId");
    posInt(c.quoteVersion, "quoteVersion");
    if (!VERIFICATION_STATES.has(c.verificationState)) throw new KernelError("UNKNOWN_VERIFICATION_STATE", c.verificationState);
    if (!FULFILLMENT_STATES.has(c.fulfillmentState)) throw new KernelError("UNKNOWN_FULFILLMENT_STATE", c.fulfillmentState);
    const prev = byId.get(c.commitmentId);
    if (prev) {
      if (prev.tierId !== c.tierId || prev.packs !== c.packs || prev.cycleCode !== c.cycleCode || prev.door !== c.door
          || prev.quoteId !== c.quoteId || prev.quoteVersion !== c.quoteVersion) {
        throw new KernelError("CONFLICTING_DUPLICATE_COMMITMENT", c.commitmentId);
      }
      continue;
    }
    byId.set(c.commitmentId, c);
  }
  // a quote chain lives in one cycle; its latest version wins
  const latest = new Map(), chainCycle = new Map();
  for (const c of byId.values()) {
    const cyc = chainCycle.get(c.quoteId);
    if (cyc !== undefined && cyc !== c.cycleCode) throw new KernelError("QUOTE_CHAIN_CROSSES_CYCLES", c.quoteId);
    chainCycle.set(c.quoteId, c.cycleCode);
    latest.set(c.quoteId, Math.max(latest.get(c.quoteId) || 0, c.quoteVersion));
  }
  const tiers = {};
  const bucket = (id) => tiers[id] || (tiers[id] = { verifiedPacks: 0, pendingPacks: 0, underReviewPacks: 0,
    refusedPacks: 0, cancelledOrRejectedPacks: 0, supersededPacks: 0, paymentSecuredPacks: 0, commitments: 0 });
  for (const c of byId.values()) {
    if (c.cycleCode !== cycleCode) continue;
    if (!ELIGIBLE_DOORS.includes(c.door)) throw new KernelError("DOOR_CANNOT_COMMIT", c.door);
    const t = bucket(c.tierId), packs = posInt(c.packs, "packs");
    if (c.quoteVersion < latest.get(c.quoteId)) { t.supersededPacks = checkedSum(t.supersededPacks, packs); continue; }
    if (c.verificationState === "verified" && c.fulfillmentState !== "refused") {
      t.verifiedPacks = checkedSum(t.verifiedPacks, packs); t.commitments += 1;
      if (SECURED.has(c.paymentSecurityState)) t.paymentSecuredPacks = checkedSum(t.paymentSecuredPacks, packs);
    } else if (c.fulfillmentState === "refused") t.refusedPacks = checkedSum(t.refusedPacks, packs);
    else if (c.verificationState === "pending") t.pendingPacks = checkedSum(t.pendingPacks, packs);
    else if (c.verificationState === "under_review") t.underReviewPacks = checkedSum(t.underReviewPacks, packs);
    else t.cancelledOrRejectedPacks = checkedSum(t.cancelledOrRejectedPacks, packs);
  }
  return tiers;
}

module.exports = {
  THRESHOLD_PAISA, ELIGIBLE_DOORS, KernelError,
  lineQualifiesForTier, eligibilityByDoor, eligibilityAfterChange,
  lineBilledPaisa, codPayable, validatePolicy, verifyCommitment, rateMeter,
};
