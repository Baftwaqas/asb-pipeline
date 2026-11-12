# ASB Checkout Lab — private database backup (Windows)

**Run on your own Windows computer.** This is a backup procedure, NOT a migration or Shopify order edit.

## Why
- Database: Render Free Postgres 18, asb-checkout-lab-pg18, instance dpg-dbm8v3qjnfac738pc31g-a.
- Render Free has no managed backup / PITR. The lab DB expires December 5, 2026.
- Synthetic order #1002 remains Rs 45 pending COD.
- **Never release held migrations 029/030 until a private recoverable backup is verified.**
- The script does NOT encrypt the dump. Choose an encrypted drive/folder and keep the archive outside GitHub, Desktop, Downloads or shared cloud locations.

## What you need
1. Windows PowerShell 5.1+.
2. PostgreSQL 18 client programs: psql.exe, pg_dump.exe and pg_restore.exe (normally under C:\Program Files\PostgreSQL\18\bin).
3. Docker Desktop running, for recommended restore verification.
4. An encrypted private backup destination.
5. Your own Render lab database password, entered only into a hidden prompt in the script. **Never send it in chat.**
6. Render database dashboard: https://dashboard.render.com/d/dpg-dbm8v3qjnfac738pc31g-a

## Before running
Go to Render dashboard → the lab database → Networking / Access Control. Temporarily allowlist **your current public IP address ONLY** (a /32 rule). Never permit 0.0.0.0/0 or share the external database URL.

Expected external hostname: dpg-dbm8v3qjnfac738pc31g-a.singapore-postgres.render.com. If Render displays another hostname, STOP and verify identity instead of weakening this guard.

## Run the script
Open PowerShell inside your local cloned Baftwaqas/asb-pipeline repository, and replace the sample encrypted drive with your real private encrypted folder:

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File ".\ops\windows\Backup-ASBCheckoutLab.ps1" -BackupDirectory "E:\ASB_Private_Encrypted_Backups" -RunRestoreTest
~~~

The script securely prompts for your database password, verifies the exact lab database and source checkout record, creates one custom-format PostgreSQL archive, checks archive contents, calculates SHA-256, and writes a non-secret receipt JSON. With -RunRestoreTest, it restores into an isolated disposable PostgreSQL 18 Docker container (no network, no published ports), checks the original #1002 claim, and automatically destroys that container.

**Immediately remove your temporary Render IP allowlist entry afterward, even if the process fails.**

## What success means
The important output is:

~~~text
ARCHIVE_SHA256: <64 characters>
RESTORE_TEST: VERIFIED_IN_ISOLATED_DOCKER
~~~

Only then does the isolated restore validation pass. If the result is NOT_REQUESTED or NOT_VERIFIED, the backup might exist but the recovery gate remains incomplete. Keep a secure encrypted second copy. Do not share the dump, password, external DB URL, or raw files in chat.

You can safely report only:

~~~text
BACKUP_CREATED=YES/NO
RESTORE_VERIFIED=YES/NO
RENDER_IP_ALLOWLIST_REMOVED=YES/NO
~~~

## Next gate
After a restore-tested backup is secured and access re-closed, evaluate a *separate reviewed* migration installation specifically for 029 and 030. Migrations 026–028 remain simulation-only and must stay on HOLD. No real Shopify commit, customer bill send or production changes are included.

Tracking issue: https://github.com/Baftwaqas/asb-pipeline/issues/29
