# ASB production database recovery runbook

Status: **pre-cutover runbook**. Database recovery is a last resort for **data loss or corruption**, not a normal code rollback. Gate A remains separate and requires explicit approval.

## 1. Recovery ladder: code failure vs database failure

Use the least destructive recovery level that solves the incident.

| Level | Use when | Action |
|---|---|---|
| L1 | 017 logic/billing issue but database is healthy | Turn `GROCERY_BILL_SEND` and/or `GROCERY_SOURCE_WORKER` OFF. Durable capture remains. |
| L2 | New 017 release is faulty | Redeploy the previous known-good 017-aware release. |
| L3 | Need old application behaviour while keeping the 017 schema/source ledger | Deploy the approved `rollback-compat-017` build. Never deploy plain `3296c0f` after 017 activation. |
| DB recovery | Confirmed database data loss/corruption that L1-L3 cannot repair | Recover from the T-0 Neon branch / external backup under this runbook. |

**Decision authority:** Waqas Kayani explicitly authorizes any DB restore. The technical operator may recommend it but may not start a restore without that approval.

**Decision window:** after DB recovery review starts, spend at most 15 minutes deciding whether the evidence proves data loss/corruption. If not proven, keep intake/billing paused and continue investigation. There is no automatic restore on timeout.

**Never use DB restore for:** a bad deploy, worker bug, bill bug, webhook parsing bug, or other code issue while the database remains internally consistent.

## 2. Before any production cutover

The following recovery artifacts must exist before Gate A:

1. A fresh T-0 Neon recovery branch from production.
2. An encrypted external `pg_dump` of that recovery point, with SHA-256 and manifest.
3. The exact approved app commit SHA.
4. The exact migration/backfill plan SHA.
5. A documented direct production host and database name.
6. A tested L3 commit.
7. Render auto-deploy disabled.
8. The real production DR rehearsal completed successfully.

The T-0 recovery branch and the encrypted dump are independent recovery paths. Do not rely on PITR alone.

## 3. Immediate incident containment

When a serious incident is detected:

1. Turn bills OFF first if there is any risk of duplicate/wrong customer messages.
2. Turn the 017 worker OFF if application of new sources may worsen the incident.
3. Keep durable Shopify capture available if the database itself is healthy.
4. Record:
   - incident UTC start;
   - last known-good timestamp;
   - current app commit;
   - current migration list;
   - current worker/bill switch states;
   - Shopify order-id high-water mark;
   - database sequence high-water marks.
5. If DB corruption is suspected, stop all mutation paths before taking forensic snapshots.

Do not delete rows, truncate tables, reset sequences, or "undo" schema migrations.

## 4. When database recovery is justified

DB recovery requires evidence of at least one of:

- committed rows were lost;
- rows were corrupted in a way that cannot be repaired safely forward;
- a destructive database operation changed historical truth;
- the live database can no longer satisfy critical referential/business invariants and the corruption predates the current incident response.

Before restore, record why L1, L2 and L3 are insufficient.

## 5. Preserve the abandoned timeline

A Neon restore/branch switch can leave the pre-restore state in an abandoned-timeline branch, for example `production_old_<timestamp>`.

That branch is **evidence**. It may contain orders, customer messages, packing edits, cancellations and bill proof created after the recovery point.

Rules:

- record its branch ID/name immediately;
- prevent/manual-protect it from accidental deletion where the plan allows;
- do not run workers, bills, staging apps or destructive SQL against it;
- do not delete it until post-recovery reconciliation is complete and separately approved;
- treat it as sensitive production data.

If the provider's restore mechanism does not automatically preserve the old timeline, create an explicit branch/snapshot of the live state before any destructive restore.

## 6. Define the recovery point and the abandoned interval

Let:

- **T0** = timestamp/LSN of the recovery point restored into production;
- **T1** = timestamp intake was paused or the restore began.

The interval **[T0, T1]** is the abandoned interval.

Everything created or changed in that interval must be reconciled before normal operations resume.

Build a manifest containing, at minimum:

- Shopify order IDs created in [T0,T1];
- webhook event IDs;
- ASB order IDs/order numbers;
- source IDs and states;
- WhatsApp message IDs/idempotency keys/status;
- bill attempt IDs/outcomes/wamids;
- non-Shopify orders;
- cancellations/packing edits/customer changes;
- every public sequence's high-water value.

The manifest must be generated read-only from the abandoned timeline and stored securely.

## 7. Shopify orders after T0

Shopify remains the external order ledger for Shopify-origin orders.

For every Shopify order created after T0:

1. Identify the Shopify order ID from Shopify / abandoned-timeline evidence.
2. Check whether the recovered production database already has a `shopify_order_sources` row for that Shopify order.
3. Check **bill evidence in the abandoned timeline before any replay**:
   - sent/delivered/read message evidence;
   - accepted Meta `wamid`;
   - bill-attempt proof/outcome;
   - frozen snapshot / authorization evidence.
4. If a customer already received/was accepted for a confirmation, preserve that fact so the recovered timeline cannot send it again.
5. Only then re-ingest the Shopify order through the normal 017 source-capture path.
6. Verify exactly one source exists and exactly one ASB order disposition is produced.

**No blind replay.** Shopify re-ingestion is not authorized until the abandoned-timeline bill-evidence reconciliation procedure has been tested on an isolated restore.

