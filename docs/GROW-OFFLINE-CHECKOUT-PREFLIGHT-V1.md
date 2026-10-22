# ASB — Shopify Grow checkout enforcement proof (offline only)

**Date:** 22 October 2026  
**Status:** DEV PROTOTYPE, **NOT** a Shopify checkout enforcement mechanism.  
**Architecture:** Option B long term; initial B-prime (Apna Order + Dish-to-Cart compatible grocery; Community separate).  
**Change control:** No production storefront, Shopify settings, Neon, Render, or WhatsApp changes; no test/draft order and no live checkout experiments.

## Verified platform constraints

- ASB is Shopify **Grow**, not Plus. The Admin API previously showed no active checkout-validation Function. A private ASB app cannot simply install its own Function on Grow. Public Shopify App Store Function apps can be used on non-Plus plans, subject to exact capabilities.
- Three old Community tier discount codes (15%, 25%, 35%) were **deactivated with the owner's separate approval** on 22 October 2026 and verified EXPIRED, zero redemptions. They were ordinary per-purchase quantity discounts, **not** an ASB collective rate-meter settlement.
- Grocery shipping configuration was previously read as PKR 0. All 184 product variants had taxable=false in the previous complete enumeration. Existing taxed orders are historical; this does not establish legal tax treatment.
- Unpublished themes *within the live store* are NOT isolated development stores; testing payment/checkout there risks creating real Shopify orders.

## What is built

File checkout/offline-grow-preflight-v1.js exports preflight, an offline-only pure function. It calls the existing, unchanged checkout/policy-v3.js. File test/offline-grow-preflight-v1.test.js includes **27** safety cases.

The function accepts:
- Customer-controlled requestedLines with lineRef, variantId, quantity, and an optional feature claim. Customer-submitted prices and totals are ignored.
- Separately **trusted-server-supplied** catalogByVariant, including real product identity, active/sellable flag, unit price, taxability, and allowed Community variants.
- Separately **server-authenticated** verifiedBindingsByLineRef binding each purchase line to its specific variant, quantity, and ASB feature.
- **Trusted server-calculated** line discount allocations, tax/shipping money, and currency.

**Important limitation:** this function does NOT issue/verify cryptographic signatures, fetch catalogue data, reserve quantities or rates, persist quotes, or create any Shopify Order/Draft Order. Those inputs must be supplied by an actual authenticated server process and reconciled to Shopify. The example tests create trusted bindings from fixtures, which is NOT production authentication. **Never pass browser-controlled values as the trusted arguments in a real route.** All results deliberately report enforcedInShopify: false.

### Business behavior verified by the offline tests

| Scenario | Local expected result |
| --- | --- |
| Apna Order Rs 145 | PASS, no minimum |
| Apna + Dish to Cart same item across two feature entries | PASS, preserving two distinct feature lines (Shopify line-merging still unproven) |
| One allowed Community 10kg pack at Rs 1,200 | PASS, Community-only group |
| Community total Rs 1,199.99 | REJECT, exact 1 paisa shortfall |
| Community Rs 1,250 less Rs 75 trusted discount | REJECT, discounted amount below minimum |
| Apna Rs 800 + Community Rs 500 | REJECT mixed checkout; Apna cannot satisfy Community minimum |
| 5kg+5kg, 5kg+10kg of same product, or 10kg quantity 2 | REJECT duplicate/multiple packs |
| Unknown pack, swapped variant, forged feature, unverified binding | REJECT |
| Client claims a lower price | Ignored; trusted server quote used |
| Taxable grocery variant, nonzero tax/shipping, wrong currency, invalid discounts | REJECT |
| Budget-to-Cart and Bhao Tao | REJECT pending separately approved policies |
| Overflow, unsellable item, duplicate line reference | REJECT |

All prices are **hypothetical test fixtures**, not current ASB product rates.

**Local evidence:** 27 of 27 new unit tests passed using Node 22.16.0 on a copy of the existing pure policy evaluator. Repo package.json specifies Node 24, and CI on the pushed branch must be checked independently. Running node --test test/offline-grow-preflight-v1.test.js test/checkout-policy-v3.test.js under Node 24 is recommended.

## Actual Shopify Grow hard gate still required

**A. Public Shopify App Store validation app.** Check exact support for Community-only **after-discount** minimum, pack choices, quantity=1, separate mixed checkout, direct cart/buy-now bypasses, and signed provenance. Any public app must be independently assessed, not merely installed. Cross-checkout weekly Budget caps are beyond most store-local validation rules without authoritative shared reservation state.

**B. Server-authoritative Draft Orders.** ASB validates and reserves product lines and Community commitments, freezes trusted quote and source identity, creates draft, and sends a secure Shopify checkout link. On a **separate** Shopify development store, verify COD workflow, discounts, final order conversion, mutable line quantities, replay, direct native cart checkout bypass, webhook receipts, delivery date, and exact amount. A draft creation alone is not an accepted/confirmed order. Do not deploy or create a real draft without owner approval.

Official Shopify documentation:
- https://shopify.dev/docs/apps/build/functions
- https://shopify.dev/docs/apps/build/checkout/cart-checkout-validation
- https://shopify.dev/docs/apps/build/functions/network-access
- https://help.shopify.com/en/manual/fulfillment/managing-orders/create-orders

## Open release blockers

1. Select and demonstrate a **non-bypassable** Grow checkout enforcement route in a **distinct isolated development store**, not live theme previews.
2. Prove actual server-signed feature-line origin is preserved in the accepted Shopify order; repeat same variant bought through Apna Order and Dish-to-Cart.
3. Prove verified prices/discount allocations and free shipping match Shopify COD due, and that no legal tax obligations are wrongly inferred from product flags.
4. Complete Community intake-to-commitment settlement and Rate Meter readiness before any Community consolidated confirmation.
5. Enforce exclusive V2/V3 bill-sender ownership and reuse 017 idempotency.
6. Keep Budget-to-Cart closed pending approved tiers/weekly minimums and concurrent reservation ledger; Bhao Tao non-grocery terms need separate approval.
7. Owner approval is required for any live app install, store change, Neon migration, Render deploy, or automatic WhatsApp send.

**Decision:** GO for offline review/testing and isolated development-store checkout proof; **NO GO** for production checkout enforcement or V3 messaging.
