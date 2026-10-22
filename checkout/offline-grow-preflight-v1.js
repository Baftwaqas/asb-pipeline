// ASB / Shopify Grow — OFFLINE, READ-ONLY checkout preflight proof.
// NOT connected to Shopify, routes, Draft Orders, Neon, or any live system.
// NOT a checkout validation function. Passing this check DOES NOT prevent
// direct Shopify checkout/cart API bypass. The real hard gate is TBD.
//
// IMPORTANT TRUST BOUNDARY:
//   requestedLines: customer-controlled selections (lineRef, variantId, quantity,
//                   claimedFeature). NO customer prices or discounts are used.
//   catalogByVariant: fetched and validated by trusted server, NEVER browser.
//   verifiedBindingsByLineRef: issued/verified server-side; keys must bind the
//                   same variant/quantity/origin, NOT an unchecked form field.
//   trustedDiscountByLineRef: server-calculated and reconciled against Shopify,
//                   NEVER a browser-supplied discount. Discount reconciliation
//                   with Shopify still needs a real integration and tests.
//
// An owner must separately approve the Shopify enforcement mechanism before
// this can back any order-creation API. No automatic order is ever created here.
'use strict';

const { evaluate, COMMUNITY_MIN_PAISA } = require('./policy-v3');

const GROCERY_FEATURES = new Set(['apna_order', 'dish_to_cart', 'community_bulk_buying', 'budget_to_cart']);
const ALLOWED_FEATURES = new Set([...GROCERY_FEATURES, 'bhao_tao']);

function fail(code, message, extra = {}) {
  return { allowed: false, code, message, enforcedInShopify: false, ...extra };
}
function nonnegativeInteger(n) { return Number.isSafeInteger(n) && n >= 0; }
function positiveInteger(n) { return Number.isSafeInteger(n) && n > 0; }
function keyOf(id) { return typeof id === 'string' && id.length && id.length <= 120 ? id : null; }
function safeAdd(a, b) {
  if (!nonnegativeInteger(a) || !nonnegativeInteger(b) || !Number.isSafeInteger(a + b)) throw new RangeError('unsafe money amount');
  return a + b;
}
function own(o, key) { return Object.prototype.hasOwnProperty.call(o, key); }

