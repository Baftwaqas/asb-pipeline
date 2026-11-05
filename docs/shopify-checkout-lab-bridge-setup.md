# ASB Checkout Lab Bridge — Shopify Dev Dashboard app (5 November 2026)

**VERIFIED INSTALLED (read-only Shopify Admin GraphQL):** App title `ASB Checkout Lab Bridge.`, non-embedded (`embedded=false`), installed on `asb-checkout-lab.myshopify.com` with granted `read_products` and `write_orders`. The blank Shopify Admin panel is expected for a non-embedded API-only app. This does NOT grant the ChatGPT connection an offline token for the Bridge app; separate server-held client credentials are still required for actual order creation.


## Why a separate app is required
The connected ChatGPT Shopify app can READ/WRITE catalog fixtures and reports `write_orders`, but the isolated dev-shop `orderCreate` mutation rejected its session with:
`Access denied for orderCreate field. Required access: write_orders access scope. Also: This mutation is only accessible to apps authenticated using offline tokens.`
This was a genuine Shopify API attempt: **no order was created**. The connector does not expose a server-held application token usable by our code. **Do not use a production app or change its scopes.**

## Completed store-owner setup (no Plugins, no token sharing)
1. Sign in at https://dev.shopify.com/ and choose the organization containing the already-created dev shop **ASB Checkout Lab**.
2. Select **Apps → Create app → Start from Dev Dashboard**. Name it **ASB Checkout Lab Bridge**. This is a NEW, API-only DEV app, not a clone/configuration change to the production ASB Data Manager.
3. In the app's **Versions**, create a version with **`read_products,write_orders`** as the minimal scopes for catalogue checking and order creation. The default non-embedded App URL is acceptable if no admin UI is needed. **Release** the version.
4. Select **Install app**, then choose **ASB Checkout Lab / asb-checkout-lab.myshopify.com**. Confirm Shopify permission approval. **Do not install on `apnasastabazaar.com`.**
5. Tell the development team only **"ASB Checkout Lab Bridge installed"**. **Do not paste Client ID, Client secret or any access token into ChatGPT, GitHub issues, screenshots or emails.** Any later credentials must be supplied only to the secret environment of the dedicated development runtime, not to the browser/storefront.

## The backend implementation already committed
- `checkout/dev-shopify-credentials-v1.js` requests an app token using the server-to-server `client_credentials` grant `POST https://{shop}.myshopify.com/admin/oauth/access_token`, using `client_id`, `client_secret`, `grant_type=client_credentials`.
- It validates the **actual** granted `write_orders` scope and reads the actual `shop.myshopifyDomain`, `currencyCode=PKR`, `ianaTimezone=Asia/Karachi` before any mutation.
- Tokens are cached temporarily server-side using Shopify's reported `expires_in` with a safety margin, never returned to users or logged.
- If your app/store are in different Shopify organizations, Shopify rejects the grant (`shop_not_permitted`): choose an app in the same organization as the dev store. The client credential path is intended for stores **owned by the app's organization**, not external merchant stores.
- `checkout/dev-shopify-graphql-v1.js` authorizes exactly allowed dev domains and only the reviewed `orderCreate` operation. There is NO production allowlist.
- `checkout/redemption-ledger-pg-v1.js` and migration `023` atomically guard one commitment per household/cycle, signed quote, expiry and cutoff, and never retry uncertain Shopify outcomes.
- The policy verifier is **mandatory** but not production-integrated yet. No web endpoint to receive an unauthenticated browser quote exists yet. Consequently the combined system is not live.

## Render infrastructure created and verified (5 November 2026)

**Separate from production infrastructure.** The production service `asb-pipeline` (Render, `main`) and production Neon `ASB` project have not been modified.

