# ASB Checkout Lab — Live Database Reconciliation and Retry-Proof Audit

**Performed:** 2026-11-07, Karachi time (Saturday)  
**Scope:** Isolated Shopify Dev store `asb-checkout-lab.myshopify.com`; Render service `asb-checkout-lab-bridge`; Render Postgres 18 `asb_checkout_lab_pg18`.  
**Mode:** Database read-only; no new Shopify orderCreate, no payment, no delivery/WhatsApp actions. Production ASB unchanged.

## Actual evidence

- Independently read Shopify Admin: `ordersCount=1` (EXACT); sole Shopify order is **#1001**, GID `gid://shopify/Order/18999612604450`, `test=true`, COD `PENDING`, PKR **1556**, from the completed *B* quote. No additional order from case A was visible in this complete development-store listing.
- Executed `scripts/lab-reconcile-readonly-v1.js` **against the isolated Render PostgreSQL database** after validating the exact database ID. The first audit initially refused because the original A quote predates the A/B naming split. The audit identity was corrected; **original DB rows were never rewritten**.
- Render logs after correction explicitly returned:
  - **A:** `needs_reconcile`, no persisted Shopify order GID, `HOLD_FOR_MANUAL_REVIEW`, `automaticRetryAllowed=false`
  - **B:** `completed`, persisted `gid://shopify/Order/18999612604450`, expected payable `155600` paisa, `automaticRetryAllowed=false`
  - **Replay test:** used the real signed B quote *after its expiration*. `confirmCodOrder` returned `already_created` with the original Shopify order GID.
  - **Actual calls to stubbed `shopify.createOrder` in read-only test:** **0**.
  - The live script printed `DB_READ_ONLY; SHOPIFY_WRITES=0; CASE_A_STILL_QUARANTINED`.
- GitHub CI on commit `3677456b`: **SUCCESS** (includes six new adversarial reconciliation tests).
- All Render one-shot and read-only-audit flags were set back to `disabled`. The app has no public order endpoint; its web server remains `SAFE_LOCKED`.

## Interpretations and limits

The backend successfully proves **idempotent retrieval of a completed quote** in the development system and preserves unresolved Shopify attempts without an automatic second order. This is necessary but not by itself sufficient evidence for all production crash/recovery/race conditions.

A currently empty Shopify matching-order search **does not justify deleting A's reservation**; keep A in `needs_reconcile` for a traceable, manually reviewed closure. Creating a new quote in the same cycle for the same household is still forbidden until a reviewed release workflow exists.

The offline application permissions and the synthetic quote/variant verifier must not be mistaken for live customer authentication or founder-approved Apna quantity caps. Community Rate Meter, final packed-weight bill, Shopify orderEdit and WhatsApp billing remain separate integration gates.

## Next action in the integration branch

1. Implement a **durable reconciliation decision workflow** (reviewed event log, reviewer identity, evidence, no force-retry, state-change constraints).
2. Connect exact Shopify product mappings and founder-approved per-product Apna limits from ASB Data Manager to the authoritative PostgreSQL quote validator.
3. Test customer-verified quote issuance and one mixed-door order end-to-end, then packing/price-lock/bill and COD adjustments.
4. Obtain independent review before any production merge or deployment.

**Do not enable the one-shot Shopify order test automatically; no further new test order is needed to prove this case.**
