# Neon rehearsal for migration 017: command sheet

**Status: for review. Not started.** No Neon branch exists yet.

- **Steps that need Waqas's explicit approval at the time:** 1 (create branch), 6 (backfill apply) and 15 (delete branch).
- **Code under test:** commit `b795d847838d3d370a4e235b93caeb04ae010a9b` on branch `grocery-reliability-017`. Its tree is `7ba7b24f`, and it passed 109/109 tests.
- **Where it runs:** Waqas's Windows PC, in PowerShell. Only three things are involved:
  - one throwaway Neon branch called `asb-rehearsal-017`;
  - a local fake Graph on `127.0.0.1:4599`;
  - a local staging app on `127.0.0.1:3017`.

## Hard rules for the whole sheet

1. **Use only the `asb-rehearsal-017` connection string.**
   - The production connection string is never pasted into any window used here.
   - Every window that holds `DATABASE_URL` runs `Check-RehearsalDb` before its first write.
   - The check must print `asb_environment: 'rehearsal'` and the rehearsal endpoint host.
2. **Keep push off.** `PUSH_DISABLED=1` is set on the app. The branch is also marked `asb_environment=rehearsal`, which suppresses every push by itself as well.
3. **Keep Meta calls local.**
   - `GRAPH_BASE=http://127.0.0.1:4599/v25.0`. It is never `graph.facebook.com`.
   - `WHATSAPP_TOKEN` is the dummy value `fake-token`.
   - There is no Shopify Admin token and no VAPID env.
4. **Keep secrets out of chat.** Never paste a connection string, password or secret into chat. Output marked "safe to share" contains only booleans, counts, ids and hashes.
5. **Stop on any surprise.** If a step prints something other than its "Expected" line, stop and share the output.

## Windows used

| Window | Purpose | Holds `DATABASE_URL`? |
|---|---|---|
| **A** | operator: migrate, backfill, activate, rehearse, review | yes (rehearsal branch) |
| **B** | fake Graph | **no** |
| **C** | staging app | yes (rehearsal branch) |

### Code folder

Download the exact reviewed commit:

```
https://github.com/Baftwaqas/asb-pipeline/archive/b795d847838d3d370a4e235b93caeb04ae010a9b.zip
```

Extract it to `C:\Users\waqas\asb-rehearsal-017\`, which gives the folder `asb-pipeline-b795d847838d3d370a4e235b93caeb04ae010a9b`. Then, in window A:

```powershell
cd $HOME\asb-rehearsal-017\asb-pipeline-b795d847838d3d370a4e235b93caeb04ae010a9b
node -v      # Expected: v22.x or newer (lossless Shopify ids need it)
npm ci
# No real secrets may be present in this window. This prints NAMES only. Expected: nothing.
Get-ChildItem Env: | Where-Object Name -match 'DATABASE|WHATSAPP|SHOPIFY|VAPID|GRAPH|META|PUSH|GROCERY|COMMUNITY|INBOX' | Select-Object Name
```

### Define `Check-RehearsalDb` (windows A and C)

Paste this into **each** of windows A and C after setting `DATABASE_URL`. It is read-only.

```powershell
function Check-RehearsalDb {
  node -e 'const db=require(`./db`);db.query(`SELECT current_database() AS db, (SELECT value FROM app_settings WHERE key=$$asb_environment$$) AS asb_environment, to_regclass($$public.shopify_order_sources$$) IS NOT NULL AS has_017`).then(r=>{console.log(r.rows[0]);return db.shutdown()})'
}
```

It prints:

- `[db] pool ready (host ep-…)`: this host must be the **rehearsal** endpoint from step 1;
- `{ db: 'neondb', asb_environment: 'rehearsal', has_017: … }`.

**Stop** if the host is production's endpoint or `asb_environment` is not `'rehearsal'`.

---

## 1. Create the Neon branch — NEEDS APPROVAL

In the Neon console, project `old-surf-30168106`:

1. Open **Branches** and choose **Create branch**.
2. Name: `asb-rehearsal-017`.
3. Parent: `production` (`br-crimson-leaf-aum7i4bs`). Data: **current point in time (head)**.
4. Create it.
5. Note the new branch's compute endpoint id (`ep-…`). It differs from production's endpoint.
6. On `asb-rehearsal-017`, open **Connect**:
   - database `neondb`;
   - **untick "Connection pooling"**, so you get the direct connection (the advisory lock and the single-transaction backfill need it);
   - copy the string, which is used only in windows A and C.

Expected: a branch `asb-rehearsal-017` whose endpoint id is not production's.

## 2. Mark the branch `asb_environment=rehearsal`

Use the Neon **SQL Editor**. **First set the branch selector to `asb-rehearsal-017`.**

```sql
INSERT INTO app_settings (key, value) VALUES ('asb_environment', 'rehearsal')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now();

