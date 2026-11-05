# ADR-002 — Apna quantity ladder and cycle limits (nonproduction, Claude C1–C3 addressed)

This PR contains a **pure validator** plus automated tests. It is not wired to Shopify, WhatsApp, databases, or any live checkout. Production systems remain untouched.

## Founder-locked rules implemented

1. **No minimum total order spend** in Apna Order; the amount can be small.
2. Each Apna **product** has its own approved minimum, maximum, and quantity ladder. A 40 g ginger line is **not Apna-eligible** if ginger's approved minimum is 125 g. The same genuinely recipe-derived 40 g remains permissible within **Dish-to-Cart**.
3. For an Apna product, every proposed line must either be an assembly from approved pack sizes (`allowedSizes`) or follow an explicit quantity increment (`stepQuantity`). Unconfigured ladders **fail closed**. Approved packs in one line may sum (e.g. 125+250=375 g) but the pricing engine must still price individual packs correctly.
4. Per-customer/household max applies across canonical product IDs, variants, split orders and active reservations **within the same delivery cycle**. Other features never consume Apna entitlement.
5. Quote-contract fields: `canonicalProductId`, `qty`, `unit: "g"|"piece"`, `door`. Do **not** send `productId`, `quantityBaseUnits` or `"pcs"` to this evaluator.
6. Existing statuses are case-normalized; explicit known cancelled/expired/rejected states release capacity; unknown lifecycle states raise `UNKNOWN_ORDER_STATUS` and require operator review. No unknown state is silently treated as cancelled.
7. On editing an existing order, exclude the version being replaced; continue counting unrelated orders.

## Rule definition examples — not founder-approved SKU values

```js
const limitsByProduct = {
  GINGER: {unit:"g", minQuantity:125, maxQuantity:500, allowedSizes:[125,250,500]},
  ONION: {unit:"g", minQuantity:500, maxQuantity:2000, allowedSizes:[500,1000,2000]},
  EGGS: {unit:"piece", minQuantity:1, maxQuantity:12, stepQuantity:1}
};
```

`allowedSizes` means a line can be assembled from those physical packs. `stepQuantity` means exactly `minQuantity + n × stepQuantity` for non-negative whole `n`. Each product must configure **exactly one** method. A missing ladder is a configuration error, **not** permission to buy arbitrary grams.

This rule evaluator does **not** determine selling price, physical packaging, whether a SKU variant really exists, household identity, or what counts as an authentic recipe calculation.

## Required integration before production

1. Resolve verified household identity, cycle and canonical product on the SERVER. Do not trust browser-supplied limits, provenance or household keys.
2. Validate all proposed Apna lines against live approved product master and price ladder; reject or request changes **before confirmation** on server-owned checkout.
3. Read other commitments/reservations **under an atomic Postgres household+cycle lock**; run this validator on the full proposed order. Persist the reservation before contacting Shopify.
4. Implement quote redemption idempotency, cancellation release, case-safe lifecycle mapping, and concurrent same-household requests.
5. While native Shopify Grow checkout remains available for pure Apna orders, the backend cannot guarantee pre-checkout rejection: detect oversized/out-of-ladder orders on `orders/create`, **immediately hold/review and notify**, without fulfillment. This is temporary and **not equivalent** to checkout enforcement.
6. Confirm product units and SKU/variant mapping; every approved pack must have an explicit pricing and packing specification. A 375 g assembled purchase must not receive an arbitrary per-kg rate when 125 g and 250 g pack prices differ.
7. Verify the full checkout/packing/billing path before changing production.

Tests: `node --test test/apna-limits.test.js`. GitHub CI also runs the full repository test suite.

**Passing unit tests do not mean production checkout is enforcing these rules.**

## Claude's 5 Nov review — C1/C2/C3 resolution

- **C1 (blocking):** each trusted product rule includes `minQuantity`, `maxQuantity` and an explicit approved `allowedSizes` pack set **or** `stepQuantity`. Apna ginger 40 g now returns `APNA_BELOW_PRODUCT_MINIMUM`, while Dish-derived 40 g does not consume Apna eligibility. Ladders are independent of any **basket-spend** minimum.
- **C2 (contract):** the evaluator now consumes quote-contract `canonicalProductId`, integer `qty` and `unit: "g"|"piece"`. It no longer requires `productId`, `quantityBaseUnits` or `pcs`.
- **C3 (minor):** `Cancelled` and `cancelled` release reserved cap; unexpected status strings produce `UNKNOWN_ORDER_STATUS` rather than silently distorting limits.

The original three counterexamples are now **opposite-result regression assertions**, not documented failures. This PR remains nonproduction until the integration obligations above are completed. Community's founder-approved verification policy is documented at `docs/community-verification-policy-v1.md` on the `five-door-v1` integration branch (not implemented here).

## Claude review CX4 (5 Nov) — legacy-product isolation

An earlier order can contain a product that has no approved Apna quantity ladder yet (e.g., LEMON), while the customer is placing a new order for ONION. Previously the evaluator attempted to load **every** earlier Apna line's rule and incorrectly threw `MISSING_APNA_LIMIT: LEMON`. This could block unrelated legitimate orders during staged SKU rollout.

**Fixed:** only previous lines whose `canonicalProductId` occurs in the current proposed Apna lines are included in this evaluator's cap/status inspection. All current proposed Apna lines **still** require a configured quantity ladder and fail closed if absent; earlier ONION lines still aggregate across orders. Unrelated legacy statuses do not block ONION. Relevant unknown statuses still fail visibly.

Four new CX4 regression cases cover this; total focused tests: **32**. This is distinct from the broader checkout/product-master duty to validate all new items and to monitor legacy orders independently.
