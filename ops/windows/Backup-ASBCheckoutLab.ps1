#requires -Version 5.1
<#
.SYNOPSIS
  One-shot PRIVATE backup of the isolated ASB Checkout Lab PostgreSQL 18 database,
  with optional disposable, network-isolated Docker restore verification.

.SAFETY
  - NEVER edits the database or Shopify orders.
  - NEVER accepts a database URL with a password in a command line.
  - NEVER opens Render's database IP allowlist automatically.
  - NEVER uploads backups, credentials, or customer data to GitHub/ChatGPT.
  - Refuses databases, hosts and users other than the one ASB lab instance.
  - Backup is NOT encrypted by this script. Use an encrypted private drive.
  - Restore test is exclusively in a disposable local Docker container.
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory=$true)][string]$BackupDirectory,
  [string]$ExternalHost = "dpg-dbm8v3qjnfac738pc31g-a.singapore-postgres.render.com",
  [string]$PgBin = "C:\Program Files\PostgreSQL\18\bin",
  [switch]$RunRestoreTest
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$databaseName = "asb_checkout_lab_pg18"
$databaseUser = "asb_checkout_lab_pg18_user"
$requiredHost = "dpg-dbm8v3qjnfac738pc31g-a.singapore-postgres.render.com"
$orderGid = "gid://shopify/Order/19011998580770"
$partial = $null
$finalFile = $null
$restoreStatus = "NOT_REQUESTED"
$restoreError = $null

