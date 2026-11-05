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

// Commitment lifecycle (F13). Only these count toward the live meter.
const METER_STATUSES = new Set(["verified", "locked", "fulfilled", "paid"]);
const ALL_STATUSES = new Set(["pending", "verified", "locked", "fulfilled", "paid", "cancelled", "refused"]);

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

/**
 * Promote a pending commitment to verified ONLY under an explicitly approved,
 * versioned verification rule (R3, E1). No rule, or an unapproved rule, fails
 * closed: the commitment stays pending and is not counted.
 *
 * rule = { version, approved: true, requires: [ ...evidence keys ] }
 * evidence = { server_order_before_cutoff: true, whatsapp_confirmation: true, ... }
 */
function verifyCommitment({ commitment, rule, evidence }) {
  if (!commitment || commitment.status !== "pending") return { status: commitment && commitment.status, changed: false, reason: "NOT_PENDING" };
  if (!rule || rule.approved !== true || typeof rule.version !== "string" || !Array.isArray(rule.requires) || rule.requires.length === 0) {
    return { status: "pending", changed: false, reason: "NO_APPROVED_RULE" };
  }
  for (const key of rule.requires) {
    if (!evidence || evidence[key] !== true) return { status: "pending", changed: false, reason: "MISSING_EVIDENCE:" + key };
  }
  return { status: "verified", changed: true, ruleVersion: rule.version };
}

/**
 * Collective Rate Meter for one cycle (F02, F13, R3).
 * Counts packs of VERIFIED-or-later commitments, once per commitmentId, from
 * Community, Dish-to-Cart and Budget-to-Cart, in THIS cycle only. Pending,
 * cancelled and refused are reported separately and never counted.
 */
function rateMeter({ cycleCode, commitments }) {
  str(cycleCode, "cycleCode");
  if (!Array.isArray(commitments)) throw new KernelError("INVALID_COMMITMENTS");
  const byId = new Map();
  for (const c of commitments) {
    str(c.commitmentId, "commitmentId");
    if (!ALL_STATUSES.has(c.status)) throw new KernelError("UNKNOWN_STATUS", c.status);
    const prev = byId.get(c.commitmentId);
    if (prev) {
      // The same commitment delivered twice must be identical, else refuse.
      if (prev.tierId !== c.tierId || prev.packs !== c.packs || prev.cycleCode !== c.cycleCode || prev.door !== c.door) {
        throw new KernelError("CONFLICTING_DUPLICATE_COMMITMENT", c.commitmentId);
      }
      continue;
    }
    byId.set(c.commitmentId, c);
  }
  const tiers = {};
  for (const c of byId.values()) {
    if (c.cycleCode !== cycleCode) continue;
    if (!ELIGIBLE_DOORS.includes(c.door)) throw new KernelError("DOOR_CANNOT_COMMIT", c.door);
    const t = tiers[c.tierId] || (tiers[c.tierId] = { verifiedPacks: 0, pendingPacks: 0, cancelledPacks: 0, refusedPacks: 0, commitments: 0 });
    const packs = posInt(c.packs, "packs");
    if (METER_STATUSES.has(c.status)) { t.verifiedPacks = checkedSum(t.verifiedPacks, packs); t.commitments += 1; }
    else if (c.status === "pending") t.pendingPacks = checkedSum(t.pendingPacks, packs);
    else if (c.status === "cancelled") t.cancelledPacks = checkedSum(t.cancelledPacks, packs);
    else if (c.status === "refused") t.refusedPacks = checkedSum(t.refusedPacks, packs);
  }
  return tiers;
}

module.exports = {
  THRESHOLD_PAISA, ELIGIBLE_DOORS, KernelError,
  lineQualifiesForTier, eligibilityByDoor, eligibilityAfterChange,
  lineBilledPaisa, codPayable, verifyCommitment, rateMeter,
};
