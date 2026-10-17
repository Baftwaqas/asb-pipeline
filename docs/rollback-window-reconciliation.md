# Rollback-window reconciliation (migration 017)

Use this only **after** the 017-aware release has returned following an L3 `rollback-compat-017` window.

It does not rerun the initial 017 backfill. The initial backfill marker must already exist.

## Safety model

- Give the exact rollback interval as `--from` and `--to` (UTC/ISO timestamps; `to` is exclusive).
- A window cannot exceed 72 hours; split longer incidents into reviewed segments.
- Dry-run first. The output contains no customer payloads, only order/event ids, states, counts and hashes.
- Approve the exact `plan_sha256`.
- Apply requires that hash plus `--by` and `--reason`.
- Apply recomputes the plan under an advisory lock and aborts if anything changed.
- A concurrent 017 source reservation also makes the apply abort.
- Ambiguous rows are `review` and are never automatically changed.

## Dry run

```
node scripts/grocery-rollback-reconcile.js --shop 0du4xf-6j.myshopify.com --from <ISO> --to <ISO>
```

## Apply an approved plan

```
node scripts/grocery-rollback-reconcile.js --shop 0du4xf-6j.myshopify.com --from <ISO> --to <ISO> --apply --plan-sha <approved hash> --by "Waqas" --reason "L3 rollback window recovery"
```

## Classifications

- `replay`: failed/unfinished event with no source, no order and no bill evidence. It is inserted as a legacy failed/unfinished source and immediately reopened to `received/not_ready`; the normal 017 worker owns all later application and billing.
- `link_existing`: an ASB order already exists. A legacy source is linked to it and is never replayed.
- `map_community_only`: a processed event whose every Shopify line already exists in durable `community_intake`. It becomes `community_only/not_required`.
- `review`: conflicting payloads, unexplained processed events, or bill evidence without a source/order. No automatic write.

The append-only `shopify_order_source_audit` records the run and every source write. Existing audit actions `backfill_run`, `backfill_row` and `reopen_legacy` are reused with `detail.mode='rollback_window_reconcile'`; therefore this recovery tool requires no extra schema migration.
