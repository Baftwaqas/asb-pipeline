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