SELECT key, value FROM app_settings WHERE key = 'asb_environment';
```

Expected: exactly one row, `asb_environment | rehearsal`.

Then, in window A:

```powershell
$env:DATABASE_URL = "<asb-rehearsal-017 DIRECT connection string - typed/pasted in your own window only>"
Check-RehearsalDb
```

Expected: the rehearsal host, `asb_environment: 'rehearsal'` and `has_017: false`.

## 3. Migration 017: dry run, then apply (window A)

```powershell
Check-RehearsalDb
node scripts/migrate.js --dry
```

Expected: the only pending file is `017_shopify_order_sources.sql`. Stop if any other file is listed.

```powershell
node scripts/migrate.js
Check-RehearsalDb
```

Expected: the migration is applied, and the check now shows `has_017: true`.

## 4. Backfill dry run (window A, read-only)

```powershell
Check-RehearsalDb
node scripts/grocery-backfill.js --shop 0du4xf-6j.myshopify.com > backfill-plan.json
Get-Content backfill-plan.json | Select-String -Pattern '"counts"' -Context 0,20
Get-Content backfill-plan.json | Select-String -Pattern 'unusable_event_ids|"marker"'
Select-String -Path backfill-plan.json -Pattern 'plan_sha256'
```

**Safe to share:** the `counts` block, `unusable_event_ids`, `marker` (expected `null`), the `plan_sha256` and the row count.

`backfill-plan.json` itself stays on the PC; it lists order ids.

## 5. Approve the exact `plan_sha256`

1. Waqas shares the step 4 summary in chat.
2. Claude and ChatGPT review the counts:
   - every pre-017 order maps to `legacy` with a reason;
   - nothing unexpected appears in `unusable_event_ids`.
3. Waqas writes the approval in chat: **"approved plan_sha256 `<hash>`"**.

The apply in step 6 refuses unless the plan computed at that moment has exactly this hash. If anything changed in between, it refuses, and we go back to step 4.

## 6. Backfill apply — NEEDS APPROVAL (window A)

```powershell
Check-RehearsalDb
node scripts/grocery-backfill.js --shop 0du4xf-6j.myshopify.com --apply --plan-sha <approved plan_sha256> --by "Waqas" --reason "Neon rehearsal 017 backfill"
```

Expected: JSON with the inserted and upgraded counts and the marker written. A `[backfill] REFUSED: …` means nothing was written.

The apply runs in one transaction, under an advisory lock, and writes the marker last.

## 7. Start the fake Graph (window B: no `DATABASE_URL`)

```powershell
cd $HOME\asb-rehearsal-017\asb-pipeline-b795d847838d3d370a4e235b93caeb04ae010a9b
$env:FAKE_GRAPH_PORT = "4599"
$env:FAKE_GRAPH_MODE = "accept"
node scripts/fake-graph.js
```

Expected: `[fake-graph] listening on http://127.0.0.1:4599 (mode accept)`. Leave it running; every WhatsApp call the app makes is printed here.

## 8. Staging app environment, then start (window C)

Open a **fresh** PowerShell window.

