# ASB Checkout Lab Bridge — Shopify Dev Dashboard app (5 November 2026)

## Why a separate app is required
The connected ChatGPT Shopify app can READ/WRITE catalog fixtures and reports `write_orders`, but the isolated dev-shop `orderCreate` mutation rejected its session with:
`Access denied for orderCreate field. Required access: write_orders access scope. Also: This mutation is only accessible to apps authenticated using offline tokens.`
This was a genuine Shopify API attempt: **no order was created**. The connector does not expose a server-held application token usable by our code. **Do not use a production app or change its scopes.**

## One-time store-owner setup (no Plugins, no token sharing)
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
