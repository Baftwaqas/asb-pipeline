# ASB Grocery Reliability 017 — Stage B one-order billing gate

**State:** development-only candidate. **Do not deploy or activate in production
without a separate explicit approval.**

## Purpose

The grocery send switch is global. A newly arriving customer's Shopify order
could otherwise become eligible while an operator enables billing to test
Shopify order **#1037**. The extra gate limits every grocery bill claim to the
specific immutable production source and Shopify order identity.

This is not a database migration and does not send any WhatsApp message by
itself. It does not modify historical bills or alerts.

## Configuration and fail-closed rules

The original gates remain mandatory: `GROCERY_BILL_SEND=on` and audited
`grocery_bill_send_activation` in `app_settings`. Additionally, configure:

| Variable | Safe default | Approved-test candidate |
| --- | --- | --- |
| `GROCERY_BILL_SEND_SCOPE` | `off` (also missing) | `single` |
| `GROCERY_BILL_TARGET_SOURCE_ID` | unset | `25` |
| `GROCERY_BILL_TARGET_SHOPIFY_ORDER_ID` | unset | `7581509419266` |

- `off`, missing, whitespace, unknown mode, missing/invalid/overflowing
  target identity **deny billing**.
- `single` requires both exact canonical positive IDs; a source must have
  `origin='live'` and match **both** IDs.
- `all` is available for a separately approved *future* full rollout, but
  only when **both target variables are unset**. Never set it for Stage B.
- Enforce this at the global switch, in the worker's candidate query, and
  **inside the transaction holding the source row lock** before creating the
  send attempt. This covers the sweeper, webhook kick and direct processBill.
- The existing audited bill hold still blocks the test order regardless of
  scope settings.

`/healthz` exposes the nonsecret status fields `bill_scope_mode` and
`bill_scope_valid`. `bills_enabled` now requires all three authorizations.

## Safe preparatory checks

Before any later production changes, verify independently:

1. Production is still at the documented 017 commit with
   `GROCERY_BILL_SEND=off`, `GROCERY_SOURCE_WORKER=on`, and
   `COMMUNITY_INTAKE_WORKER=off`.
2. Shopify order #1037 remains tagged `ASB-TEST` and
   `ASB-TEST-GROCERY-017`, clearly marked **DO NOT FULFILL OR DISPATCH**.
3. Production Neon source #25 still has exactly one immutable snapshot, zero
   WhatsApp bill attempts, `bill_state='pending'`, and an audited active hold.
4. Recheck whether snapshot is beyond the six-hour automatic age limit.
   **Do not disable the limit to force delivery.** If stale, require a distinct
   operator-approved audited age reconciliation / authorized send design.
5. Confirm the specific test WhatsApp number is under the user's control,
   approved `asb_order_bill_v2` Urdu template exists, and no other
   sending path or notification will be triggered.
6. Confirm CI tests run against a disposable local PostgreSQL database and
   fake outbound clients; no production tokens or database are used.

## Proposed later cutover (not authorized by this document)

- **Separate approval 1:** Review and deploy the gate code with billing OFF and
  scope OFF. Verify deployed commit, status endpoint and source hold.
- Configure only the `single` scope and the two exact target IDs, with
  `GROCERY_BILL_SEND` still OFF. Verify fail-closed behaviour.
- **Separate approval 2:** Authorize exactly one genuine WhatsApp test bill.
  Take pre-send snapshots of source state and other eligible customer bills.
  Resolve the six-hour limit safely if applicable.
- Arm the existing global send switch and explicitly release #1037's audited
  hold in a narrowly controlled window. Watch message acceptance and the
  independent `sent` / `delivered` / `read` receipt chain, including Meta
  failure receipts. Meta API acceptance alone is not proof of delivery.
- Immediately restore `GROCERY_BILL_SEND=off`. Avoid repeating a send if its
  outcome is unknown. Do not delete historical 131042 failure alerts or
  unrelated unmatched WhatsApp receipts.
- **Rollback:** global `GROCERY_BILL_SEND=off` is the first stop, then hold
  any still-pending test bill (audited). Do not roll database migrations back.

## Development verification

- `node --test test/bill-send-scope.test.js` (pure offline gate tests).
- `npm test` against the temporary PostgreSQL 18 CI service:
  `test/bill-send-gate-integration.test.js` exercises a real temporary database,
  fake Shopify webhooks and stubbed WhatsApp calls. It checks missing scope,
  wrong-order identity, audited hold, one permitted send, blocked direct calls,
  newly arriving orders, duplicate prevention and global OFF.
- Changes must remain on branch
  `grocery-017-stage-b-single-order-gate` until reviewed. Neither a GitHub
  branch nor a draft PR authorizes a production merge or Render deployment.