```powershell
cd $HOME\asb-rehearsal-017\asb-pipeline-b795d847838d3d370a4e235b93caeb04ae010a9b
Get-ChildItem Env: | Where-Object Name -match 'DATABASE|WHATSAPP|SHOPIFY|VAPID|GRAPH|META|PUSH|GROCERY|COMMUNITY|INBOX' | Select-Object Name   # Expected: nothing

$env:DATABASE_URL            = "<asb-rehearsal-017 DIRECT connection string>"
# paste the Check-RehearsalDb function here, then:
Check-RehearsalDb            # Expected: rehearsal host, asb_environment 'rehearsal', has_017 true

$env:PORT                    = "3017"
$env:GRAPH_BASE              = "http://127.0.0.1:4599/v25.0"   # LOCAL fake Graph - never graph.facebook.com
$env:WHATSAPP_TOKEN          = "fake-token"
$env:PHONE_NUMBER_ID         = "000000"
$env:META_APP_SECRET         = "rehearsal-meta-secret"
$env:SHOPIFY_WEBHOOK_SECRET  = "rehearsal-shopify-secret"
$env:SHOPIFY_SHOP_DOMAIN     = "0du4xf-6j.myshopify.com"
$env:INBOX_PASSWORD          = "rehearsal-inbox"
$env:INBOX_COOKIE_SECRET     = "rehearsal-cookie"
$env:PUSH_DISABLED           = "1"
$env:COMMUNITY_INTAKE_WORKER = "on"
$env:GROCERY_SOURCE_WORKER   = "on"
$env:GROCERY_BILL_SEND       = "on"
$env:GROCERY_ALERT_PUSH      = "on"
node server.js
```

Expected: the server listens on port 3017.

If Windows Firewall asks about Node, choose **Cancel**: the app is used only from this PC.

Until steps 9–10 are recorded, the worker and bills stay off, because each also needs its activation in the database.

## 9. Worker activation (window A)

```powershell
Check-RehearsalDb
node scripts/grocery-activate.js --worker --by "Waqas" --reason "Neon rehearsal 017" --apply
```

Expected: the activation is recorded. It refuses if the backfill marker is missing.

## 10. Bill activation (window A)

```powershell
node scripts/grocery-activate.js --bills --by "Waqas" --reason "Neon rehearsal 017" --apply
node scripts/grocery-activate.js --status
```

Expected: the bill activation is recorded, and `--status` shows both activations plus the backfill marker.

## 11. Health checks (window A)

```powershell
$h = Invoke-RestMethod http://127.0.0.1:3017/healthz
$h | ConvertTo-Json -Depth 6          # safe to share: booleans and counts only
$h.community.environment, $h.community.ready, $h.config.graphHost,
$h.grocery.available, $h.grocery.worker_enabled, $h.grocery.bills_enabled, $h.grocery.alert_push, $h.grocery.push_suppressed
```

Expected, in order:

| Value | Expected |
|---|---|
| `community.environment` | `rehearsal` |
| `community.ready` | `True` |
| `config.graphHost` | `127.0.0.1` |
| `grocery.available` | `True` |
| `grocery.worker_enabled` | `True` |
| `grocery.bills_enabled` | `True` |
| `grocery.alert_push` | `True` |
| `grocery.push_suppressed` | `PUSH_DISABLED` or `rehearsal_environment` |

**Stop if any value differs.** The rehearsal guard in step 12 enforces the same conditions, plus the database marker, and refuses otherwise.

## 12. `community:rehearsal` (window A)

```powershell
Check-RehearsalDb
$env:REHEARSAL_BASE_URL     = "http://127.0.0.1:3017"
$env:SHOPIFY_WEBHOOK_SECRET = "rehearsal-shopify-secret"
$env:SHOPIFY_SHOP_DOMAIN    = "0du4xf-6j.myshopify.com"
npm run community:rehearsal
```

Expected: `N/N checks passed` and exit code 0.

The checks are:

- A–H: Community intake and grocery separation;
- I: the same order with a new delivery ID is ignored and not doubled;
- J: changed content is ignored as a MISMATCH, raising a duplicate anomaly;
- K: source A is applied once, and source B is Community-only with no bill.

A guard refusal prints `REFUSED: …` and exits with code 3.

