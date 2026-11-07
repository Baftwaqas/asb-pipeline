# ASB Apna Order — Independent Review & Activation Control (7 November 2026)

**Scope:** isolated development branch and database only. PR #10 remains DRAFT. **No founder product quantity rule has been approved or activated in this project.** The published ASB store is not modified.

## Safety-critical state machine

| State | Who authorizes | What is permitted |
|---|---|---|
| Draft in Data Manager | Staff editor | Edit minimum, maximum, allowed pack sizes; no checkout effect |
| Approved in Data Manager | Founder-allowlisted online Shopify staff | Preserve approved rule evidence; no checkout effect |
| Signed export | Founder-authorized staff, server-side HMAC secret | One-hour signed snapshot for independent import only |
| Staged in checkout Postgres | Server-side policy importer | Record verified signature, current Shopify variant bindings; **no activation** |
| Independently reviewed | Different verified Shopify staff identity | Review complete variant catalogue, release version and intended Monday/Thursday effective date; store immutable decision |
| Active in checkout | Independently authorized activator | Explicit operation after a fresh Shopify catalogue match, no future existing commitments, >=48h before effective local date |
| Revoked | Independent emergency suspender | Fail-closed. Never fall back to a stale or previously revoked policy automatically |

## Implemented (nonproduction)

- `db/migrations/025_apna_activation_review.sql` adds a separate review record and database-level guards: audit append-only, immutable reviewer/evidence/catalogue fingerprint, no state activation without a valid independent review, no revoked -> active transition.
- `checkout/apna-policy-activation-v1.js` implements independently authenticated **review**, **activate**, and **emergencySuspend** operations, with exact dev-store allowlist, staff separation, current Shopify pack checks, binding digest, atomic PostgreSQL transactions and append-only evidence.
- `checkout/dev-shopify-credentials-v1.js` adds a strictly read-only, bounded 5-product-per-batch Shopify Admin GraphQL catalogue reader using the dev app's **server-side** `read_products` permission. There is no arbitrary GraphQL query interface or new Shopify write route.
- `scripts/lab-apna-catalog-readonly-v1.js` checks all three named synthetic products and all six physical variants directly from the same offline app on the locked dev backend. It makes **zero Shopify order requests** and changes no products.
- `test/adr002-apna-activation.test.js` and `test/adr002-dev-apna-catalog.test.js` exercise review/activation/suspension in **disposable PostgreSQL** with mocked staff sessions and catalogues. They are NOT real staff approvals.
- The existing atomic redemption ledger refuses mixed-door checkout unless all feature verifiers approve; quantity policy version is included in the signed quote. This release mechanism is not wired to the live storefront yet.

## Actual Shopify catalogue preflight (read-only)

**Store:** `asb-checkout-lab.myshopify.com` (PKR, Asia/Karachi).

| Exact synthetic product | Shopify product ID | Variants | Observed status |
|---|---|---|---|
| ASB LAB ONLY — Apna Onion (Test) | `gid://shopify/Product/15548928753698` | 500 g and 1 kg | **DRAFT** |
| ASB LAB ONLY — Ginger (Test) | `gid://shopify/Product/15548929015842` | 125 g and 250 g | **DRAFT** |
| ASB LAB ONLY — Community Hero Onion (Test) | `gid://shopify/Product/15548929277986` | 5 kg and 10 kg | **DRAFT** |

All six variants exist in Shopify with synthetic `ASB-LAB-*` SKUs. The unsigned mapping audit **does not constitute founder approval**. A DRAFT product is explicitly rejected for an approved Apna policy. No product publication was attempted.

## Critical remaining blockers

1. Data Manager PR #27 has **not been deployed** or connected to a verified real online Shopify founder staff session; its signing key must be stored only in a secured server environment, never in chat, Shopify browser code or GitHub. No valid founder-signed export exists here.
2. The independent `resolveOnlineStaff` authorization callback must be implemented with verified Shopify online staff identity and role allowlists. Current integration has **no public review/activation route** and fails closed without this server-side adapter. Tests use synthetic staff identities only.
3. The actual production store's product mappings are separate from these synthetic test product GIDs; a production shop signed export must not be remapped into the dev shop by title or guess.
4. A reviewed policy change must preserve quote version and historical household/cycle commitments. Existing future reservations block activation (no surprise changes to prebooked orders).
5. The Shopify product price authority, per-pack pricing, Community verified metre, Recipe Master provenance, and full mixed-order customer/WhatsApp bill remain additional release gates.
6. There is no automatic activation when a migration runs. No live policy should be activated without a deliberate founder release and documented independent reviewer approval.

## Lab preflight / shutdown

Once migration 025 is applied **only to** the isolated `asb_checkout_lab_pg18` database, inspect with read-only `scripts/lab-readiness-v1.js`. The expected current result is **0 reviewed, 0 active, 0 staged**. Never enable `ASB_LAB_ONE_SHOT_RUN` to test policy activation.

Do not merge PR #10 or PR #27, publish draft products or change production until remaining approval and rollout safeguards are independently reviewed.

## Verified isolated live-lab evidence (7 November 2026)

- At the start of this step the three Checkout Lab synthetic Shopify products were independently confirmed **DRAFT** with six exact variant sizes; the approved policy importer correctly **refuses** DRAFT products.
- Ran the dedicated development Render service against the independently verified isolated PostgreSQL resource `dpg-dbm8v3qjnfac738pc31g-a` (database `asb_checkout_lab_pg18`) with **order creation disabled**. Migration `025_apna_activation_review.sql` applied successfully; this brought the isolated schema to **18 recorded migrations**.
- Read-only `lab-readiness` probe output: `APNA_POLICY_STAGING_READY releases=0 active=0`, `APNA_DUAL_CONTROL_READY reviewed=0 active=0`, and `SHOPIFY_APP_TOKEN_OK`. There are **no activated or staged founder policies**.
- Independent offline Shopify Dev app read-only `lab-catalog` probe read the exact three products and six variant pack sizes, returned `BLOCKED_DRAFT_OR_INACTIVE_PRODUCTS`, `shopifyOrdersCreated=0`, `policyReleasesActivated=0`.
- Reverted `ASB_LAB_MIGRATE_ONCE`, `ASB_LAB_ONE_SHOT_RUN`, `ASB_LAB_READONLY_PROBE`, `ASB_LAB_AUDIT_READONLY`, and `ASB_LAB_CATALOG_AUDIT` to **disabled**. The locked health server remained live.
- Independently verified Shopify still has **exactly one** synthetic `test=true` order **#1001**, `PENDING` PKR 1,556, and exactly **three** synthetic products. No additional Shopify order resulted from this step.

The activation service's staff authorization is currently an **injected, mandatory trusted callback**. Tests use synthetic staff sessions: it has **NOT** yet been connected to a real Shopify online staff identity or admin screen. Never interpret this proof as real founder approval, product publication or readiness to merge.