| Resource | Verified |
| --- | --- |
| Dev web service | [asb-checkout-lab-bridge](https://dashboard.render.com/web/srv-dbm8vvt6e07s73bgu25g), FREE, Singapore, manual deploy, checkout feature branch only |
| Dev web URL | https://asb-checkout-lab-bridge.onrender.com/health — **SAFE_LOCKED** health only, no customer/order API route |
| Isolated Postgres 18 | [asb-checkout-lab-pg18](https://dashboard.render.com/d/dpg-dbm8v3qjnfac738pc31g-a), FREE, Singapore, database `asb_checkout_lab_pg18` |
| Free PG expiry | **5 December 2026** (Render free database expiration; test fixture only) |
| Shopify bridge app | Installed on `asb-checkout-lab.myshopify.com`, granted scopes `read_products,write_orders` |
| End-to-end source | `scripts/lab-one-order-v1.js`, exact variant IDs, synthetic signed quote and household, real PG claim, COD Shopify `orderCreate` with test flag |
| Startup gate | `checkout/lab-bridge-server.js` requires an explicit isolated DB resource ID + operator flags before migrations or a single test order. Public HTTP has no writes. |

**Already configured by Lane A on the DEV Render service:** `ASB_LAB_SHOP_DOMAIN`, `ASB_LAB_WRITE_MODE=disabled`, `ASB_ENV=development`, `ASB_LAB_APP_CLIENT_ID` verified against Shopify, random `ASB_QUOTE_SECRET` (secret), `ASB_MUTATION_DB_NAME=asb_checkout_lab_pg18`. The order and migration one-shot flags remain disabled.

### Exactly TWO remaining secrets — add them DIRECTLY in Render, never this chat

1. Open [the separate Render database](https://dashboard.render.com/d/dpg-dbm8v3qjnfac738pc31g-a) → **Connect / Internal**. Copy its **Internal Database URL** (contains password).
2. Open [the DEV Render service](https://dashboard.render.com/web/srv-dbm8vvt6e07s73bgu25g) → **Environment**. Add `DATABASE_URL` with that complete internal URL. Do **not** paste the database URL into ChatGPT, GitHub or the live production Render service.
3. In the Shopify Dev Dashboard open the **ASB Checkout Lab Bridge.** app → **Credentials**. Copy the existing **Client secret** (do not rotate it) directly into the same DEV Render service Environment as `ASB_LAB_APP_CLIENT_SECRET`. Do not reveal in screenshots or chat.

**After the owner confirms those two env keys exist:** Lane A can set two **non-secret, single-use operator flags** via the connected Render tool (`ASB_LAB_MIGRATE_ONCE=RUN_LAB_MIGRATIONS` and `ASB_LAB_ONE_SHOT_RUN=RUN_NOW_ONCE`) and trigger one dev deployment. On startup the server will validate the EXACT database resource ID `dpg-dbm8v3qjnfac738pc31g-a`, run migrations, write a signed synthetic quote for the next Mon/Thu Karachi cutoff, commit an exclusive household-cycle claim and call Shopify with the DEV app's server token exactly once. On a Shopify uncertain outcome it stops in `needs_reconcile`; it does not retry or send WhatsApp.

**Expected test order:** one PENDING COD order for 500 g Onion Rs45, 40 g Ginger Rs11.20 (Dish), 10 kg Community Hero Onion Rs1500, with Rs0.20 whole-rupee credit → **Rs1556 COD**. All test products remain DRAFT. No actual collections, customer billing, inventory updates, payment or fulfillment.

## Remaining dev gates
1. Install the separate Shopify app and authenticate on a dedicated development backend.
2. Configure a secure environment in Render or an isolated service: `ASB_ALLOWED_DEV_SHOP_DOMAINS=asb-checkout-lab.myshopify.com`, `SHOPIFY_CLIENT_ID`, `SHOPIFY_CLIENT_SECRET`, `DATABASE_URL` (scratch only), `QUOTE_HMAC_SECRET` (server secret).
3. Implement a server-issued quote + identity-verified household validator and consistent quote persistence. The tests use a synthetic verifier and mock Shopify network.
4. In the dev shop only, execute **one controlled orderCreate**, with synthetic fixture GIDs and `sendReceipt:false`, `inventoryBehaviour:BYPASS`, `PENDING` COD; compare total and store order GID; check no real messages, payment or fulfillment.

Official 2026 docs:
- https://shopify.dev/docs/apps/build/dev-dashboard/create-apps-using-dev-dashboard
- https://shopify.dev/docs/apps/build/authentication-authorization/client-credentials-grant
- https://shopify.dev/docs/apps/build/authentication-authorization/access-tokens

**Production store unchanged. No secret should ever appear in version control.**
