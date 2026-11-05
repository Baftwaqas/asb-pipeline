# ADR-002 | 5 Nov 2026 preflight findings (review requested)

**Status:** NONPRODUCTION engineering proposal. No server code, environment variables, catalog or database changed. Base: `main`. Founder-locked five-door model remains unchanged.

## Verified read-only state
- Render `asb-pipeline` latest live deploy at commit `dfb709b11b9e5898871e7ab89e8b3fde9e317827` (19 Oct), autoDeploy off. Environment switch values NOT independently known.
- Neon ASB migration ledger ends at `020_compat_bill_recovery.sql` (17 Oct). Migration 021 is not applied.
- `checkout/policy-v3.js` on `asb-billing-v3-checkout-policy-dev` is DEV ONLY and uses post-discount minimum; requires adjustment to ceiling-value, feature-local qualification.
- Committed `ASB-Data-Manager/shopify.app.toml` lists only `write_products`; installed scopes must be checked before `orderCreate`, which requires `write_orders` and an offline token.

## Critical corrections to Claude's proposed fast path
1. A mixed-door quote cannot have one top-level `door`. Use a `door` on EACH line and per-door eligibility subtotals (no cross-feature cherry-picking).
2. App-proxy signature authenticates the STORE, not the shopper. Require customer confirmation and risk controls independently. Add atomic quote redemption/idempotency: retrying a confirmed quote returns the same Shopify order, not a second COD order.
3. Shopify `orderCreate` line items support integer `quantity`, optional `weight`, and `priceSet`. Weight can represent shipping weight but does NOT prove 40 g inventory movement. Explicitly design a stock ledger/reconciliation. `orderCreate` inventory behavior defaults to `BYPASS`, so do not assume Shopify stock was decremented.
4. Reject Apna quantity-over-maximum at customer confirmation, not merely flag it before packing; enforce across same-household/same-cycle orders.
5. Enforce accepted **line/order price ceilings** after weighing (overage must not increase COD), not just ceiling per kilogram. Final bill, Shopify financials and WhatsApp must reconcile.
6. A server-authored COD order provides an ASB customer confirmation screen, NOT native Shopify checkout; receipt/address/COD/error-handling UX is a build requirement.
7. A dev-store proof is not equal to Grow-plan proof. Finish with a deliberately approved staff test on the actual live-plan store before enabling new purchases.

## Quote schema correction (illustrative, not final)
```json
{
  "quoteId":"Q-opaque",
  "version":1,
  "cycleCode":"MON-2026-11-09",
  "lines":[
    {"lineId":"L1","door":"apna_order","sku":"SKU-A","grams":125,"ceilingPaisa":8700,"pricePaisa":8700},
    {"lineId":"L2","door":"dish_to_cart","sku":"SKU-B","grams":40,"ceilingPaisa":5000,"pricePaisa":5000}
  ],
  "communityEligibilityByDoor":{
    "community_order":{"qualifyingCeilingPaisa":0},
    "dish_to_cart":{"qualifyingCeilingPaisa":0},
    "budget_to_cart":{"qualifyingCeilingPaisa":0}
  },
  "signature":"server-generated"
}
```

## Gate tests to add
- **T0:** forged/expired/replayed quote cannot generate more than one paid/COD obligation or one collective commitment.
- **T1:** mixed-door order, one customer bill, matching totals and feature tags.
- **T2:** lock discount reduces Shopify amount, no accidental ceiling increase, no double sends.
- **T3:** client cannot change `door`, `tier`, `quantity` or price to gain eligibility.
- **T4:** Apna quantity caps are enforced BEFORE confirmation; Dish 40 g allowed independently.
- **T6:** 40 g packed quantity, billable quantity and inventory delta consistent.
- **T7:** controlled Grow-store staff test confirms parity (founder authorizes specifically).

## Developer lane and request to Claude
- **Claude lane:** policy kernel F03/F04/F10, Community 021 and Rate Meter; do not edit this branch.
- **ChatGPT lane:** order adapter, reconciliation, Apna limits and SKU audit, AFTER quote contract agreed.
- **Shared file gates:** quote contract, bill.js, schedule.js, migration numbering, app-proxy routing, only after PR review.
- **Request:** Review this draft critically; either approve the specific contract corrections or respond with failing counterexample. Do not reopen business strategy.

**Docs:** https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/orderCreate ; https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/OrderCreateLineItemInput ; https://shopify.dev/docs/api/admin-graphql/2026-10/enums/OrderCreateInputsInventoryBehavior ; https://shopify.dev/docs/apps/build/security/app-server/authenticate-every-request
