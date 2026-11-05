// ADR-002 | Apna Order per-product cycle maximums.
// Pure evaluator: NOT checkout enforcement without atomic server reservation.
"use strict";
const APNA = "apna_order";
const INACTIVE = new Set(["cancelled", "canceled", "void", "rejected", "expired"]);

function nonempty(value, name) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(name + " must be nonempty");
  return value.trim();
}
function integerQuantity(n, name) {
  if (!Number.isSafeInteger(n) || n <= 0) throw new TypeError(name + " must be a positive safe integer");
  return n;
}
function sum(a, b) {
  const value = a + b;
  if (!Number.isSafeInteger(value)) throw new RangeError("quantity overflow");
  return value;
}
function ruleFor(limitsByProduct, productId) {
  if (!limitsByProduct || !Object.prototype.hasOwnProperty.call(limitsByProduct, productId)) {
    throw new Error("MISSING_APNA_LIMIT: " + productId);
  }
  const rule = limitsByProduct[productId];
  if (!rule || typeof rule !== "object") throw new TypeError("invalid product limit");
  return {unit: nonempty(rule.unit, "rule.unit"), maxQuantity: integerQuantity(rule.maxQuantity, "rule.maxQuantity")};
}

/**
 * Use trusted, SERVER-RESOLVED canonical product IDs, household identity, cycle,
 * current active order/reservation lines, and SKU limits. Quantities are integer
 * canonical base units (e.g. g, pcs); never Shopify variant counts or kg floats.
 *
 * incomingLines = full proposed order, not just an amendment delta.
 * existingCycleLines = current active/reserved/fulfilled lines in cycle.
 * editingOrderId = omit old lines of this order when replacing it.
 *
 * This function cannot prevent concurrent orders without a transactional lock.
 */
function evaluateApnaCycleLimits({
  householdKey, cycleCode, incomingLines, existingCycleLines = [],
  limitsByProduct, editingOrderId = null
} = {}) {
  const household = nonempty(householdKey, "householdKey");
  const cycle = nonempty(cycleCode, "cycleCode");
  if (!Array.isArray(incomingLines) || !Array.isArray(existingCycleLines)) {
    throw new TypeError("lines must be arrays");
  }
  if (editingOrderId !== null) nonempty(editingOrderId, "editingOrderId");
  const proposed = new Map();
  const previous = new Map();
  const rules = new Map();

  function accumulate(map, line, context) {
    const id = nonempty(line.productId, context + ".productId");
    const rule = ruleFor(limitsByProduct, id);
    const unit = nonempty(line.unit, context + ".unit");
    if (unit !== rule.unit) throw new Error("UNIT_MISMATCH: " + id);
    const qty = integerQuantity(line.quantityBaseUnits, context + ".quantityBaseUnits");
    map.set(id, sum(map.get(id) || 0, qty));
    rules.set(id, rule);
  }
  incomingLines.forEach((line, idx) => {
    if (!line || typeof line !== "object") throw new TypeError("invalid incoming line");
    if (line.door === APNA) accumulate(proposed, line, "incomingLines[" + idx + "]");
  });
  existingCycleLines.forEach((line, idx) => {
    if (!line || typeof line !== "object") throw new TypeError("invalid prior line");
    if (line.door !== APNA || line.householdKey !== household || line.cycleCode !== cycle ||
        INACTIVE.has(line.status) ||
        (editingOrderId !== null && line.orderId === editingOrderId)) return;
    if (proposed.has(line.productId)) accumulate(previous, line, "existingCycleLines[" + idx + "]");
  });

  const products = [];
  const violations = [];
  for (const [productId, incomingQuantity] of proposed) {
    const alreadyCommittedQuantity = previous.get(productId) || 0;
    const totalQuantity = sum(incomingQuantity, alreadyCommittedQuantity);
    const rule = rules.get(productId);
    const result = {productId, unit: rule.unit, maxQuantity: rule.maxQuantity,
      incomingQuantity, alreadyCommittedQuantity, totalQuantity};
    products.push(result);
    if (totalQuantity > rule.maxQuantity) violations.push({...result, code: "APNA_CYCLE_MAX_EXCEEDED"});
  }
  return {allowed: violations.length === 0, violations, products};
}
module.exports = {evaluateApnaCycleLimits};
