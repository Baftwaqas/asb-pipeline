# ADR-002 — Lane A server-order adapter V1 (NONPRODUCTION)

**Date:** 5 November 2026. **Branch:** lane-a/server-order-adapter-v1.  
**Founder priorities:** Apna Order and Community first; five doors by 31 December.  
**No HTTP route, migration, access token, product edit, dev-store order, or live-store write in this PR.**

## Included implementation

- checkout/quote-crypto-v1.js — canonical HMAC-SHA256 quote signing and constant-time signature comparison. This authenticates quotes, not shoppers.
- checkout/ordercreate-v1.js — GraphQL Admin 2026-10 orderCreate input builder. Mixed-door lines retain door, variant GID, canonical product ID, grams/pieces, provenance, Hero tier and accepted line ceiling.
- checkout/redemption-v1.js — server-sourced quote and verified-household preflight, transaction-safe redemption interface, no automatic second Shopify create after an uncertain outcome, reconciliation on mismatches.
- checkout/dev-shopify-graphql-v1.js — deny-by-default shop allowlist to restrict HTTP POSTs to an explicitly configured development store.
- test/adr002-server-order-v1.test.js — isolated T0/T1/T3 and safety tests (mocked Shopify and transaction ledger).

## Shopify construction

For a Dish 40 g item, send quantity 1, a whole-line PKR priceSet and measured grams in line item properties. An optional WeightInput is shipping metadata, never an inventory deduction. All five door names are preserved on individual lines. Bhao Tao cannot sell grocery. All COD orders start at financialStatus PENDING, with free Monday/Thursday shipping and explicit inventoryBehaviour BYPASS. Send receipts OFF, since WhatsApp is a separate idempotent channel.

Accepted line prices are recorded. Apply the combined whole-rupee rounding credit exactly once as downward adjustments to line prices; sum of Shopify line prices equals COD payable and remains at or below accepted ceilings. Any Shopify total mismatch or unexpected payment status causes needs_reconcile, never an automatic retry. All values and quotes must be server-authoritative.

## T0 — critical idempotency contract

The browser supplies only quoteId, version and signature. The server fetches its immutable signed quote and trusted household record; a valid app-proxy signature does not establish shopper identity.

The injected Postgres redemption repository MUST, inside ONE transaction, revalidate current quote version, customer, cycle cutoff, canonical catalogue, pricing tiers, Apna ladder and same-cycle household caps; lock and reserve; commit a creating state before the Shopify request. A second attempt returns the recorded Shopify GID or needs_reconcile; never sends a second create. An ambiguous network timeout is quarantined. The production database implementation is not yet part of this PR. Current tests use an isolated mock, so cross-process atomic safety is NOT yet proven.

## T1 and T3

T1: one pending COD Shopify order with separate door-tagged lines, correct quantity/price properties, zero shipping and one payable total. T3: tampering with price, tier, door or quantities fails the signed quote; browser input is not trusted. Authoritative catalogue/eligibility checks remain a required injected transaction-level integration and have NOT yet been implemented.

## Dependencies before dev-store testing or production

1. A Shopify Partner development store with an approved exact shop allowlist; offline token with write_orders. A Shopify app proxy, if used, needs write_app_proxy and an authenticated route.
2. A verified shopper phone/session distinct from Shopify app-proxy HMAC.
3. A durable Postgres quote-claim ledger with locks, unique chain consumption, timeout reconciliation and tests using two concurrent DB connections; coordinate migration numbering with Claude's 021 and 022 work.
4. Integration with PR #7 Apna ladder and Claude's Community kernel once PR #8 review findings are resolved, without editing his PR.
5. Dev-store probe of custom variant title, priceSet, line properties, tax behaviour, COD PENDING, shipping, totals and errors. A separate real Grow-store staff proof requires founder approval.
6. WhatsApp Billing V3 idempotent confirmation, ASB packed-weight line-ceiling correction (Claude joint 022), and Rate Meter pending-to-verified events.

## Limitations

- No actual Shopify request or real COD order has been created.
- A development store limits orderCreate throughput; test at safe rates.
- No Shopify-level orderCreate idempotency feature is assumed. Correlation keys do not replace Postgres transaction durability.
- Deposit/prepaid orders are refused until provider-verified remaining-balance reconciliation is implemented.
- No customer-facing checkout UX or app-proxy route yet. No live tax configuration was modified.
- Zero-whole-rupee COD is rejected pending an explicit handling rule, not as a new Apna minimum order spend.

## References
- https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/orderCreate
- https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/OrderCreateLineItemInput
- https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/OrderCreateOrderInput
- https://shopify.dev/docs/api/admin-graphql/2026-10/input-objects/OrderCreateOptionsInput
- https://shopify.dev/docs/apps/build/online-store/app-proxies/authenticate-app-proxies

**Claude review requested:** adversarial analysis of replay/timeout, price and Shopify GraphQL input compatibility, customer identity and safe whole-rupee reconciliation. Do not merge or deploy until code review and CI.