Window B must show the bill sends for the rehearsal orders, which are named `#REH-<run>-…` and use synthetic phones.

## 13. Grocery review and operator tests (rehearsal rows only)

Operator actions are run **only** on sources whose `shopify_order_name` starts with `#REH-`. Those were created by the rehearsal, so no real customer row is touched.

### 13a. Make two bills `unknown`

1. **Window B:** press Ctrl+C, then:
   ```powershell
   $env:FAKE_GRAPH_MODE = "timeout_first"
   node scripts/fake-graph.js
   ```
2. **Window A:** run `npm run community:rehearsal` again. Then wait about 60 seconds: the app gives up on an unanswered send after 20 seconds and records it as ambiguous, so the bill becomes `unknown`.

### 13b. Find the targets (SQL Editor, branch `asb-rehearsal-017`)

```sql
SELECT s.id AS source_id, s.shopify_order_name, s.status, s.bill_state, s.bill_hold_reason,
       a.id AS attempt_id, a.outcome, a.wamid, sn.phone
  FROM shopify_order_sources s
  LEFT JOIN shopify_order_bill_attempts a ON a.id = s.bill_current_attempt_id
  LEFT JOIN shopify_order_bill_snapshots sn ON sn.source_id = s.id
 WHERE s.shopify_order_name LIKE '#REH-%'
 ORDER BY s.id DESC;
```

From the newest run, take **X** and **Y**: two sources with `bill_state = 'unknown'` (orders `…-A` and `…-C`).

### 13c. The list (window A)

```powershell
npm run grocery:review
```

Expected: X and Y are listed as needing attention.

### 13d. Hold, release, resend on source X

```powershell
node scripts/grocery-review.js --action bill-hold    --source <X> --by "Waqas" --reason "rehearsal hold test"
node scripts/grocery-review.js --action bill-hold    --source <X> --by "Waqas" --reason "rehearsal hold test" --apply
node scripts/grocery-review.js --action bill-release --source <X> --by "Waqas" --reason "rehearsal release test" --apply
node scripts/grocery-review.js --action bill-resend  --source <X> --by "Waqas" --reason "rehearsal resend test" --apply
```

Expected:

- the first command is a dry run only;
- hold gives `held: true`, and release gives `held: false`;
- after the resend, at the next sweep (within about a minute), window B shows a second send to X's phone, which is accepted;
- the step 13b query shows X as `sent`.

### 13e. Link a receipt to Y's ambiguous attempt

First, post a signed synthetic delivery receipt to the **local** app. Use Y's `phone` from step 13b.

```powershell
$wamid = "wamid.REHEARSAL-LINK-<Y attempt_id>"
$ts    = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
$body  = '{"object":"whatsapp_business_account","entry":[{"id":"0","changes":[{"field":"messages","value":{"messaging_product":"whatsapp","metadata":{"phone_number_id":"000000"},"statuses":[{"id":"' + $wamid + '","status":"delivered","timestamp":"' + $ts + '","recipient_id":"<Y phone>"}]}}]}]}'
$hmac  = New-Object System.Security.Cryptography.HMACSHA256 (,[Text.Encoding]::UTF8.GetBytes("rehearsal-meta-secret"))
$sig   = "sha256=" + (($hmac.ComputeHash([Text.Encoding]::UTF8.GetBytes($body)) | ForEach-Object { $_.ToString("x2") }) -join "")
(Invoke-WebRequest -UseBasicParsing -Method Post -Uri http://127.0.0.1:3017/webhooks/whatsapp -ContentType "application/json" -Headers @{ "X-Hub-Signature-256" = $sig } -Body $body).StatusCode
```

Expected: `200`. The receipt is journalled, but nothing is linked automatically.

Then link it:

```powershell
node scripts/grocery-review.js --action link-receipt --attempt <Y attempt_id> --wamid $wamid --by "Waqas" --reason "rehearsal link-receipt test" --apply
```

Expected: Y's bill becomes `sent`, and the attempt's proof is recorded. Re-running the same command must refuse, because the attempt already has a wamid.

