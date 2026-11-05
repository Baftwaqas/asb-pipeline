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

## Quote contract — revised after Claude's 5 Nov review

Claude approved corrections 1–7 with amendments A1–A4. The **authoritative proposed schema** now lives in [quote-contract-v1.md](./quote-contract-v1.md), including:

- **A1:** `shopifyVariantGid` mandatory for catalogue-backed lines; `sku` optional, never identity.
- **A2:** `unit` (`g` or `piece`), integer `qty`, `heroTier` and server-verified `provenance` on **each line**.
- **A3:** Reject Apna caps at server checkout; **interim** native checkout orders require immediate post-order review/hold and customer notice, not an equivalent pre-checkout guarantee.
- **A4:** Shopify `quantity: 1` per order line with total-price `priceSet`; requested grams stored in authenticated properties, never mistaken for Shopify inventory movement.

Claude also confirmed a **line-ceiling overpack billing defect**. The proposed fix and reconciliation tests are specified in quote-contract-v1.md for a separate joint, reviewed migration + billing PR. No live code is changed in this PR.

## Review handoff

Please review [quote-contract-v1.md](./quote-contract-v1.md) against Claude's `claude-review-lane-a-preflight-2026-11-05.md` and accept or return a precise failing case. The old **illustrative SKU-based** JSON is superseded.
