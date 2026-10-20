# ADR-001 — Shopify Grow Checkout Enforcement Gate (Read-only Stage 0)

**Date:** 20 October 2026
**Status:** READ-ONLY FINDINGS + RECOMMENDED DEVELOPMENT PROOF; **NOT production-ready**
**Related:** ADR-001 unified multi-feature Option B; draft PR #5; Claude independent audit.
**Change-control:** This document authorizes NOTHING in Shopify, Render, Neon, production GitHub main, or WhatsApp. No test order, draft order, app installation, code deployment, live checkout block, change to promotions, or billing send was performed.

## 1. Actual Shopify findings — verified through connected Admin GraphQL

| Finding | Evidence | Consequence |
| --- | --- | --- |
| Plan | Shopify Grow (`shop.plan.publicDisplayName`); `shopifyPlus=false` | Merchant-private custom Checkout Validation Function cannot simply be installed as a standard Plus-only custom Function. |
| Checkout validators | `validations(first:30).nodes=[]` | No active validation Function is visible to this connector. No demonstrated Shopify-side Community minimum/pack blocking. |
| Shopify Functions | `shopifyFunctions(first:30).nodes=[]` | No installed Functions were reported by this API to the connected app. Does NOT prove every vendor or configuration outside its access is absent. |
| Grocery delivery | One active `Domestic` shipping method named `Free Community Day Delivery (Mon/Thu)`, price PKR 0 | Storewide shipping rate is zero in inspected profile; names may need eventual cleanup but no live change now. |
| Product tax | Prior full enumeration: 184/184 variants `taxable=false`; `shop.taxesIncluded=false`, `shop.taxShipping=false` | Product-level GST configuration appears cleared; cannot prove a future completed checkout has Rs 0 tax without a controlled checkout validation. |
| COD | Prior 22 recent orders read as `Cash on Delivery (COD)` / financial status pending or voided | A Draft Order proof must show that COD and true payable calculation remain usable before selection. |

**CAUTION:** The existing `ASB Community Prototype` and `ASB Apna Order Development V1` are **unpublished themes within the live Shopify store**, NOT separate isolated development stores. Checkout completed via their theme-preview paths could still produce real live Shopify orders. Never use them for checkout experiments without specific owner approval and protective test isolation.

## 2. NEW finding: Three LIVE Community-tier discount codes do not implement the Community meter

Actual Shopify Admin configuration, read-only:

| Active code-based discount | Shopify minimum requirement | Discount target | Usage count |
| --- | --- | --- | --- |
| Tier 1 / "10–19 households" | minimum **10 items per customer's purchase** | 15% off a collection | 0 |
| Tier 2 / "20–29 households" | minimum **20 items per customer's purchase** | 25% off a collection | 0 |
| Tier 3 / "30+ households" | minimum **30 items per customer's purchase** | 35% off a collection | 0 |

All three have `status=ACTIVE`, **no expiration**, no per-customer limit, and no aggregate usage cap. These are **discount codes, not automatic discounts**. None of the three reports redemptions at the time of inspection.

**Critical semantic mismatch:** Shopify's `DiscountMinimumQuantity` conditions evaluate the qualifying quantity within **one checkout**. They are not the number of distinct ASB Community households, nor kilograms pledged to a live Community rate meter. There is **no proven meter-based eligibility** binding these codes to a collective threshold.

**Critical target mismatch:** The targeted collection `کمیونٹی آرڈر — Community Bulk Orders` currently reports **14 ACTIVE and published ordinary grocery products**, including Adrak 250 g, Tamatar 500 g, Payaz 500 g, Aloo White 1 kg and other vegetables. These are **not the intended dedicated 5 kg / 10 kg Community pack variants**. Therefore, if a code is distributed or entered, a customer could obtain a Community-branded percentage reduction on ordinary groceries after satisfying the per-cart quantity rule, not the collective meter. Actual exploitability in checkout (including whether these products qualify under additional rules) remains **unverified**; do NOT state that discounts have been redeemed or charged.

