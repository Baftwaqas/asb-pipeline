// ADR-002 | Apna Order product-specific size ladder, minimum and cycle maximum.
// Pure evaluator only: callers MUST use an atomic server-side reservation.
"use strict";

const APNA = "apna_order";
const INACTIVE = new Set(["cancelled", "canceled", "void", "rejected", "expired"]);
const ACTIVE = new Set([
  "pending", "confirmed", "locked", "packed", "out_for_delivery",
  "delivered", "reserved", "creating", "needs_reconcile", "verified",
  "fulfilled", "paid", "on_hold"
]);
const MAX_PACK_LADDER_DP = 200000;

function nonempty(value, name) {
  if (typeof value !== "string" || !value.trim())
    throw new TypeError(name + " must be nonempty");
  return value.trim();
}
function positiveSafeInteger(n, name) {
  if (!Number.isSafeInteger(n) || n <= 0)
    throw new TypeError(name + " must be a positive safe integer");
  return n;
}
function sum(a, b) {
  const result = a + b;
  if (!Number.isSafeInteger(result)) throw new RangeError("quantity overflow");
  return result;
}
function statusOf(value) {
  const status = nonempty(value, "existing status").toLowerCase();
  if (!ACTIVE.has(status) && !INACTIVE.has(status))
    throw new Error("UNKNOWN_ORDER_STATUS: " + status);
  return status;
}

function ruleFor(limitsByProduct, canonicalProductId) {
  if (!limitsByProduct || !Object.prototype.hasOwnProperty.call(limitsByProduct, canonicalProductId))
    throw new Error("MISSING_APNA_LIMIT: " + canonicalProductId);
  const raw = limitsByProduct[canonicalProductId];
  if (!raw || typeof raw !== "object") throw new TypeError("invalid product quantity rule");
  const unit = nonempty(raw.unit, "rule.unit");
  if (unit !== "g" && unit !== "piece") throw new TypeError("rule.unit must be g or piece");
  const minQuantity = positiveSafeInteger(raw.minQuantity, "rule.minQuantity");
  const maxQuantity = positiveSafeInteger(raw.maxQuantity, "rule.maxQuantity");
  if (minQuantity > maxQuantity) throw new TypeError("minQuantity exceeds maxQuantity");

  const hasSizes = Object.prototype.hasOwnProperty.call(raw, "allowedSizes");
  const hasStep = Object.prototype.hasOwnProperty.call(raw, "stepQuantity");
  if (hasSizes === hasStep)
    throw new TypeError("APNA_LADDER_REQUIRED: supply allowedSizes OR stepQuantity");
  if (hasStep) {
    const stepQuantity = positiveSafeInteger(raw.stepQuantity, "rule.stepQuantity");
    return {unit, minQuantity, maxQuantity, stepQuantity, allowedSizes: null};
  }
  if (!Array.isArray(raw.allowedSizes) || !raw.allowedSizes.length || raw.allowedSizes.length > 32)
    throw new TypeError("allowedSizes must be a nonempty array of at most 32 packs");
  const sizes = [...new Set(raw.allowedSizes.map(v => positiveSafeInteger(v, "allowedSizes pack")))]
    .sort((a, b) => a - b);
  if (sizes[0] !== minQuantity || sizes.some(s => s > maxQuantity))
    throw new TypeError("allowedSizes must include minimum pack and stay within maxQuantity");
  return {unit, minQuantity, maxQuantity, stepQuantity: null, allowedSizes: sizes};
}

// A line is valid when its quantity can be assembled from approved pack sizes.
// Example: 375 g = 125 g + 250 g, if both packs are approved.
// This is a quantity validator, not a price or packing-manifest calculator.
function matchesApprovedLadder(qty, rule) {
  if (rule.allowedSizes === null)
    return (qty - rule.minQuantity) % rule.stepQuantity === 0;
  if (qty > MAX_PACK_LADDER_DP)
    throw new RangeError("PACK_LADDER_EVALUATION_LIMIT: use explicit stepQuantity or reduce configured cap");
  const reachable = new Uint8Array(qty + 1);
  reachable[0] = 1;
  for (let i = 1; i <= qty; i++) {
    for (const pack of rule.allowedSizes) {
      if (pack > i) break;
      if (reachable[i - pack]) {reachable[i] = 1; break;}
    }
  }
  return reachable[qty] === 1;
}

