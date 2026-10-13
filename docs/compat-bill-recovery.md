# Compat bill recovery after an L3 rollback

This tool handles the second half of rollback-window recovery: L3 successfully
saved the grocery order, but its customer confirmation needs to be reconciled
after the 017-aware release returns.

It is intentionally conservative.

## Automatic classifications

- **record_sent_evidence**: the old WhatsApp log is `sent`, `delivered` or
  `read`. The compat source stays `legacy/legacy`; the tool records durable
  bill evidence and never sends again.
- **recover_bill**: there is positive evidence that no message was accepted:
  an old failed log contains a Meta error response with no wamid, or L3
  explicitly stopped before send because no DB-composed bill was available.
  The tool composes a frozen 017 snapshot and moves the linked compat source to
  `applied/pending` under an audited operator authorization. The normal 017
  billing engine owns the subsequent send.
- **review**: network ambiguity, missing outbound log, or a failed delivery that
  already has a wamid. Nothing is sent automatically.

## Database guard

Migration `020_compat_bill_recovery.sql` adds one narrow transition:
`compat_inline legacy/legacy -> applied/pending`.

The transition is rejected unless the source is already linked to an order,
customer and cycle and a same-source append-only `bill_compose` audit row with
`detail.mode = compat_bill_recovery` is supplied as the billing authorization.
The existing deferred snapshot constraint still requires the frozen bill at
COMMIT.

## Dry run

```
node scripts/grocery-compat-bill-reconcile.js --shop 0du4xf-6j.myshopify.com --from <ISO> --to <ISO>
```

## Apply approved safe classifications

```
node scripts/grocery-compat-bill-reconcile.js --shop 0du4xf-6j.myshopify.com --from <ISO> --to <ISO> --apply --plan-sha <hash> --by "Waqas" --reason "L3 bill recovery"
```

Review rows remain untouched. A human must inspect the customer chat / Meta
evidence before any later manual resend decision.
