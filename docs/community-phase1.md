# Community Phase 1 — isolation + durable intake

Branch `community-backend-v1`. Phase 1 only: Community lines are kept out of
the grocery pipeline and stored durably before Shopify is acknowledged. No
commitments, verification, Rate Meter, settlement or trust logic.

## 1. Data model (migration `016_community_intake.sql`)

| Table | Purpose | Key | References |
|---|---|---|---|
| `community_products` | Registry: Shopify products that are Community | `shopify_product_id` (PK), `product_gid` (unique) | — |
| `community_variants` | Registry: their variants. Variant id is canonical; SKU is informational, not unique | `shopify_variant_id` (PK), `variant_gid` (unique) | `shopify_product_id` → `community_products` |
| `community_intake` | One row per Community order line, captured before the 200 | `id`; **unique `(shop, shopify_order_id, shopify_line_item_id)`** | `webhook_event_id` → `webhook_events(id)` `ON DELETE RESTRICT` |
| `community_audit` | Append-only log of operator/system actions | `id` | — (target by type + id) |

Database-enforced rules:

- `community_intake` captured facts (including `id`) are **immutable** (trigger `community_intake_guard`); rows can't be deleted; a resolution, once made, is final.
- Registry rows can't be deleted (deactivate instead). No Community table can be `TRUNCATE`d — including via `TRUNCATE webhook_events CASCADE`.
- Allowed states: `received → resolved | review | retryable_error`, `retryable_error → resolved | review | retryable_error`, `review → received` (operator re-queue only). `resolved` is final in Phase 1.
- `resolved` requires `resolved_variant_gid` and `resolved_at`; any other state requires them to be NULL; `review` requires `review_reason`.
- A deactivated registry row must carry `deactivated_at`, `deactivated_by` and `deactivation_reason`.
- `community_audit` rejects UPDATE and DELETE.

### What intake keeps for Phase 2 (no Shopify needed later)

Every `community_intake` row is self-contained:

| Needed | Column |
|---|---|
| shop domain | `shop` (`X-Shopify-Shop-Domain`) |
| Shopify order id / name | `shopify_order_id`, `shopify_order_name` |
| Shopify line item id | `shopify_line_item_id` |
| product identity | `shopify_product_id` |
| variant identity | `shopify_variant_id` |
| quantity, SKU, title, variant title, unit price, currency | `quantity`, `sku`, `title`, `variant_title`, `unit_price`, `currency` |
| order `created_at` | `order_created_at` |
| customer | `customer_phone` (normalised), `shopify_customer_id` |
| the line as received | `line_payload` |
| **the whole order as received** | `order_raw` (request body, byte for byte) + `order_payload_sha256` (its SHA-256, re-verifiable from `order_raw`) + `order_payload` (same order parsed, for querying) |
| the delivery that captured it | `webhook_event_id`, `topic`, `received_at` |
| why it was diverted | `classification`, `signals` |

`webhook_events.payload` is a second copy, not the source of truth: the
foreign key stops that row being deleted while intake references it, but the
column itself is not write-protected (the inbox updates payloads of its own
`source = 'inbox'` rows). Phase 2 must read `community_intake.order_raw` /
`order_payload`.
Retention assumption: nothing in the codebase deletes `webhook_events` or
`community_intake`; any future retention job must skip referenced events (the
FK enforces it).

A later delivery of the same order (re-send, `orders/updated`) never rewrites
the first capture: the unique key keeps the first row, and its facts are
immutable. Order edits are a Phase 2/4 concern (events), not overwrites.

## 2. Flows

**Classification** (`community/classify.js`) — any signal diverts a line:
`registered_variant` (active variant of an active product), `registered_product`
(active product), `sku_prefix` (`ASB-COM-`), `already_captured`. **Vendor is
never a signal** (Community and grocery share "Apna Sasta Bazaar"); it is only
stored on the intake row as evidence. Only an exact registered variant id makes it
`registered`; anything else is `suspect`. SKU never resolves a pack. A line
already in `community_intake` (same order + line id) carries
`already_captured` and stays Community on every later delivery, whatever the
registry says by then.

**Topic allowlist.** Phase 1 acts on exactly these Shopify topics:

| Topic | Handling |
|---|---|
| `orders/create` | Community capture + grocery pipeline |
| `products/create`, `products/update`, `products/delete` | registry refresh + productSync (Community refused) |
| anything else — `orders/updated`, `orders/edited`, `orders/cancelled`, `orders/paid`, `customers/*`, `fulfillments/*`, unknown, or **missing** | recorded in `webhook_events` with status `ignored`, answered 200; never reaches `persistOrder`, never merges quantities, never sends a bill |

A missing `X-Shopify-Topic` is no longer assumed to be `orders/create`.