**Action recommendation, not taken:** Owner should decide whether to **deactivate the three legacy codes** after confirming they are not part of an intentional active campaign. They do not represent the approved Community buying-rate mechanism. Do not change/delete these without express owner approval.

### Recommended data sources for the above verification

- `shop { plan { publicDisplayName shopifyPlus } }`
- `validations { nodes { title enabled blockOnFailure } }`
- `shopifyFunctions { nodes { apiType title } }`
- `discountNodes { nodes { discount { ... on DiscountCodeBasic { title status asyncUsageCount minimumRequirement customerGets } } } }`
- `deliveryProfiles/profileLocationGroups/zone/methodDefinitions`
- `productVariants { nodes { taxable product { status } } }`

## 3. Supported platform paths (external documentation verified 20 Oct)

**A. Shopify-native checkout + public Shopify App Store checkout-validation app**
- Official documentation allows stores on non-Plus plans to run Functions provided by eligible **public App Store apps**. Non-Plus merchants cannot deploy their own private/custom Function in the normal way.
- A suitable public validation app **might** enforce product/variant-specific minimums, allowed pack quantity 1, and mixed-cart prohibitions. This must be evaluated against exact capability, price, permissions and pre-discount/post-discount minimum calculations.
- It **cannot automatically implement ASB's customer-wide weekly Budget cap** if it needs to inspect a live external reservation ledger on Grow; Function external network access is restricted.
- Finding an app is NOT a proof of enforcement. Test exact bypass paths and Shopify checkout URLs first.

**B. Server-authoritative Draft Orders with Shopify customer payment/confirmation flow**
- ASB's own trusted backend checks pack variants, price, discounts, minimums, provenance and (eventually) weekly budget reservations BEFORE creating the checkout order.
- Shopify supports Draft Orders and invoice/payment links. Whether that invoice checkout preserves the **Cash on Delivery (COD)** choice and ASB's desired customer flow in this shop remains **unverified**. Do not assume placing a draft order in an unpublished theme is isolated.
- Must prove the customer cannot silently change quantity, variant, discounts or shopping-feature origin after validation. Prevent direct native checkout of protected variants by sales-channel/availability design; storefront JS alone is insufficient.
- Draft-order completion/webhooks need their own at-most-once handling, unique source identity and clear booking timestamp semantics. Never immediately send customer a "confirmed order" merely because a draft is created.

**C. Frontend-only controls (REJECTED for enforcement)**
- Unpublished-theme JavaScript, cart buttons, AJAX cart cleanup, or sessionStorage may improve user guidance but can be bypassed by direct checkout, manual cart calls or accelerated checkout.
- The current prototype Community cart normalizer can remove/re-add Community lines **without their original line properties**. Do not rely on cart attributes for durable provenance.
- The source of feature identity must be a server-verifiable and immutable checkout/order-line binding, not user-modifiable browser values.

References (official Shopify documentation):
- https://shopify.dev/docs/api/functions/unstable — public app vs custom app plan eligibility
- https://shopify.dev/docs/apps/build/functions/network-access — network limits
- https://shopify.dev/docs/apps/build/checkout/cart-checkout-validation — hard blocking
- https://help.shopify.com/en/manual/fulfillment/managing-orders/create-orders/get-paid — draft checkout payments/COD considerations

## 4. Initial Option B' checkout contract — proposed only

