# ASB Shopify Development Store — Owner Handoff and Safety Gate
**Prepared:** 5 November 2026 · **Lane A:** ChatGPT
**Status (5 Nov 2026):** Shopify Dev store **ASB Checkout Lab** is live and verified by connected Admin API at `asb-checkout-lab.myshopify.com`, **PKR**, **Asia/Karachi**. Three synthetic DRAFT products and six test variants were created; see `checkout/fixtures/asb-checkout-lab.json`. PostgreSQL migration 023 plus claim/timeout/concurrency tests passed in isolated CI. A direct `orderCreate` capability probe returned **ACCESS DENIED — OFFLINE ACCESS TOKEN REQUIRED**, despite the connector listing the `write_orders` scope. Shopify orders remain **0**. No production mutation is authorized.

## Completed owner action (Shopify 2026 Dev Dashboard)
1. Open https://dev.shopify.com/ and sign in to the Shopify account/organization with development-store permission.
2. Select **Stores → Create store → Dev** (NOT Client transfer, NOT a paid merchant production store).
3. Name it **ASB Checkout Lab**; choose **Grow** plan to match production capabilities (NOT Plus), **Pakistan / PK** if asked, no feature previews.
4. Choose whether to populate demo products; for precise ASB fixture tests it is safer to start empty and create dedicated synthetic test variants. Set timezone to **Asia/Karachi** and currency **PKR** where supported by dev-store setup.
5. Select **Create store** and note the permanent `*.myshopify.com` domain. Send Lane A ONLY that domain (or a screenshot with secrets hidden). Do **not** send the Shopify password, Admin API token, client secret or personal credentials in chat.
6. Shopify Dev stores are password protected, cannot process genuine payments, and cannot be converted to production. These are desirable protections for ASB.

**Optional owner-local CLI alternative (Shopify CLI 4.8+, login required):**
```powershell
shopify store create dev --name "ASB Checkout Lab" --plan grow --country PK
shopify store list
```
The interactive browser/Shopify authentication must be completed by the owner on their own computer. Do not treat mock.shop "new store previews" as Dev stores.

## Verified development shop identity and next permission gate

- **Dev shop domain:** `asb-checkout-lab.myshopify.com` (user-supplied Shopify Domains screenshot: Primary, Connected).
- **Allowlist exact value:** `ASB_ALLOWED_DEV_SHOP_DOMAINS=asb-checkout-lab.myshopify.com` on the **development runtime only**. This is a public shop identifier, never an API credential; the existing adapter still refuses all shops unless explicitly allowlisted at runtime.
- **Verified read-only through Shopify Admin GraphQL:** `shop.myshopifyDomain=asb-checkout-lab.myshopify.com`, currency `PKR`, `ianaTimezone=Asia/Karachi`, 3 draft products and 0 orders. Connected ChatGPT app advertises `write_orders` and `write_products` scopes.
- **Actual orderCreate mutation probe:** Shopify rejected it before creating anything: `Access denied for orderCreate field. Required access: write_orders access scope. Also: This mutation is only accessible to apps authenticated using offline tokens.` GraphQL `currentAppInstallation.accessScopes` reporting `write_orders` is NOT enough: Shopify also requires **offline token authentication**.
- **Correct next path:** Install a **separately registered ASB Checkout Lab Bridge** app on the dev store with offline authorization; use its server-side session (e.g. `unauthenticated.admin(shop)` in the Shopify React Router runtime), with `read_products,write_orders`. Test the capability from that app's server, never by extracting/pasting tokens. Do not modify the existing production ASB Data Manager app's scopes or App Store configuration.
- **Dev-only PostgreSQL state added:** `db/migrations/023_checkout_quote_redemptions.sql`, `checkout/redemption-ledger-pg-v1.js`, `test/adr002-pg-ledger.test.js`; an **approved policy verification callback is mandatory**, and a deployment/customer-auth route is NOT yet implemented. The synthetic verifier in tests does not authorize production checkout.

## App installation and permission contract

- The ASB server-order adapter uses Shopify **Admin GraphQL 2026-10**, `orderCreate` with `write_orders` scope; verify the installed app's **effective scopes**, not just what shopify.app.toml requests. Only create a dedicated development-app installation if needed; do not silently add `write_orders` to the production ASB Data Manager app.
- For a Shopify app proxy, request and verify `write_app_proxy`, Shopify proxy HMAC and **separate authenticated customer identity**. Proxy origin alone is not shopper authentication.
- Configure `ASB_ALLOWED_DEV_SHOP_DOMAINS` with the **exact** new dev-store domain. Deny live `apnasastabazaar.com` and any production `*.myshopify.com` domain in all test runners.
- Keep offline tokens and HMAC secrets in the selected environment's secure secret store only. Never commit or paste credentials.
- No delivery fees, no taxes, no live WhatsApp delivery and no live inventory deductions in synthetic cases.

## Tests to execute only against the isolated Dev store

T0: server-authenticated household quote reservation (durable Postgres atomic claim) + two concurrent redemption attempts -> **one** Shopify order and one COD obligation. Retry/timeout -> same order ID or needs_reconcile; never second `orderCreate`.

T1: three synthetic variants: Apna Onion 1kg, Dish Ginger 40g, Community Hero 10kg; one mixed-door Shopify `orderCreate` COD/PENDING, `quantity:1` per exact line, signed quote metadata preserved, free shipping and zero taxes. Verify response `currentTotalPriceSet` in PKR against integer `payablePaisa`.

T3: tampered quote total/door/quantity/tier and wrong household identity fail **before** Shopify. Verify strict GID, tier metadata, and policy source.

T2 follow-up: lock prices, pack 1.08kg of a 1kg Rs100/kg accepted line, final price Rs95/kg, line remains Rs100 or less, whole-rupee COD correct, Shopify `orderEdit` and WhatsApp match; no bill resend/duplicate COD.

Community verification: no Rate Meter increase on orderCreate; only confirmed server-order WhatsApp and Option A security evidence can move pending -> verified, and frozen snapshots survive refusal after lock.

## Hard no-go gates

- No actual Admin `orderCreate` until durable quote redemption ledger with strong replay/concurrent locking is implemented and tested (PR #10 currently only supplies injected mock-ledger coordinator).
- Never use the user's unpublished theme as the isolated integration store; it shares production backend. It remains suitable for visual UX simulation.
- Never switch the assistant's currently connected production Shopify shop to the dev store unless explicitly coordinated; doing so revokes the existing connection.
- No tests involving real customer PII, live delivery, COD collection, paid gateway or production webhooks.

Official Shopify documentation:
https://shopify.dev/docs/apps/build/stores/development-stores
https://shopify.dev/docs/api/shopify-cli/store/store-create-dev
https://shopify.dev/docs/api/admin-graphql/2026-10/mutations/orderCreate

**Next blocker (confirmed):** obtain Shopify offline authentication **from a separate dev app** and connect it to the durable DB/quote/household policy route, then execute exactly one controlled `orderCreate` and verify order ID, `PENDING` financial status, PKR amount, delivery metadata, receipt suppression and idempotency. Do not confuse the connector's online token with an offline app token.