**Shop identity.** `X-Shopify-Shop-Domain`, else the configured
`SHOPIFY_SHOP_DOMAIN`. If neither exists the delivery is answered 503 and
nothing is written — no record is ever stored under an invented shop. Set
`SHOPIFY_SHOP_DOMAIN=0du4xf-6j.myshopify.com` in production as the fallback.

**Before the 200** (`community/intake.js`, one transaction, no network):
HMAC → topic allowlist → shop identity → insert `webhook_events` (duplicate
delivery → 200, stop) → `orders/create`: classify + insert intake rows /
`products/*`: refresh registry → COMMIT → 200. Any failure → 503, nothing
written, Shopify retries.

**After the 200** (unchanged grocery code): grocery-only order → exactly as on
`main`. Mixed order → the grocery pipeline receives an **allow-listed
grocery-only view** (`community/sanitize.js`): grocery lines only, no Shopify
totals/refunds/fulfillments, plus an `asb_community_split` marker. That view is
what `orders.source_payload` stores. Community-only order → no grocery order,
no bill. `persistOrder` refuses (rolls back) any order still containing a
Community line. If that happens because the registry changed between the
pre-200 capture and the grocery write, the newly-Community lines are captured
to `community_intake` and the grocery write is retried once with the remaining
grocery lines; a second refusal sends nothing and marks the webhook failed.

**Worker** (`community/worker.js`): validates quantity (= 1) and identity,
resolves by exact registered variant id. Review reasons: `invalid_quantity`,
`quantity_not_one`, `no_variant_id`, `unknown_variant[_with_community_sku]`,
`product_mismatch`, `product_deactivated`, `variant_deactivated`,
`registry_config_conflict`, `product_deleted`, `product_archived`,
`variant_not_present`, `sku_mismatch`, `max_attempts_exceeded`. Errors →
`retryable_error`, backoff 30 s doubling to 1 h, `review` after 8 attempts.
One sweep at a time per process; rows are row-locked (`SKIP LOCKED`).

## 3. Operations

| Need | Command |
|---|---|
| What needs a person | `npm run community:review` (`--all`, `--status review`, `--order 1030`, `--json`, `--stuck-min 10`) |
| Re-queue one review row after fixing the cause | `npm run community:review -- --requeue <id> --by "Waqas" --reason "..." [--apply]` |
| Deactivate a mistaken product (after removing its Community type/tag/SKU in Shopify) | `npm run community:registry -- --deactivate-product <id> --by "Waqas" --reason "..." [--apply]` |
| Withdraw one pack | `npm run community:registry -- --deactivate-variant <id> --by ... --reason ... [--apply]` |
| Undo | `--reactivate-product <id>` / `--reactivate-variant <id>` (same flags) |
| Bootstrap an EMPTY registry (once) | `npm run community:registry -- --snapshot db/community/registry-snapshot-2026-10-08.json [--apply]` |
| Recovery only: re-apply a snapshot over a populated registry | `... --snapshot <file> --force-bootstrap --by "Waqas" --reason "..." --apply` (audited) |
| Ongoing refresh (read-only token) | `npm run community:registry -- --from-shopify [--apply]` |
| Health | `GET /healthz` → `community: { ready, reason?, environment, products, products_active, variants, variants_active, variants_resolvable, review, pending }` |

**Snapshot rule.** The dated snapshot is bootstrap/recovery material, not
reconciliation. `--snapshot` (dry run or `--apply`) is refused when
`community_products` or `community_variants` already has any row, because a
stale snapshot would overwrite newer webhook/reconcile data. The only override
is `--force-bootstrap`, which requires `--by`, `--reason` and `--apply` and
writes a `force_bootstrap_snapshot` audit row with the before/after counts.
Normal ongoing refresh is always `--from-shopify`.

**Readiness rule.** `/healthz` reports `community.ready: true` only when the
016 tables exist **and** there is at least one active product and at least one
resolvable variant (active variant of an active, non-archived, non-deleted
product that Shopify still marks Community). Tables alone or an empty /
unusable registry → `ready: false`, `reason: registry_empty_or_unusable`, and
the endpoint answers 503.

**Operating rule — new Community product.**
1. Create it in Shopify as **Draft** (Community product type, `asb-community-internal` tag, `ASB-COM-` SKUs).
2. Confirm the registry has it: the `products/create`/`products/update` webhook, or `npm run community:registry -- --from-shopify --apply`.
3. Verify every exact variant id/SKU in the registry (`npm run community:review` registry line; `community_variants`).
4. Only then make the product purchasable.

Re-queue restarts the line's retry budget (attempts → 0); the previous count
and error are kept in the audit row. Every write command is a dry run without `--apply`, needs `--by` and a reason of
at least 10 characters, and writes a `community_audit` row. Deactivation never
touches `community_intake`: pending lines of a deactivated product/variant go
to `review` (`product_deactivated` / `variant_deactivated`), never to grocery.
A product is only deactivatable once Shopify no longer marks it Community; if
Shopify marks it Community again, it is re-activated automatically (audited,
actor `system`). Registry writes lock the product row, so a deactivation and a
concurrent webhook cannot interleave. The inbox picker and inbox orders apply
the same rule as the classifier (Community SKU, registered product or variant,
or the legacy `community-excluded` category all exclude).

