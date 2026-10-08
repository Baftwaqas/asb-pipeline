# ASB Pipeline

Apna Sasta Bazaar — Shopify → WhatsApp order pipeline.

## What this server does

1. `GET /` — health check ("ASB Pipeline is running")
2. `GET /webhooks/whatsapp` — Meta's webhook verification handshake
3. `POST /webhooks/whatsapp` — receives inbound WhatsApp messages (logs them)
4. `POST /webhooks/shopify` — receives new Shopify orders (HMAC-verified) and
   sends the `order_confirmed` WhatsApp template to the customer

## Environment variables (set in Render dashboard)

| Name | What it is |
|------|-----------|
| `VERIFY_TOKEN` | Any secret word you invent, e.g. `asb-verify-2026`. Must match what you type in Meta's webhook setup. |
| `WHATSAPP_TOKEN` | Access token from Meta → WhatsApp → API Setup |
| `PHONE_NUMBER_ID` | The Phone number ID of the sending number (test: 1252083427990398) |
| `SHOPIFY_WEBHOOK_SECRET` | Shown by Shopify when you create the webhook |

## Run locally (optional)

```bash
npm install
npm start
```

## Community isolation + durable intake (Phase 1, branch `community-backend-v1`)

Community Bulk Buying packs are diverted away from the grocery pipeline
**before** Shopify gets its 200. See `community/` and migration 016.

Deploy order (each step is safe with the code before it):

1. `node scripts/migrate.js --dry`, then `node scripts/migrate.js` — applies `016_community_intake.sql` (additive: 3 new tables).
2. `node scripts/community-registry.js --snapshot db/community/registry-snapshot-2026-10-08.json` (dry run), then add `--apply`.
3. Deploy the code. Boot logs `[community] registry: N Community variants`.

| Name | What it is |
|------|-----------|
| `COMMUNITY_INTAKE_WORKER` | `off` disables the intake worker and sweeper (default on) |
| `COMMUNITY_INTAKE_SWEEP_MS` | sweeper interval, default 60000 |
| `COMMUNITY_INTAKE_MAX_ATTEMPTS` | failed attempts before a line goes to review, default 8 |
| `COMMUNITY_VENDORS` | optional comma list of Shopify vendors that mark a line Community (empty by default) |
| `SHOPIFY_SHOP_DOMAIN` | fallback shop id when the webhook has no `X-Shopify-Shop-Domain`; also used by the registry reconcile script |
| `SHOPIFY_ADMIN_TOKEN` | read_products token, **only** for `scripts/community-registry.js --from-shopify` |

Tests: `npm test` (needs a scratch Postgres; `TEST_PG_URL`, default `postgres://postgres@localhost:54330`).