### 13f. Acknowledge the step 12 anomaly

```sql
SELECT id, source_id, fingerprint_differs, acknowledged_at FROM shopify_order_source_duplicates
 WHERE fingerprint_differs AND acknowledged_at IS NULL ORDER BY id DESC;
```

```powershell
node scripts/grocery-review.js --action anomaly-ack --duplicate <id> --by "Waqas" --reason "rehearsal anomaly-ack test" --apply
```

Expected: the duplicate is acknowledged, and `/healthz` `grocery.open_anomalies` goes down by one.

### 13g. Back to normal mode

**Window B:** Ctrl+C, then `$env:FAKE_GRAPH_MODE = "accept"; node scripts/fake-graph.js`.

## 14. Final read-only verification (SQL Editor, branch `asb-rehearsal-017`)

```sql
-- a. Source states. Backfilled rows are legacy. Rehearsal rows are applied or community_only, and their bills are sent or not_required.
SELECT origin, status, bill_state, count(*) FROM shopify_order_sources GROUP BY 1,2,3 ORDER BY 1,2,3;

-- b. Every bill attempt went to the fake Graph or is the synthetic linked receipt. Expected: other_wamid = 0.
SELECT channel, outcome, proof, count(*) AS n,
       count(*) FILTER (WHERE wamid LIKE 'wamid.FAKE%')           AS fake,
       count(*) FILTER (WHERE wamid LIKE 'wamid.REHEARSAL-LINK-%') AS synthetic_link,
       count(*) FILTER (WHERE wamid IS NOT NULL AND wamid NOT LIKE 'wamid.FAKE%'
                          AND wamid NOT LIKE 'wamid.REHEARSAL-LINK-%') AS other_wamid
  FROM shopify_order_bill_attempts GROUP BY 1,2,3 ORDER BY 1,2,3;

-- c. Every bill attempt belongs to a rehearsal order. Expected: 0.
SELECT count(*) FROM shopify_order_bill_attempts a JOIN shopify_order_sources s ON s.id = a.source_id
 WHERE s.shopify_order_name NOT LIKE '#REH-%';

-- d. No alert was pushed. Expected: sent = 0.
SELECT kind, state, count(*) FROM grocery_alerts GROUP BY 1,2 ORDER BY 1,2;
SELECT count(*) AS sent FROM grocery_alerts WHERE state = 'sent';

-- e. No outbound message from the rehearsal window carries a real Meta id. Expected: 0.
SELECT count(*) FROM whatsapp_messages
 WHERE direction = 'outbound'
   AND created_at >= (SELECT min(created_at) FROM shopify_order_sources WHERE shopify_order_name LIKE '#REH-%') - interval '5 minutes'
   AND wamid IS NOT NULL AND wamid NOT LIKE 'wamid.FAKE%' AND wamid NOT LIKE 'wamid.REHEARSAL-LINK-%';

-- f. Duplicates from I and J.
SELECT fingerprint_differs, raw_differs, (acknowledged_at IS NOT NULL) AS acked, count(*)
  FROM shopify_order_source_duplicates GROUP BY 1,2,3;

-- g. The audit trail covers the backfill, the activations and every operator action.
SELECT action, count(*) FROM shopify_order_source_audit GROUP BY 1 ORDER BY 1;
```

All of these outputs are counts and are safe to share.

## 15. Delete the Neon branch — NEEDS APPROVAL

1. Press Ctrl+C in windows C and B, then close windows A, B and C. This discards every env var.
2. Delete `backfill-plan.json` from the code folder. It lists order ids.
3. In the Neon console, open **Branches**, then `asb-rehearsal-017`, then **Delete**. Confirm the name before confirming.
4. Expected: only the pre-existing branches remain, and `production` (`br-crimson-leaf-aum7i4bs`) is unchanged.

**Optional check, read-only, in the console only:** in the SQL Editor with the branch selector on `production`, run:

```sql
SELECT to_regclass('public.shopify_order_sources');
```

It must return `NULL`, meaning 017 was never applied to production.