/**
 * Uses the accepted quote-contract field names: canonicalProductId, unit, qty,
 * door. Units are integer grams or pieces; do NOT pass kg floats or Shopify
 * variant count. All identifiers, rules and existing reservations are trusted
 * SERVER-RESOLVED values, not frontend assertions.
 *
 * Incoming is the full proposed order (not only the amendment delta).
 * Previous is all active/reserved orders in the same household/cycle.
 * Edits may explicitly remove the replaced order's prior lines.
 *
 * Pure check only: a transaction-safe Postgres household+cycle lock and quote
 * reservation is REQUIRED to prevent concurrent overselling of caps.
 */
function evaluateApnaCycleLimits({
  householdKey, cycleCode, incomingLines, existingCycleLines = [],
  limitsByProduct, editingOrderId = null
} = {}) {
  const household = nonempty(householdKey, "householdKey");
  const cycle = nonempty(cycleCode, "cycleCode");
  if (!Array.isArray(incomingLines) || !Array.isArray(existingCycleLines))
    throw new TypeError("lines must be arrays");
  if (editingOrderId !== null) nonempty(editingOrderId, "editingOrderId");

  const proposed = new Map(), previous = new Map(), rules = new Map();
  const violations = [];

  function parse(line, context) {
    const id = nonempty(line.canonicalProductId, context + ".canonicalProductId");
    const rule = ruleFor(limitsByProduct, id);
    const unit = nonempty(line.unit, context + ".unit");
    if (unit !== rule.unit) throw new Error("UNIT_MISMATCH: " + id);
    const qty = positiveSafeInteger(line.qty, context + ".qty");
    rules.set(id, rule);
    return {id, qty, rule};
  }

  incomingLines.forEach((line, index) => {
    if (!line || typeof line !== "object") throw new TypeError("invalid incoming line");
    if (line.door !== APNA) return; // Dish/Budget/Community never consume Apna entitlement.
    const {id, qty, rule} = parse(line, "incomingLines[" + index + "]");
    const lineResult = {canonicalProductId:id, qty, unit:rule.unit,
      minQuantity:rule.minQuantity, maxQuantity:rule.maxQuantity};
    if (qty < rule.minQuantity) {
      violations.push({...lineResult, code:"APNA_BELOW_PRODUCT_MINIMUM"});
    } else if (qty <= rule.maxQuantity && !matchesApprovedLadder(qty, rule)) {
      violations.push({...lineResult, code:"APNA_NOT_AN_APPROVED_SIZE"});
    }
    proposed.set(id, sum(proposed.get(id) || 0, qty));
  });

  existingCycleLines.forEach((line, index) => {
    if (!line || typeof line !== "object") throw new TypeError("invalid previous line");
    if (line.door !== APNA || line.householdKey !== household || line.cycleCode !== cycle ||
        (editingOrderId !== null && line.orderId === editingOrderId)) return;
    // Only prior lines of a product in the NEW Apna order consume its cap.
    // Legacy/unconfigured products (e.g. lemons) must not block unrelated
    // configured items. Incoming unconfigured products still fail closed.
    if (!proposed.has(line.canonicalProductId)) return;
    const state = statusOf(line.status); // unknown relevant status fails closed.
    if (INACTIVE.has(state)) return;
    const {id, qty} = parse(line, "existingCycleLines[" + index + "]");
    previous.set(id, sum(previous.get(id) || 0, qty));
  });

  const products = [];
  for (const [canonicalProductId, incomingQuantity] of proposed) {
    const alreadyCommittedQuantity = previous.get(canonicalProductId) || 0;
    const totalQuantity = sum(incomingQuantity, alreadyCommittedQuantity);
    const rule = rules.get(canonicalProductId);
    const item = {canonicalProductId, unit:rule.unit, minQuantity:rule.minQuantity,
      maxQuantity:rule.maxQuantity, incomingQuantity, alreadyCommittedQuantity, totalQuantity};
    products.push(item);
    if (totalQuantity > rule.maxQuantity)
      violations.push({...item, code:"APNA_CYCLE_MAX_EXCEEDED"});
  }

  return {allowed:violations.length === 0, violations, products};
}

module.exports = {evaluateApnaCycleLimits};
