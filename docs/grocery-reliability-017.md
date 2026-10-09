# Grocery reliability — migration 017 (`orders/create` only)

Branch `grocery-reliability-017`. Nothing here is live until Waqas approves each production step below.

## What it fixes

| Problem on `3296c0f` | Fix |
|---|---|
| The same Shopify order under a new delivery ID merged into its own bag again (qty doubled, second bill) | `shopify_order_sources`: one row per Shopify order, reserved **before the 200** in the capture transaction. A known order is never applied again; different content raises a `duplicate_anomaly` alert. |
| Grocery persistence and the bill ran after the 200, so a restart lost the order | The source row is the durable job. A kick after the 200, plus a sweeper (`grocery/worker.js`) with leases, attempt counting and backoff, then `review`. |
| An improvised bill was sent when the database write failed | Removed. A bill is sent only from a **frozen snapshot** made in the apply transaction. |
| Bill sending was neither at-most-once nor auditable | One attempt row per send started; one `whatsapp_messages` row per attempt. Ambiguous results become `unknown` and are reconciled by hand. |
| Receipts were applied after the 200 and could downgrade (`read` → `sent`, `delivered_at` cleared) | Receipts are journalled **before** the WhatsApp 200, then applied monotonically and replayed. |

## Components

- `db/migrations/017_shopify_order_sources.sql`: additive tables, guards and the `asb_msg_status_rank()` function.
- `grocery/fingerprint.js`: the frozen commerce fingerprint, v1.
  - A duplicate is always fingerprinted at **the source's** version.
- `grocery/sources.js`: T0 reservation.
- `grocery/apply.js`: T1a claim, T1b apply, T1c failure.
- `grocery/write.js`: the bag writer.
- `grocery/billing.js`: T2 claim, T3 send, T4 finalize, plus claim expiry.
- `grocery/outbound.js`: in-transaction WhatsApp log.
- `grocery/receipts.js`: journal, monotonic apply, replay.
- `grocery/alerts.js`: alert outbox.
- `grocery/switches.js`, `grocery/activation.js`: kill switches.
- `grocery/backfill.js`: legacy mapping.
- `grocery/operator.js`: manual actions.
- `whatsapp.js`: structured transport result (`accepted | not_sent | refused | ambiguous`).
  - 131047 means `not_sent`, and the retry goes as a template.
- Scripts:
  - `npm run grocery:backfill`
  - `npm run grocery:activate`
  - `npm run grocery:review`

## Switches (both default OFF)

| Switch | Needs |
|---|---|
| Worker | `GROCERY_SOURCE_WORKER=on`, the backfill marker, and a worker activation (`grocery:activate --worker`) |
| Bills | `GROCERY_BILL_SEND=on` and a bill activation (`grocery:activate --bills`, which needs the worker activation first) |

The env flag always wins, so an emergency stop is one Render change.

### Alerts and push

| Setting | Effect |
|---|---|
| `GROCERY_ALERT_PUSH=on` | Grocery alerts are pushed to the inbox devices. **Default off:** alerts are still recorded and shown in `/healthz` and `grocery:review`, and they wait as `pending`. |
| `PUSH_DISABLED=1`, or app_settings `asb_environment='rehearsal'` | **Every** push from the app is suppressed, inbox notifications included. No network request is made. |

An alert counts as `sent` only when at least one device accepted it. With no subscribed devices, or when every device fails, it is retried with backoff and then becomes `gave_up`, which `/healthz` shows.

**Before production activation:** at least one ASB phone must have inbox notifications switched on.

### Lossless Shopify ids

Shopify webhook bodies are parsed with `grocery/orderjson.js`:

- every number up to 2^53 is kept exactly as `JSON.parse` would keep it;
- an integer beyond 2^53 keeps its exact digits as text, through capture, Community classification, apply and the operator tools;
- on a Node without JSON source access, such an order is refused with a 503 rather than corrupted.

**While the worker is off, grocery is PAUSED.** Orders are captured safely but don't reach `orders`, the packing list or bills. `/healthz` reports this under `grocery`.

## Neon rehearsal (before any production step)

Each step needs Waqas's approval. Nothing here touches production; real WhatsApp and real push are impossible throughout.

1. **Branch.** Create a Neon branch from production. It contains customer data, so it is deleted at the end.
2. **Mark it.** Run `INSERT INTO app_settings (key, value) VALUES ('asb_environment','rehearsal')` on the branch.
   - This suppresses every push, even though the branch carries the real `push_subscriptions` and VAPID keys.
3. **Migrate.** Apply 017 on the branch.
4. **Backfill.** Run the dry run on the real data and check every mapping. Then apply it with the printed `plan_sha256`.
5. **Fake Graph.** Start `FAKE_GRAPH_PORT=4599 node scripts/fake-graph.js` on the rehearsal machine.
   - Modes: `accept` (default), `window_first` (rehearses 131047, then the template retry), `timeout_first` (rehearses an ambiguous send, then `unknown`).