function preflight({requestedLines, catalogByVariant, verifiedBindingsByLineRef,
                    trustedDiscountByLineRef = {}, shippingPaisa = 0,
                    taxPaisa = 0, currency = 'PKR'} = {}) {
  // These objects MUST be server-supplied and/or independently authenticated.
  if (!Array.isArray(requestedLines) || !requestedLines.length || requestedLines.length > 250)
    return fail('INVALID_CART', 'Empty, oversized or missing basket.');
  if (!catalogByVariant || typeof catalogByVariant !== 'object' || Array.isArray(catalogByVariant) ||
      !verifiedBindingsByLineRef || typeof verifiedBindingsByLineRef !== 'object' || Array.isArray(verifiedBindingsByLineRef) ||
      !trustedDiscountByLineRef || typeof trustedDiscountByLineRef !== 'object' || Array.isArray(trustedDiscountByLineRef))
    return fail('TRUSTED_DATA_MISSING', 'Server-verifiable quote and feature bindings are required.');
  if (currency !== 'PKR') return fail('CURRENCY_CONFLICT', 'Only the approved PKR grocery price book is supported.');
  if (!nonnegativeInteger(shippingPaisa) || shippingPaisa !== 0)
    return fail('SHIPPING_CONFLICT', 'ASB grocery delivery must be free.');
  if (!nonnegativeInteger(taxPaisa) || taxPaisa !== 0)
    return fail('TAX_RECONCILIATION_REQUIRED', 'Cannot confirm a nonzero or invalid tax total.');

  const seenKeys = new Set(), grouped = new Map(), communityProducts = new Set();
  let payablePaisa = 0, subtotalPaisa = 0, discountPaisa = 0;
  const quoteLines = [];
  for (const input of requestedLines) {
    if (!input || typeof input !== 'object') return fail('INVALID_CART_LINE', 'Invalid cart line.');
    const lineRef = keyOf(input.lineRef);
    const variantId = keyOf(input.variantId);
    if (!lineRef || !variantId || !positiveInteger(input.quantity))
      return fail('INVALID_CART_LINE', 'Invalid line reference, variant or quantity.');
    if (seenKeys.has(lineRef)) return fail('DUPLICATE_LINE_REFERENCE', 'Repeated line references cannot be trusted.');
    seenKeys.add(lineRef);
    if (!own(verifiedBindingsByLineRef, lineRef)) return fail('UNVERIFIED_FEATURE_ORIGIN', 'Shopping feature not verified.');
    const binding = verifiedBindingsByLineRef[lineRef];
    if (!binding || !ALLOWED_FEATURES.has(binding.feature) ||
        binding.variantId !== variantId || binding.quantity !== input.quantity ||
        (input.claimedFeature !== undefined && input.claimedFeature !== binding.feature))
      return fail('FEATURE_BINDING_MISMATCH', 'Shopping-feature identity does not match the purchase.');
    if (!own(catalogByVariant, variantId)) return fail('UNKNOWN_VARIANT', 'Unrecognized product pack.');
    const sku = catalogByVariant[variantId];
    if (!sku || sku.variantId !== variantId || !keyOf(sku.productId) ||
        !nonnegativeInteger(sku.unitPricePaisa) || sku.unitPricePaisa === 0 || !sku.active || !sku.sellable)
      return fail('CATALOG_QUOTE_INVALID', 'Variant does not have a verified sellable quote.');
    if (sku.taxable !== false) return fail('PRODUCT_TAX_CONFLICT', 'Variant tax exemption has not been verified.');
    const feature = binding.feature;
    if (feature === 'bhao_tao')
      return fail('BHAO_TAO_CHECKOUT_PENDING', 'Non-grocery Bhao Tao requires its own approved checkout.');
    if (feature === 'budget_to_cart')
      return fail('BUDGET_CHECKOUT_PENDING', 'Weekly Budget-to-Cart cannot open until its tiers and reservation ledger are approved.');
    const expectedKind = feature === 'community_bulk_buying' ? 'community' : 'grocery';
    if (sku.kind !== expectedKind) return fail('WRONG_FEATURE_PRODUCT', 'Product does not belong to this buying feature.');
    if (feature === 'community_bulk_buying') {
      if (input.quantity !== 1) return fail('COMMUNITY_ONE_PACK_PER_PRODUCT', 'Select exactly one offered pack.');
      if (!Array.isArray(sku.allowedVariantIds) || !sku.allowedVariantIds.map(String).includes(variantId))
        return fail('COMMUNITY_UNOFFERED_PACK', 'This Community pack is not offered.');
      if (communityProducts.has(sku.productId)) return fail('COMMUNITY_ONE_PACK_PER_PRODUCT', 'Select only one pack per product.');
      communityProducts.add(sku.productId);
    }
    const discount = own(trustedDiscountByLineRef, lineRef) ? trustedDiscountByLineRef[lineRef] : 0;
    if (!nonnegativeInteger(discount)) return fail('DISCOUNT_NOT_VERIFIED', 'Invalid discount allocation.');
    const gross = sku.unitPricePaisa * input.quantity;
    if (!Number.isSafeInteger(gross)) return fail('MONEY_OVERFLOW', 'Unrepresentable basket amount.');
    if (discount > gross) return fail('DISCOUNT_NOT_VERIFIED', 'Discount exceeds the line price.');
    try {
      subtotalPaisa = safeAdd(subtotalPaisa, gross);
      discountPaisa = safeAdd(discountPaisa, discount);
      payablePaisa = safeAdd(payablePaisa, gross - discount);
    } catch (e) { return fail('MONEY_OVERFLOW', e.message); }
    const quoteLine = { lineRef, productId: sku.productId, variantId,
      quantity: input.quantity, feature, unitPricePaisa: sku.unitPricePaisa,
      grossPaisa: gross, discountPaisa: discount, payablePaisa: gross - discount };
    quoteLines.push(quoteLine);
    if (!grouped.has(feature)) grouped.set(feature, {items: [], discountPaisa: 0});
    const group = grouped.get(feature);
    group.items.push({productId:sku.productId,variantId,kind:sku.kind,quantity:input.quantity,
      unitPricePaisa:sku.unitPricePaisa,allowedVariantIds:sku.allowedVariantIds || []});
    try { group.discountPaisa = safeAdd(group.discountPaisa,discount); }
    catch (e) { return fail('MONEY_OVERFLOW',e.message); }
  }

  // No surplus trusted bindings/discounts; otherwise a bug could silently omit
  // a purchased line or allocate an unseen promotion to another feature.
  if (Object.keys(verifiedBindingsByLineRef).some(k=>!seenKeys.has(k)) ||
      Object.keys(trustedDiscountByLineRef).some(k=>!seenKeys.has(k)))
    return fail('UNMATCHED_SERVER_CONTEXT', 'Trusted quote contains unexpected lines.');

  // Interim rollout architecture Option B-prime: Community must have its own
  // Shopify checkout, while Apna Order + Dish-to-Cart can share one checkout.
  if (grouped.has('community_bulk_buying') && grouped.size > 1)
    return fail('MIXED_COMMUNITY_CHECKOUT_NOT_READY',
      'Community Buying must be placed through its separate checkout.',
      {featurePayablePaisa: grouped.get('community_bulk_buying').items.reduce((sum,item)=>sum+item.unitPricePaisa*item.quantity,0) - grouped.get('community_bulk_buying').discountPaisa});

  const groups = [];
  for (const feature of ['apna_order','dish_to_cart','community_bulk_buying']) {
    const group = grouped.get(feature);
    if (!group) continue;
    // Existing V3 policy checks pack rules, minimum and after-discount payable.
    const verdict = evaluate({feature,items:group.items,discountPaisa:group.discountPaisa});
    if (!verdict.allowed) return fail(verdict.code, verdict.nudgeRomanUrdu || 'Checkout rule not met.',
      {feature, shortfallPaisa:verdict.shortfallPaisa || null, minimumPaisa:verdict.minimumPaisa || null});
    groups.push({feature, lineCount:group.items.length, subtotalPaisa:verdict.subtotalPaisa,
      discountPaisa:verdict.discountPaisa, payablePaisa:verdict.payablePaisa});
  }
  if (groups.reduce((n,g)=>n+g.payablePaisa,0) !== payablePaisa)
    return fail('QUOTE_RECONCILIATION_FAILURE','Group totals differ from basket total.');
  return {allowed:true,code:'OFFLINE_PREFLIGHT_PASSED',currency,
    subtotalPaisa,discountPaisa,payablePaisa,deliveryPaisa:0,taxPaisa:0,
    minimumCommunityPaisa:COMMUNITY_MIN_PAISA,groups,quoteLines,
    enforcedInShopify:false,
    warning:'OFFLINE PROOF ONLY. Must select and test a non-bypassable Shopify Grow checkout mechanism before taking a real order.'};
}

module.exports = {preflight};
