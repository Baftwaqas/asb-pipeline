# ASB — Real isolated Shopify Grow checkout proof: execution gates and staging setup

**Recorded:** 22 October 2026. **Current state:** staging proof tooling prepared in GitHub; **no separate authenticated Shopify development-store connection is available through the current session**. As a result, no Shopify test Draft Order, invoice, completed checkout or COD transaction has been created or verified. This is deliberately **not** a claim of checkout integration readiness.

## Why a separate development store is mandatory

The connected Shopify account currently resolves to the **live** ASB merchant shop at apnasastabazaar.com, on Grow. The unpublished `ASB Community Prototype` / `ASB Apna Order Development V1` themes were created **inside this real store**, so a checkout through their preview could still produce genuine merchant orders. Never run checkout-bypass tests through those themes, even if they look like staging.

There may already be a separate store named `asb-recipe-master-dev`, mentioned in earlier ASB work. Treat its existence, current plan, credentials and independence as **unverified in this session** until an authenticated check proves it.

The Shopify connector currently has access to the live shop only. Switching that connector to a different shop would revoke its live token and trigger a re-authorization. The user has NOT been silently switched.

Official Shopify documentation: https://shopify.dev/docs/apps/build/stores/development-stores

## Development-store environment

Create or use a **genuinely separate** Shopify dev store in Shopify Dev Dashboard > Stores > Create store > Dev; choose **Grow** and **Pakistan** for closest production parity, with optional sample data. Alternatively, on the user's own computer with an authenticated Shopify CLI:

```powershell
shopify store create dev --name "ASB Checkout Proof Dev" --plan grow --country PK
```

Do not enter this command in the live store or make a second paid merchant store as a substitute. The dev store must have its own *.myshopify.com identity and protected dev-password page. Dev store checkout tests can use Shopify's test payment gateway or other supported test-payment modes; Cash on Delivery availability on its Draft Order checkout **must be demonstrated**, not inferred.

Use a **development-only app/admin API token** with the minimum needed scopes. Never reuse Render's live `SHOPIFY_ADMIN_TOKEN`, paste credentials into GitHub, a chat, terminal history, scripts, or logs. For the initial identity check, an authorized app with Shopify Admin GraphQL read access is sufficient. A later Draft Order calculate call may require draft-order scopes; its exact access requirement must be confirmed in the dev store.

### Windows PowerShell commands (only on the user's computer, after dev store exists)

```powershell
# In the repo working directory; use the dev branch, not main.
git fetch origin asb-billing-v3-checkout-policy-dev
git switch asb-billing-v3-checkout-policy-dev
$env:ASB_DEV_MYSHOPIFY_DOMAIN = "<verified-dev-store>.myshopify.com"
$env:ASB_DEV_ADMIN_TOKEN = Read-Host "Dev store Admin API token"
node scripts/shopify-grow-dev-store-probe.js
# Only after the identity guard passes:
node scripts/shopify-grow-dev-store-probe.js --calculate --scenario=apna145
node scripts/shopify-grow-dev-store-probe.js --calculate --scenario=community1200
Remove-Item Env:\ASB_DEV_ADMIN_TOKEN
```

**Important:** `Read-Host` as written uses ordinary prompt input; if desired, use a secret manager or a secure credential process to avoid accidental exposure. Do not save or share the token. Running this script without both environment variables will fail closed.

## Implemented technical preconditions

- `scripts/shopify-grow-dev-store-probe.js` refuses production Shopify domain `0du4xf-6j.myshopify.com` or `apnasastabazaar.com`, requires dev/test/sandbox/staging domain naming, and refuses any shop not confirmed via Admin API as `shop.plan.partnerDevelopment=true`, **Grow**, **non-Plus** and **PKR**. Any mismatch aborts before draft calculation.
- `--check` sends an identity **query only**. `--calculate` sends Shopify's **nonpersistent** `draftOrderCalculate` GraphQL mutation with a **custom sample item** and a free-shipping line; it reads computed taxes, discounts, shipping and total, and compares all to the approved sample arithmetic. **Neither mode creates a draft, accepted order, invoice or WhatsApp message.**
- The sample values Rs 145 and Rs 1,200 are **fixtures**, not actual current ASB catalogue quotes. Their local feature restrictions were tested earlier in `checkout/offline-grow-preflight-v1.js`; a custom-item Shopify calculation does not verify product/variant eligibility.
- No assumption that passing a server preflight prevents customers from bypassing the flow by direct Shopify cart and checkout URLs.

## Future real Shopify checkout proof — still not performed

After dev-store authentication succeeds and the calculation matches, design a **separate, controlled, dev-only write stage** with signed checkout-context binding, idempotency, immutable quote record, native variant ID and dedicated Community test SKUs. Do not automatically create drafts on module import, when running CI, or with production credentials. Then manually test:
1. Rs 145 Apna (no minimum), Rs 1,199.99 Community rejected, Rs 1,200 Community accepted, discounts changing the Community floor, 5+5 duplication, 10kg quantity 2, mixed Apna+Community.
2. Same Shopify variant through Apna + Dish-to-Cart and distinct line provenance on accepted Shopify order.
3. Native checkout links, accelerated checkout, deleted/forged line attributes, changes between validation and checkout, concurrent requests, and duplicate webhooks.
4. Draft Order invoice **checkout** for an eligible test customer: is COD shown and retained as intended? If not, reject Draft Order path as unsupported for ASB and re-evaluate a compatible Shopify App Store validation app.
5. Accepted order's `createdAt`, amount due, paid/pending financial state, shipping Rs 0, tax, refunds, proof of no WhatsApp sends and no live customer contact.
6. Destroy only the explicit test fixtures after confirming they are in the **separate dev store**. No automatic cancellation or cleanup in the live shop.

**Release gate:** independent development-store end-to-end evidence is required before Shopify integration, Meta V3 template submissions, data migrations, or production messaging. Passing CI alone is never equivalent to a Shopify checkout hard gate.

## Existing business context and prohibited operations

Our architecture remains **Option B** (long term unified feature-wise customer statement), with initial **B-prime** rollout (Apna+Dish compatible grocery group; Community separate until settlement is implemented). Bhao Tao stays non-grocery only. The three outdated Shopify Community %-discounts were previously deactivated by explicit owner authorization; do not reactivate.

**No code or script in this proof sends an order, creates a Draft Order, edits a product, changes Shopify discounts, touches Render/Neon or activates WhatsApp.** Any later live-store changes require separate explicit approval.