6. **Staging app.** Run it against the branch with:
   - `GRAPH_BASE=http://127.0.0.1:4599/v25.0`
   - `WHATSAPP_TOKEN=fake-token`, `PHONE_NUMBER_ID=000000`
   - `PUSH_DISABLED=1` (a second layer)
   - `GROCERY_SOURCE_WORKER=on`, `GROCERY_BILL_SEND=on`, `GROCERY_ALERT_PUSH=on`
   - no Shopify Admin token

   Then record the worker and bill activations on the branch.
7. **Guard.** `community:rehearsal` refuses unless:
   - the database is marked as a rehearsal copy;
   - Meta calls go to a local host (or there is no token at all);
   - `/healthz` reports the 017 grocery pipeline as available;
   - `grocery.worker_enabled === true`, `grocery.bills_enabled === true` and `grocery.alert_push === true` (strict: a missing or non-`true` value refuses, and the error names every missing switch);
   - push is suppressed (`grocery.push_suppressed`).
8. **Run.** `npm run community:rehearsal`. It covers A–H plus I (same order, new delivery ID), J (changed content) and K (source states).
   - Then check that bills went to the fake Graph with `wamid.FAKE…`, and that alerts are recorded but none were `sent`.
9. **Operator tools.** Try `grocery:review`: resend, hold/release, and `link-receipt --attempt`, using synthetic signed receipts.
10. **Tear down.** Delete the Neon branch.

## Production cutover

Every step needs Waqas's explicit approval. Steps 2–7 happen in one supervised, quiet window.

1. Apply 017: `node scripts/migrate.js`. Old code ignores the new tables.
2. Deploy the 017 code with `GROCERY_SOURCE_WORKER=off` and `GROCERY_BILL_SEND=off`.
   - `/healthz` gives 503 until 017 is applied, so a deploy ahead of the migration is caught.
3. Confirm the old instance is gone:
   - Render's Events show the new deploy live and the old instance stopped;
   - repeated `/healthz` calls show the new `build`;
   - this query returns 0, and still returns 0 again after a quiet interval:
     ```sql
     SELECT count(*) FROM webhook_events we
      WHERE we.source='shopify' AND we.topic='orders/create' AND we.received_at > '<deploy live time>'
        AND NOT EXISTS (SELECT 1 FROM shopify_order_sources s WHERE s.first_webhook_event_id = we.id)
        AND NOT EXISTS (SELECT 1 FROM shopify_order_source_duplicates d WHERE d.webhook_event_id = we.id);
     ```
4. Definitive dry run: `node scripts/grocery-backfill.js --shop 0du4xf-6j.myshopify.com`.
   - Waqas approves the printed `plan_sha256`.
5. Apply:
   ```
   node scripts/grocery-backfill.js --shop ... --apply --plan-sha <hash> --by "Waqas" --reason "..."
   ```
   - It runs as one transaction under an advisory lock.
   - It refuses if the plan hash changed.
   - It writes the marker last.
6. Check health:
   - the marker is present;
   - old orders are mapped (`legacy`);
   - new orders are waiting in `received`;
   - there are no anomalies.
7. Activate the worker.
   - First confirm at least one ASB phone has inbox notifications on, and set `GROCERY_ALERT_PUSH=on`.
   - Set Render `GROCERY_SOURCE_WORKER=on`, then:
   ```
   node scripts/grocery-activate.js --worker --by "Waqas" --reason "..." --apply
   ```
   Watch the first orders apply; their bills stay `pending`.
8. Activate bills. Set Render `GROCERY_BILL_SEND=on`, then:
   ```
   node scripts/grocery-activate.js --bills --by "Waqas" --reason "..." --apply
   ```
   Bills older than `GROCERY_BILL_MAX_AGE_H` (6) become `stale`. Resend them by hand where appropriate.

## Rollback ladder

Once the worker has been activated, **never redeploy `3296c0f` on its own.** That code ignores `shopify_order_sources`.

| Level | Action |
|---|---|
| L1 | Turn `GROCERY_BILL_SEND` and/or `GROCERY_SOURCE_WORKER` off. Capture continues and nothing is lost. |
| L2 | Redeploy the previous 017-aware release (by its tag). |
| L3 | Deploy the compatibility build `rollback-compat-017`: `3296c0f` plus a source guard in `persistOrder`, no improvised bill. **Not built yet.** It must be built, tested and approved before step 7. |

The schema is never rolled back; the guards refuse DELETE and TRUNCATE.

## Operator actions

All actions use `scripts/grocery-review.js` and need `--by`, `--reason` and `--apply`.

- `requeue`
- `dismiss` (optionally `--link-order`)
- `reopen-legacy` (optionally `--with-bill`)
- `anomaly-ack`
- `bill-resend`: persists `bill_authorization_audit_id` on the source; the claim records it on the attempt.
- `bill-compose`
- `bill-confirm-sent`
- `bill-abandon`
- `bill-hold` / `bill-release`
- `link-receipt`: never automatic.

## Golden tests

- `test/grocery-compat-pre-phase1.test.js`: fixed to `2904c91`. Kept until deliberately retired.
- `test/grocery-golden.test.js`: compares against the previous production release in `test/golden-baseline.json` (`prod-2026-10-08-phase1` = `3296c0f`).
  - Update that file deliberately with each release.
  - Changed golden-covered behaviour must be listed in `expected_diff`.
- Both tests fail on a vacuous baseline, and fail on a missing baseline when `CI=1`.