If evidence is ambiguous, place the order in human review; do not auto-resend.

## 8. Non-Shopify and ASB-only changes after T0

The following may exist only in the abandoned timeline and cannot be recreated from Shopify alone:

- WhatsApp/inbox/field/phone/walk-in orders;
- customer messages;
- packing quantities/edits;
- substitutions/unavailable flags;
- cancellations and reasons;
- customer address/profile changes;
- operator holds/releases/authorizations;
- manual payment/bill-state changes.

For each category, produce a read-only difference list between recovered production and abandoned timeline.

Each difference must be classified:

- **copy forward** — safe deterministic state that must be restored;
- **manual re-entry** — business action needs a human;
- **ignore with reason** — explicitly obsolete/duplicated state;
- **review** — conflicting or ambiguous.

No bulk forward-copy SQL is executed until its dry-run plan and affected rows are reviewed and explicitly approved.

## 9. Sequence collision prevention

A restore rewinds sequence state to T0. The abandoned timeline may contain customer-visible numbers issued after T0.

Before reopening any intake, compare **every public sequence** in recovered production with the abandoned timeline.

At minimum this includes:

- serial/identity backing sequences;
- `asb_order_seq`;
- `asb_bill_seq`;
- any later 017-020 sequences.

For each sequence, compute the abandoned high-water value and ensure the recovered sequence's next allocation is strictly greater.

Read-only discovery should include:

```sql
SELECT n.nspname AS schema_name, c.relname AS sequence_name
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public' AND c.relkind = 'S'
 ORDER BY c.relname;
```

Do **not** reopen intake merely because `max(id)` looks safe. Custom customer-visible sequences such as `asb_order_seq` and `asb_bill_seq` must be checked directly.

Any sequence-advance operation is a production mutation and requires an explicit reviewed plan.

## 10. Bill and message reconciliation

Before bills are enabled after recovery:

- every post-T0 Shopify order must have abandoned-timeline bill evidence classified;
- every ambiguous send remains `unknown`/review;
- accepted/sent/delivered/read evidence must prevent re-send;
- receipt evidence must be preserved monotonically;
- customer-visible order/bill numbers must not collide.

Bills stay OFF until this reconciliation is complete.

## 11. Customer communication

Assign one owner for customer communication during a DB recovery.

Communicate only after the recovered state is known.

Possible cases:

- **No customer-visible difference:** no proactive message needed.
- **Order restored with same contents/amount:** confirm only if operationally useful; never duplicate a bill just to "confirm recovery".
- **Order contents/status changed:** contact the customer before fulfillment.
- **Bill amount changed:** explain the correction and provide the final authoritative bill.
- **Previously accepted bill cannot be proven:** human review before resend.
- **Order cannot be reconstructed:** apologize, explain that the order needs reconfirmation, and do not guess.

Keep a list of every customer contacted and why.

## 12. Recovery execution gates

### Gate R1 — authorize restore

Required:

- Waqas approval;
- evidence of data loss/corruption;
- T0 recovery artifact identified;
- abandoned timeline preservation plan;
- bills/worker mutation risks contained.

### Gate R2 — restored database validation

Before pointing production traffic at the recovered database:

- structural/data restore invariants pass;
- migration ledger matches the intended T0 state;
- app build is compatible with the restored schema;
- environment/owner differences are understood;
- no rehearsal marker is present in production.

### Gate R3 — abandoned-interval reconciliation

Before normal operations:

- Shopify [T0,T1] inventory complete;
- bill evidence classified;
- non-Shopify difference list resolved;
- sequence high-water plan applied/verified;
- no duplicate source/order/bill condition detected.

### Gate R4 — reopen

Order:

1. application healthy with worker OFF and bills OFF;
2. Shopify durable capture confirmed;
3. worker ON under supervision;
4. verify first recovered/replayed orders;
5. bills ON only after bill-evidence checks;
6. customer communication cases completed.

## 13. Abort conditions

Stop recovery and do not reopen intake if any of the following appears:

- unexpected migration drift;
- source/order duplicate anomaly;
- unclassified bill evidence;
- sequence next value at or below abandoned high-water;
- missing non-Shopify records with no reviewed disposition;
- recovered database contains `asb_environment='rehearsal'`;
- app points to the wrong database host/name;
- any tool reports `REFUSED`;
- production and abandoned-timeline identities are uncertain.

## 14. Retention and closure

Keep the abandoned timeline until:

- all [T0,T1] rows are reconciled;
- bills are stable;
- customer disputes from the incident window are resolved;
- Waqas explicitly approves deletion.

Keep the encrypted pre-cutover dump according to the approved retention policy. Keep the non-secret manifest and incident report longer.

The closure report records:

- incident cause;
- T0/T1;
- recovery path used;
- exact commit/migration SHAs;
- affected orders/customers;
- sequence adjustments;
- bill/message reconciliation;
- abandoned branch deletion approval;
- follow-up engineering actions.

## 15. What is not yet automated

This runbook deliberately does **not** pretend the following are already implemented:

- automatic forward-copy from `production_old_*`;
- automatic Shopify post-T0 replay with abandoned-timeline bill evidence;
- automatic non-Shopify merge;
- automatic sequence advancement.

Those procedures must be rehearsed on isolated copies before they are ever used on production.
