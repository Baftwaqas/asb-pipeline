# ASB ADR-002 — Founder-Approved Apna Quantity Policy Bridge (7 Nov 2026)

**Scope: checkout development branch ONLY. Neither PR #10 nor ASB Data Manager PR #27 is a production release.**

## What is now implemented

1. **In `Baftwaqas/ASB-Data-Manager`, PR #27**: authenticated Shopify staff drafts/submissions, founder approval in the app, canonical product ID grouping and pack-variant coverage checks. New founder-only `POST intent=export_signed_release` creates a short-lived HMAC signature over the complete approved policy and product mappings. Requires server-held `ASB_POLICY_RELEASE_SIGNING_KEY` (at least 32 bytes). The signer never makes a Shopify order, changes prices, or enables checkout rules.
2. **In `asb-pipeline`, PR #10**: `checkout/apna-approved-policy-v1.js` verifies the signature, exact shop, approval staff IDs, timestamp and expiry, canonical IDs, units, minimums, household-cycle maximums, pack ladder, revision, and product links. Unsigned `?export=approved` JSON is *not* accepted as a released policy.
3. **Shopify product audit**: `checkout/apna-shopify-pack-bindings-v1.js` accepts only server-verified matching Shopify product and variant GIDs and **ACTIVE** status. It fails on ambiguous variant sizes, missing SKU pack sizes, unapproved product mappings or incomplete pagination. Shopify remains authoritative for prices.
4. **PostgreSQL 18 staged storage**: additive migration `024_apna_policy_staged_release.sql` stores immutable founder-signed envelopes, individual SKU variant pack bindings, staff evidence, and audit events. Import function `checkout/apna-policy-pg-v1.js` **only stages** a release; state defaults to `staged`. It cannot activate the policy. Duplicate imports are idempotent only when envelope AND current variant bindings are unchanged.
5. **Atomic checkout verifier**: `checkout/apna-policy-pg-verifier-v1.js` loads only a separately reviewed, **active** signed release with a defined effective delivery date; validates it against the imported trust record; ensures a new signed quote includes the exact policy version; and invokes `grocery/apna-limits.js` under the existing Postgres household/cycle lock. It includes earlier `creating`, `needs_reconcile`, and `completed` claims when checking the same product's total household-cycle cap. Non-Apna mixed doors MUST independently pass their own server policy callback, and missing external order history always fails closed.
6. **Regression tests** use synthetic identities, dummy signatures, a scratch PostgreSQL 18 instance and mocked Shopify catalogues. No production customer or order changes.

## Important distinctions

- **Founder approval is NOT automatic**. No live product minimum, maximum or variant group has been approved or imported by the founder through this new bridge in this task.
- **The standalone development store uses different Shopify product GIDs from production.** A signed release from production's Data Manager must never be silently applied to `asb-checkout-lab.myshopify.com`. The source and target Shopify shops MUST match exactly; future lab testing needs separately reviewed lab policy exports, or an explicitly designed reviewed mapping workflow.
- **Shopify source prices never appear in the quantity policy.** A pack size is approved, not a price. The price engine must still obtain and lock the appropriate Shopify variant prices at quote issuance.
- **Composite pack sizes** (e.g. 375g = 125g + 250g) need TWO Shopify line items and their per-pack prices. This V1 validator rejects one 375g line that pretends to be a 125g variant.
- **Dish-to-Cart 40g ginger** does not consume Apna quantity entitlement and cannot be rejected merely because Apna's minimum may be 125g. The separate Dish verifier is still mandatory.
- **No minimum basket spend** exists for Apna Order. Community's Rs 1,200 qualifying subtotal remains a separate feature-specific check.
- **One-hour HMAC validity** applies to import/staging time. Later checkout must verify the same original signature using the trusted database `verified_at` and the independently audited activation event; requiring today's time to fall in the original export hour would incorrectly expire all active policies.
- Old orders from other ASB systems are **not yet fully connected**. The development-only guard `verifyEmptyLegacyOrdersInLab` proves the isolated lab has no separate legacy orders; it MUST NOT be used as a production fallback.

## Remaining blocking steps

1. **Do not deploy Data Manager PR #27 yet.** First complete independent review, validate online Shopify staff IDs and app OAuth identity, install the quantity app in a controlled environment, then configure the signing key in a secret environment **without sharing it in ChatGPT or GitHub**.
2. Obtain actual founder approval for each canonical product's approved minimum, maximum, pack ladder and mapping, instead of assuming example 125g ginger/500g onion values.
3. Build and approve an **explicit signed-release activation ceremony**, with independent reviewer audit, effective cycle, rollback, and immutable log. This PR deliberately has no automatic activation action.
4. Implement real legacy ASB orders/quantity reservations retrieval; release beyond a clean lab only after all household-cycle commitments can be reconciled.
5. Wire customer identity-verified quote issuance, current variant prices, Shopify availability checks and the mixed-door independent validators to the existing atomic ledger and UX.
6. Verify end-to-end on the isolated development store before any merge or production theme change.

## Verification

- Data Manager: `npm run test:apna-quantity`, focused CI, Prisma validate, TS check, build.
- Pipeline: `node --test test/adr002-apna-approved-policy.test.js test/adr002-apna-staged-policy.test.js`; GitHub PostgreSQL 18 CI.
- Any migration to Render: **development database only**, exact guarded database resource ID and explicit one-shot migration. Do not run migration 024 in production until release review.

**Safety default: any missing founder approval, signed envelope, active state, variant binding, external legacy-history proof or other-door verifier rejects checkout.**