function Assert-AllowedBackupLocation([string]$path) {
  if (-not [System.IO.Path]::IsPathRooted($path)) {
    throw "BACKUP_PATH_MUST_BE_ABSOLUTE"
  }
  $normalized = [System.IO.Path]::GetFullPath($path).TrimEnd('\')
  $repoRoot = [System.IO.Path]::GetFullPath(
    (Split-Path -Parent (Split-Path -Parent $PSScriptRoot))
  ).TrimEnd('\')
  $insideRepo = $normalized.Equals($repoRoot, [System.StringComparison]::OrdinalIgnoreCase) -or
    $normalized.StartsWith(($repoRoot + '\'), [System.StringComparison]::OrdinalIgnoreCase)
  if ($insideRepo) { throw "NEVER_STORE_DATABASE_BACKUP_INSIDE_SOURCE_REPOSITORY" }
  if ($normalized -match '(?i)(^|\\)(Desktop|Downloads|Public|\.git)(\\|$)') {
    throw "BACKUP_PATH_MUST_BE_PRIVATE_NOT_DESKTOP_DOWNLOADS_PUBLIC_OR_GIT"
  }
  if ($normalized -eq [System.IO.Path]::GetPathRoot($normalized).TrimEnd('\')) {
    throw "BACKUP_PATH_MUST_BE_A_DEDICATED_FOLDER"
  }
  return $normalized
}

function Get-PgExecutable([string]$name) {
  $expected = Join-Path $PgBin ($name + ".exe")
  $candidate = $null
  if (Test-Path -LiteralPath $expected -PathType Leaf) { $candidate = $expected }
  else {
    $onPath = Get-Command ($name + ".exe") -ErrorAction SilentlyContinue
    if ($null -ne $onPath) { $candidate = $onPath.Source }
  }
  if (-not $candidate) {
    throw ("POSTGRESQL_18_CLIENT_MISSING_" + $name.ToUpperInvariant())
  }
  $versionText = (& $candidate --version | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '\b18\.[0-9]+') {
    throw ("POSTGRESQL_18_CLIENT_VERSION_REQUIRED_" + $name.ToUpperInvariant())
  }
  return $candidate
}

function Run-DockerRestoreTest([string]$archiveFile) {
  $docker = Get-Command docker.exe -ErrorAction SilentlyContinue
  if ($null -eq $docker) { throw "DOCKER_DESKTOP_NOT_INSTALLED" }
  & $docker.Source info *> $null
  if ($LASTEXITCODE -ne 0) { throw "DOCKER_DESKTOP_NOT_RUNNING" }

  $name = "asb-lab-restore-" + ([Guid]::NewGuid().ToString("N").Substring(0,12))
  $tempPassword = [Guid]::NewGuid().ToString("N") + [Guid]::NewGuid().ToString("N")
  $containerStarted = $false
  try {
    # No ports are published and the restore container cannot use the network.
    & $docker.Source run --detach --rm --network none --name $name -e ("POSTGRES_PASSWORD=" + $tempPassword) postgres:18 *> $null
    if ($LASTEXITCODE -ne 0) { throw "ISOLATED_DOCKER_CONTAINER_START_FAILED" }
    $containerStarted = $true

    $ready = $false
    for ($i=0; $i -lt 45; $i++) {
      & $docker.Source exec $name pg_isready -U postgres *> $null
      if ($LASTEXITCODE -eq 0) { $ready = $true; break }
      Start-Sleep -Seconds 1
    }
    if (-not $ready) { throw "ISOLATED_DOCKER_POSTGRES_NOT_READY" }

    $copyTarget = [string]::Format("{0}:/tmp/asb_lab.dump",$name)
    & $docker.Source cp $archiveFile $copyTarget *> $null
    if ($LASTEXITCODE -ne 0) { throw "ISOLATED_RESTORE_ARCHIVE_COPY_FAILED" }

    # This is an EMPTY, disposable PostgreSQL 18 Docker instance, not Render.
    & $docker.Source exec $name pg_restore --create --exit-on-error --no-owner --no-privileges --username=postgres --dbname=postgres /tmp/asb_lab.dump *> $null
    if ($LASTEXITCODE -ne 0) { throw "ISOLATED_POSTGRES_RESTORE_FAILED" }

    $verifySql = @"
SELECT CASE WHEN
  current_database() = 'asb_checkout_lab_pg18'
  AND to_regclass('public.schema_migrations') IS NOT NULL
  AND to_regclass('public.checkout_quotes') IS NOT NULL
  AND to_regclass('public.checkout_redemptions') IS NOT NULL
  AND to_regclass('public.cycles') IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM public.checkout_redemptions
     WHERE shopify_order_gid = '$orderGid'
       AND state = 'completed'
       AND expected_cod_paisa = 4500
  )
THEN 'RESTORE_VERIFIED'
ELSE 'RESTORE_CHECK_FAILED' END;
"@
    $answer = (& $docker.Source exec $name psql -X -A -t -v ON_ERROR_STOP=1 -U postgres -d $databaseName -c $verifySql 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $answer -ne "RESTORE_VERIFIED") {
      throw "ISOLATED_RESTORE_DATA_INTEGRITY_FAILED"
    }
    return "VERIFIED_IN_ISOLATED_DOCKER"
  }
  finally {
    if ($containerStarted) {
      & $docker.Source rm --force $name *> $null
    }
    $tempPassword = $null
  }
}

try {
  if ($ExternalHost -cne $requiredHost) { throw "REFUSED_WRONG_RENDER_DATABASE_HOST" }
  if ($env:PGPASSWORD) { throw "CLEAR_ANY_EXISTING_PGPASSWORD_FIRST" }

  $target = Assert-AllowedBackupLocation $BackupDirectory
  Write-Host "ASB Checkout Lab private PostgreSQL 18 backup" -ForegroundColor Cyan
  Write-Warning "This backup is NOT encrypted by this script. Choose PRIVATE, ENCRYPTED storage; do not upload a dump to a chat, GitHub, or a shared folder."
  Write-Host ("Destination folder: " + $target)
  $answer = Read-Host "Type YES to confirm this folder is private and storage is encrypted"
  if ($answer -cne "YES") { throw "PRIVATE_ENCRYPTED_STORAGE_CONFIRMATION_REQUIRED" }

  $psql = Get-PgExecutable "psql"
  $dump = Get-PgExecutable "pg_dump"
  $restore = Get-PgExecutable "pg_restore"
  if (-not (Test-Path -LiteralPath $target)) {
    New-Item -ItemType Directory -Path $target -Force | Out-Null
  }

  $secure = Read-Host "Enter ONLY the ASB Checkout Lab database password (input hidden)" -AsSecureString
  $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
  try { $env:PGPASSWORD = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr) }
  finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr)
    $secure.Dispose()
  }
  $env:PGSSLMODE = "require"
  $env:PGCONNECT_TIMEOUT = "12"

  # Strict source identity check without printing rows, users or passwords.
  $sourceSql = @"
SELECT CASE WHEN
  current_database() = 'asb_checkout_lab_pg18'
  AND current_setting('server_version_num')::int BETWEEN 180000 AND 189999
  AND EXISTS (
    SELECT 1 FROM public.checkout_redemptions
    WHERE shopify_order_gid = '$orderGid'
      AND state = 'completed'
      AND expected_cod_paisa = 4500
  )
THEN 'ASB_LAB_SOURCE_VERIFIED'
ELSE 'SOURCE_MISMATCH' END;
"@
  $connectionArgs = @(
    "--host=$ExternalHost", "--port=5432",
    "--username=$databaseUser", "--dbname=$databaseName", "--no-password"
  )
  $actual = (& $psql @connectionArgs -X -A -t -q -v ON_ERROR_STOP=1 -c $sourceSql 2>&1 | Out-String).Trim()
  if ($LASTEXITCODE -ne 0 -or $actual -ne "ASB_LAB_SOURCE_VERIFIED") {
    throw "LAB_SOURCE_IDENTITY_OR_CONNECTION_FAILED"
  }
  Write-Host "Verified correct ASB lab database and order #1002." -ForegroundColor Green

  $stamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmssZ")
  $unique = [Guid]::NewGuid().ToString("N").Substring(0,6)
  $base = "ASB_CHECKOUT_LAB_PG18_" + $stamp + "_" + $unique
  $partial = Join-Path $target ($base + ".partial")
  $finalFile = Join-Path $target ($base + ".dump")
  $receiptFile = Join-Path $target ($base + ".receipt.json")
  if ((Test-Path -LiteralPath $partial) -or (Test-Path -LiteralPath $finalFile)) {
    throw "BACKUP_FILENAME_COLLISION"
  }

  Write-Host "Creating one read-only custom-format PostgreSQL archive..."
  & $dump @connectionArgs --format=custom --no-owner --no-acl "--file=$partial"
  if ($LASTEXITCODE -ne 0) { throw "PG_DUMP_FAILED" }
  $bytes = (Get-Item -LiteralPath $partial).Length
  if ($bytes -lt 1024) { throw "PG_DUMP_ARCHIVE_TOO_SMALL" }

  $toc = (& $restore --list $partial 2>&1 | Out-String)
  if ($LASTEXITCODE -ne 0 -or $toc -notmatch 'checkout_quotes' -or
      $toc -notmatch 'checkout_redemptions' -or $toc -notmatch 'schema_migrations') {
    throw "PG_RESTORE_ARCHIVE_LIST_INVALID"
  }

  # The database password is no longer needed for offline restore verification.
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:PGSSLMODE -ErrorAction SilentlyContinue
  Remove-Item Env:PGCONNECT_TIMEOUT -ErrorAction SilentlyContinue

  Move-Item -LiteralPath $partial -Destination $finalFile
  $partial = $null
  $checksum = (Get-FileHash -LiteralPath $finalFile -Algorithm SHA256).Hash

  if ($RunRestoreTest) {
    Write-Host "Testing restore inside a temporary PostgreSQL 18 Docker container..."
    try {
      $restoreStatus = Run-DockerRestoreTest $finalFile
    }
    catch {
      $restoreStatus = "NOT_VERIFIED"
      $restoreError = $_.Exception.Message
      Write-Warning "Backup archive kept, but restore verification DID NOT pass."
    }
  }
  else {
    $restoreStatus = "NOT_REQUESTED"
  }

  $receipt = [ordered]@{
    sourceDatabase = $databaseName
    renderInstance = "dpg-dbm8v3qjnfac738pc31g-a"
    backupCreatedUtc = (Get-Date).ToUniversalTime().ToString("o")
    archiveFilename = [System.IO.Path]::GetFileName($finalFile)
    archiveBytes = $bytes
    sha256 = $checksum
    archiveListCheck = "PASS"
    disposableRestoreTest = $restoreStatus
    sourceOrder = "#1002 (synthetic)"
    databaseWrites = 0
    shopifyOrderCommits = 0
    migration029030Approved = $false
  }
  $receipt | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $receiptFile -Encoding UTF8
  Write-Host ("BACKUP_SAVED: " + $finalFile) -ForegroundColor Green
  Write-Host ("ARCHIVE_SHA256: " + $checksum)
  Write-Host ("RESTORE_TEST: " + $restoreStatus)
  Write-Host ("RECEIPT_SAVED: " + $receiptFile)

  if ($RunRestoreTest -and $restoreStatus -ne "VERIFIED_IN_ISOLATED_DOCKER") {
    throw ("BACKUP_EXISTS_BUT_RESTORE_NOT_VERIFIED: " + $restoreError)
  }
  Write-Host "Do not apply migrations 029/030 until backup storage and recovery are approved." -ForegroundColor Yellow
}
finally {
  Remove-Item Env:PGPASSWORD -ErrorAction SilentlyContinue
  Remove-Item Env:PGSSLMODE -ErrorAction SilentlyContinue
  Remove-Item Env:PGCONNECT_TIMEOUT -ErrorAction SilentlyContinue
  if ($partial -and (Test-Path -LiteralPath $partial)) {
    Remove-Item -LiteralPath $partial -Force -ErrorAction SilentlyContinue
  }
}