1. **Apna Order and Dish-to-Cart:** Continue compatible normal grocery checkout until a trusted source of feature-line identity is tested. No invented minimum. Grocery delivery Rs 0. Customer-facing bill grouped by feature only when provenance is verified, with truthful original Shopify order booking timestamp.
2. **Community Bulk Buying:** Separate checkout from normal groceries for Phase 1. Must block if Community qualifying payable amount AFTER applicable allocated discount < PKR 1,200, if more than one pack per product, or if variant is not one of offered pack options. Show clear Roman Urdu nudge before checkout. Collectively unlocked price must come from trusted committed-meter state, not 10/20/30 individual-cart quantities. No Community V3 bill until Community settlement exists.
3. **Budget-to-Cart:** Remains closed until weekly tiers, weekly minimum-spend policy, shared reservation ledger and checkout gate are explicitly approved and proven. `budgetMinimumSpendPaisa > 120000` in current draft policy code is **not owner-approved** and needs a separate code change before using.
4. **Bhao Tao:** Non-grocery; separate checkout/payment fulfillment. Do not advertise grocery-only tax, delivery, savings and refund terms.
5. **Mixed or unknown feature lines:** Reject protected invalid combinations **before Shopify order acceptance** using selected hard gate; regardless of path, webhook must detect invalid provenance and hold messaging/manual review rather than generate a partial bill. Never auto-cancel a real order.
6. **V2/V3 send ownership:** A source-specific mutual exclusion gate must be implemented and tested before V3 sends. No production switch currently authorized.

## 5. Required proof matrix in an isolated Shopify development store

| Case | Expected outcome before accepted order |
| --- | --- |
| Apna Order only, Rs 145 | Allowed; grocery shipping Rs 0, no special minimum |
| Dish-to-Cart with multiple ingredient lines | Allowed; accurate feature provenance |
| Community one offered 10 kg pack, total Rs 1,200 after eligible discount | Allowed only if all pack and price conditions match |
| Community Rs 1,199.99 after discount | BLOCK with clear remaining amount |
| Apna Rs 800 + Community Rs 500 | BLOCK / separate checkout; cannot use Apna to satisfy Community minimum |
| Community 5 kg + 5 kg of same product | BLOCK; must select offered 10 kg variant |
| Community quantity=2 on offered 10 kg variant | BLOCK; one pack per product |
| SKU/variant modified in checkout or cart API | BLOCK or safely reject before confirmation |
| Community coupon tier entered without collective meter eligibility | No unauthorized price reduction; reject/ignore with consistent explanation |
| Checkout created from direct cart link, accelerated checkout or AJAX | Same rules; cannot bypass |
| Browser deletes or alters line properties | No accepted purchase with spoofed trusted feature identity |
| Cart discount drops Community from Rs 1,250 to Rs 1,175 | BLOCK after discount allocation |
| Budget weekly tier not configured | BLOCK |
| Budget weekly cap passed on two devices concurrently | Second reservation fails; no overspend |
| Bhao Tao mixed with groceries | BLOCK or explicit separate checkout |
| Draft Order invoice pay using COD | Must prove in real dev store; UNKNOWN until tested |
| Tax/discount/fee reconciliation | Amounts exactly match approved quote and actual checkout; zero grocery delivery |

No bypass test may be conducted on the live store merely to prove a concept. Browser-facing unpublished themes are not equivalent to an isolated dev store.

## 6. Recommended next technical sequence

1. **No live changes:** inspect installed public validation app options against exact ASB rules OR create an isolated development store and test the server-draft alternative. The latter is a separate *development proof*, not a production authorization.
2. Owner decision on the three unused-but-ACTIVE legacy Community percentage discount codes. Disabling them is a live Shopify mutation and requires specific approval.
3. Finalize the enforced checkout path (public app vs authoritative Draft Orders) using a real staging demonstration including COD; document the results.
4. Only then build verified feature-by-line source-of-truth and quote reconciliation (additive, staged), Community settlement, and V3 shadow composer.
5. Explicit owner approvals separately required for installing an app, modifying live Shopify configuration, promoting theme, changing Neon, deploying Render, or enabling WhatsApp sends.

**Evidence boundary:** This report verifies stored Admin settings and current draft code paths. It does NOT demonstrate that a real checkout is blocked or that customer COD works via a draft invoice. Such claims require controlled end-to-end tests.

## 7. Immediate decision needed from owner

- Should the **three ACTIVE, zero-redemption, legacy Community tier discount codes** be deactivated? **NO ACTION TAKEN**; approval required.
- Which isolated test environment should be used for an actual checkout enforcement proof? A *separate development store* is strongly preferred over unpublished theme previews of the live store.

**Status:** Documentation-only. No checkout enforcement activated. No real order placed.
