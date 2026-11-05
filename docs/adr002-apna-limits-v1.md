# ADR-002: Apna Order limits evaluator (nonproduction)

This patch introduces a **pure** per-product cap evaluator and 18 focused tests. There is no database, Shopify, webhook or production wiring. Its purpose is to provide Claude with reviewable working code in the independent Apna development lane.

The founder-approved rule is **no minimum total Apna order value**, but a configurable **maximum quantity per canonical product, household and delivery cycle**. Variants aggregate against the same product; other doors do not consume Apna's limit. Dish-to-Cart may deliver genuine recipe-derived quantities greater than Apna's cap.

## Integration obligations (not implemented in this PR)

1. Server resolves stable household identity, cycle and canonical product (never trust client-provided identifiers or quantity limits).
2. Inside an **atomic Postgres reservation/serialization** per household and cycle, load ALL active orders/reservations, including pending and prior confirmed orders.
3. Run the evaluator on the full proposed order, not just the last added variant.
4. Deny checkout before a COD commitment if it returns violations; reserve capacity before external Shopify calls, with idempotent recovery.
5. Release or update reservations after cancellation or fulfillment amendments.
6. Test simultaneous requests; a pure evaluator alone cannot defeat concurrency.
7. Preserve one customer-facing invoice, and keep feature pricing eligibility separate.

Local tests: `node --test test/apna-limits.test.js`.

**Do not mistake a passing unit test for live checkout enforcement.**