### Safety mode

`COMMUNITY_INTAKE_WORKER=off` stops the worker, the post-webhook kick and the
sweeper. Classification and capture are **not** switchable: Community lines
are still diverted and stored, wait in `received`, and appear in
`community:review` once older than `--stuck-min`. Nothing can route them to
grocery. Turning the worker back on processes the backlog.

## 4. Deployment

Rehearse first (section 5). Production, in this order, each step its own
approval:

1. `node scripts/migrate.js --dry` → expect exactly `016_community_intake.sql` outstanding.
2. `node scripts/migrate.js` (additive; `lock_timeout` 5 s — re-run if it times out).
3. `npm run community:registry -- --snapshot db/community/registry-snapshot-2026-10-08.json` (dry), then `--apply`; expect 8 products / 28 variants. (Refused if the registry is not empty — by design.)
4. Set `SHOPIFY_SHOP_DOMAIN=0du4xf-6j.myshopify.com` and `SHOPIFY_API_VERSION=2026-10`, then deploy the code with `COMMUNITY_INTAKE_WORKER=off` (safety mode) for the first hour.
5. Check: boot log `[community] registry: 28 Community variants`; `/healthz` `community.ready: true` with `products_active: 8`, `variants_active: 28`, `variants_resolvable: 14`; one normal grocery order end-to-end; `npm run community:review` clean.
6. Set `COMMUNITY_INTAKE_WORKER=on` (or leave off until Community goes live).

Never deploy the code before step 2: without the tables every Shopify webhook
answers 503, and Shopify only retries for a limited time.

### Rollback

- **Code**: redeploy the previous commit (`2904c91`). The 016 tables are inert
  for old code. Community lines arriving under old code would again reach
  grocery — so only roll back while Community products are Draft.
- **Data**: leave 016 in place (harmless). Dropping it is only safe before any
  real Community order is captured:
  `DROP TABLE community_audit, community_intake, community_variants, community_products;`
  `DROP FUNCTION community_intake_guard(), community_audit_guard(), community_no_truncate(), community_registry_no_delete();`
  `DELETE FROM schema_migrations WHERE filename = '016_community_intake.sql';`

## 5. Rehearsal on a Neon branch (production untouched)

1. Neon console → Branches → create `rehearsal-016` from `production` (copy-on-write; production is not modified).
2. On the branch only: `INSERT INTO app_settings (key, value) VALUES ('asb_environment', 'rehearsal');`
3. Run steps 1–3 of section 4 with `DATABASE_URL` = the branch.
4. Start the branch code locally or as a separate Render service pointing at the branch, with **`WHATSAPP_TOKEN` unset** and its own `SHOPIFY_WEBHOOK_SECRET`.
5. `REHEARSAL_BASE_URL=<that app> DATABASE_URL=<branch> SHOPIFY_WEBHOOK_SECRET=<its secret> npm run community:rehearsal`
   — refuses unless the database **and** the app report `rehearsal` and the app has no WhatsApp token. Sends synthetic grocery-only, Community-only, mixed, unknown-variant, quantity-2 and duplicate orders and checks 19 conditions (incl. an ignored orders/updated).
6. `npm run community:review` against the branch; inspect `/healthz`.
7. Delete the Neon branch.

## 6. Known issues (not fixed in Phase 1)

- **P0 reliability (separate issue):** grocery persistence and the WhatsApp
  bill still run *after* the 200; a crash in between loses the grocery work
  (the payload remains in `webhook_events`, but nothing replays it).
- **Phase-2 BLOCKER:** the same order arriving under a new delivery id is
  merged into itself by `findOpenOrder` — quantities double and a second bill
  is sent (reproduced: 2 → 4). Must be fixed before subscribing to
  `orders/updated` / `orders/edited`. Recorded as a `todo` test in
  `test/community-hardening.test.js`.
- Behaviour change accepted in Phase 1: if the pre-200 capture fails (database
  down), the whole delivery — grocery lines too — gets a 503 instead of being
  processed without a dedupe record.
- Go-live gate: before any Community product becomes Active, configure the
  read-only Shopify token and run `--from-shopify` reconciliation. The
  2026-10-08 snapshot is for bootstrap only.

## 7. Deferred (later phases)

Frozen campaign versions, commitments, commitment events, verification, Rate
Meter, settlement, trust, cancellation/edit handling, storefront gate,
Shopify metaobject projection, inbox review screen, alerting beyond
`/healthz` + `community:review`, `is_test`/`is_internal` columns and backfill,
the cycle-lock audit.
