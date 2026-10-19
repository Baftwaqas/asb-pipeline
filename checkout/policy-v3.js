// ASB Checkout Policy V3 — pure, dependency-free domain evaluator.
// DEV CANDIDATE ONLY. The storefront and checkout backend MUST run this with
// SERVER-VERIFIED prices, product types, pack options and tier configuration.
// This module is not wired to Shopify or production order placement yet.
"use strict";

const COMMUNITY_MIN_PAISA = 1200 * 100;
const GROCERY = new Set(["apna_order", "community_bulk_buying", "dish_to_cart", "budget_to_cart"]);

function amount(v, name) {
  if (!Number.isSafeInteger(v) || v < 0) throw new TypeError(name + " must be a non-negative integer in paisa");
  return v;
}
function price(n) { return "Rs " + (n / 100).toLocaleString("en-US",{minimumFractionDigits:0,maximumFractionDigits:2}); }
function reject(feature, code, extras = {}) {
  return { allowed:false, feature, code, deliveryPaisa:null, ...extras };
}

/**
 * item: { productId, variantId, kind:'grocery'|'community',
 *         quantity, unitPricePaisa, allowedVariantIds:[...] }
 * All commercial fields MUST come from a trusted server-side catalogue quote.
 * Any frontend-only implementation can be bypassed and is NOT checkout enforcement.
 */
function evaluate({ feature, items, discountPaisa=0, budgetTierPaisa=null,
                    approvedWeeklyTiersPaisa=null, budgetMinimumSpendPaisa=null } = {}) {
  if (!GROCERY.has(feature)) return reject(feature, feature === "bhao_tao" ?
    "NON_GROCERY_POLICY_PENDING" : "UNKNOWN_FEATURE");
  if (!Array.isArray(items)) throw new TypeError("items must be a verified array");
  const discount = amount(discountPaisa,"discountPaisa");
  let subtotal = 0;
  const products = new Set();
  for (const line of items) {
    if (!line || !line.productId || !line.variantId ||
        !Number.isSafeInteger(line.quantity) || line.quantity < 1) throw new TypeError("invalid cart line");
    const unit = amount(line.unitPricePaisa,"unitPricePaisa");
    const expectedKind = feature === "community_bulk_buying" ? "community" : "grocery";
    if (line.kind !== expectedKind) return reject(feature,"WRONG_FEATURE_CART");
    if (feature === "community_bulk_buying") {
      if (line.quantity !== 1) return reject(feature,"COMMUNITY_ONE_PACK_PER_PRODUCT");
      if (products.has(String(line.productId))) return reject(feature,"COMMUNITY_ONE_PACK_PER_PRODUCT");
      if (!Array.isArray(line.allowedVariantIds) || !line.allowedVariantIds.map(String).includes(String(line.variantId))) {
        return reject(feature,"COMMUNITY_UNOFFERED_PACK");
      }
    }
    products.add(String(line.productId));
    const cost = unit * line.quantity;
    if (!Number.isSafeInteger(cost) || !Number.isSafeInteger(subtotal + cost)) throw new RangeError("cart amount overflow");
    subtotal += cost;
  }
  if (!items.length) return reject(feature,"EMPTY_CART");
  if (discount > subtotal) return reject(feature,"INVALID_DISCOUNT");
  const payable = subtotal - discount; // All ASB grocery features: FREE DELIVERY.

  let minimum = 0;
  if (feature === "community_bulk_buying") minimum = COMMUNITY_MIN_PAISA;
  if (feature === "budget_to_cart") {
    if (!Array.isArray(approvedWeeklyTiersPaisa) ||
        !Number.isSafeInteger(budgetTierPaisa) ||
        !Number.isSafeInteger(budgetMinimumSpendPaisa) ||
        budgetTierPaisa <= COMMUNITY_MIN_PAISA ||
        budgetMinimumSpendPaisa <= COMMUNITY_MIN_PAISA ||
        budgetMinimumSpendPaisa > budgetTierPaisa ||
        !approvedWeeklyTiersPaisa.includes(budgetTierPaisa)) {
      return reject(feature,"BUDGET_TIERS_NOT_APPROVED");
    }
    minimum = budgetMinimumSpendPaisa;
    if (payable > budgetTierPaisa) return reject(feature,"BUDGET_EXCEEDED",{
      subtotalPaisa:subtotal,discountPaisa:discount,payablePaisa:payable,
      budgetTierPaisa,
      nudgeRomanUrdu:"Aap ka chuna hua weekly budget "+price(budgetTierPaisa)+
        " hai. Basket se "+price(payable-budgetTierPaisa)+" kam karein."
    });
  }
  if (payable < minimum) return reject(feature,"MINIMUM_NOT_REACHED",{
    subtotalPaisa:subtotal,discountPaisa:discount,payablePaisa:payable,
    minimumPaisa:minimum,shortfallPaisa:minimum-payable,deliveryPaisa:0,
    nudgeRomanUrdu:"Bas "+price(minimum-payable)+" ka saman aur add karein. Delivery bilkul FREE hai!"
  });
  return {allowed:true,code:"READY",feature,subtotalPaisa:subtotal,
          discountPaisa:discount,deliveryPaisa:0,payablePaisa:payable,
          minimumPaisa:minimum,budgetTierPaisa:feature==="budget_to_cart"?budgetTierPaisa:null,
          nudgeRomanUrdu:"Order confirm kar sakte hain. Delivery bilkul FREE hai!"};
}

module.exports = { evaluate, COMMUNITY_MIN_PAISA };
