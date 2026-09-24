#!/usr/bin/env node
// ============================================================================
// ASB PIPELINE — scripts/migrate.js
//
// Applies db/migrations/*.sql in filename order, once each, and records what
// it applied. Run it from the Render shell, where DATABASE_URL already points
// at Neon:
//
//   node scripts/migrate.js            # apply anything outstanding
//   node scripts/migrate.js --dry      # show what would run, change nothing
//   node scripts/migrate.js --seed     # also apply db/seed/*.sql (re-runnable)
//
// WHY THIS EXISTS
// Until now every schema change meant pasting SQL into the Neon console and
// clicking Run by hand. That is slow, it cannot be automated, and it has no
// record: nothing in the database says which migrations were applied, in what
// order, or whether the file on disk still matches what was run. This script
// is that record.
//
// SAFETY
//   * Each file is applied at most once, tracked by filename in
//     schema_migrations.
//   * The file's SHA-256 is stored. If an ALREADY-APPLIED file is edited
//     later, the run ABORTS rather than silently ignoring the change - the
//     most dangerous failure in any migration system is a file whose contents
//     no longer match what the database actually ran.
//   * Migration files carry their own BEGIN/COMMIT, so each is sent as one
//     statement batch and either lands whole or not at all. The runner does
//     NOT add a transaction of its own; wrapping a file that already begins
//     one produces a warning and a misleading nesting.
//   * Seeds are deliberately NOT tracked. A seed is written to be re-runnable
//     (ON CONFLICT DO UPDATE), and re-running it is how the catalogue picks up
//     changes made in Shopify.
// ============================================================================

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Client } = require("pg");

const ROOT = path.join(__dirname, "..");
const MIGRATIONS = path.join(ROOT, "db", "migrations");
const SEEDS = path.join(ROOT, "db", "seed");

const DRY = process.argv.includes("--dry");
const WITH_SEED = process.argv.includes("--seed");

// --baseline <filename>
//
// ADOPTING A DATABASE THAT IS ALREADY MIGRATED.
//
// Neon already has 001 through 004 applied - they were run by hand in the
// console before this runner existed - but it has no schema_migrations table
// to say so. A plain run would try to apply them again, and 001 creates types
// and tables without IF NOT EXISTS, so it would fail half way through.
//
// --baseline records every migration up to and including the named file as
// applied, WITHOUT EXECUTING ANY OF THEM. It is the one-time handshake between
// a database migrated by hand and a database migrated by this script.
//
//   node scripts/migrate.js --baseline 004_inbox.sql
//
// It refuses to overwrite an existing record, so running it twice is safe and
// it can never mark something applied that this runner actually applied.
const BASELINE = (() => {
  const i = process.argv.indexOf("--baseline");
  return i > -1 ? process.argv[i + 1] : null;
})();

function sqlFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort(); // 001_, 002_, ... 010_ sorts correctly because of the zero padding
}

function sha(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Migrations that exist on disk but must NOT run yet, listed in
 * db/migrations/HOLD. This is the difference between a migration runner that
 * helps and one that quietly applies a half-finished schema change to a live
 * database because the file happened to be sitting in the folder.
 *
 * Held files are reported on every run, never skipped silently.
 */
function heldMigrations() {
  const f = path.join(MIGRATIONS, "HOLD");
  if (!fs.existsSync(f)) return new Set();
  return new Set(
    fs
      .readFileSync(f, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
  );
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set.");
    process.exit(1);
  }

  // Same TLS rule as db/index.js: a hostname with no dots is a private
  // network name and needs no TLS; anything else crosses the internet.
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch (_) {}
  const isLocal =
    host === "localhost" || host === "127.0.0.1" || host === "::1" ||
    (host !== "" && !host.includes("."));

  const client = new Client({
    connectionString: url,
    ssl: isLocal ? false : { rejectUnauthorized: false },
    statement_timeout: 120_000,   // a migration may build an index; be patient
  });

  await client.connect();
  console.log(`[migrate] connected to ${host || "(unparsed host)"}\n`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename    TEXT PRIMARY KEY,
      sha256      TEXT NOT NULL,
      applied_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      ms          INTEGER
    )
  `);

  const { rows } = await client.query(
    `SELECT filename, sha256 FROM schema_migrations`
  );
  const applied = new Map(rows.map((r) => [r.filename, r.sha256]));

  const files = sqlFiles(MIGRATIONS);
  if (!files.length) {
    console.log("[migrate] no migration files found.");
    await client.end();
    return;
  }

  // ---- 1. Check every already-applied file still matches what was run -----
  const drifted = [];
  for (const f of files) {
    const recorded = applied.get(f);
    if (!recorded) continue;
    const current = sha(fs.readFileSync(path.join(MIGRATIONS, f), "utf8"));
    if (recorded !== current) drifted.push(f);
  }

  if (drifted.length) {
    console.error("[migrate] ABORTED - these files changed after being applied:\n");
    for (const f of drifted) console.error(`    ${f}`);
    console.error(
      "\n  The database ran a different version of this file than the one on disk.\n" +
        "  Do NOT edit an applied migration. Write a new one that makes the change,\n" +
        "  so the history stays true. (If the edit was cosmetic - a comment - and you\n" +
        "  are certain the SQL is unchanged, update the recorded hash deliberately.)"
    );
    await client.end();
    process.exit(3);
  }

  const held = heldMigrations();

  // ---- 1b. Baseline: adopt a hand-migrated database ------------------------
  if (BASELINE) {
    if (!files.includes(BASELINE)) {
      console.error(
        `[migrate] --baseline: no such migration "${BASELINE}".\n` +
          `          Available: ${files.join(", ")}`
      );
      await client.end();
      process.exit(6);
    }

    const upto = files.slice(0, files.indexOf(BASELINE) + 1).filter((f) => !held.has(f));
    console.log(`[migrate] baselining up to and including ${BASELINE}:`);

    for (const f of upto) {
      if (applied.has(f)) {
        console.log(`    ${f}  — already recorded, left alone`);
        continue;
      }
      const text = fs.readFileSync(path.join(MIGRATIONS, f), "utf8");
      if (DRY) {
        console.log(`    ${f}  — would record as applied (NOT run)`);
        continue;
      }
      await client.query(
        `INSERT INTO schema_migrations (filename, sha256, ms) VALUES ($1, $2, NULL)
         ON CONFLICT (filename) DO NOTHING`,
        [f, sha(text)]
      );
      applied.set(f, sha(text));
      console.log(`    ${f}  — recorded as applied (NOT run)`);
    }

    console.log(
      DRY
        ? "\n[migrate] --dry: nothing was changed."
        : "\n[migrate] baseline done. Run again without --baseline to apply what is outstanding."
    );
    await client.end();
    return;
  }

  // ---- 2. Apply what is outstanding ---------------------------------------

  // A held file that was somehow already applied is a contradiction worth
  // shouting about - the hold was added too late.
  for (const f of held) {
    if (applied.has(f)) {
      console.error(
        `[migrate] WARNING: ${f} is listed in HOLD but is ALREADY APPLIED.\n` +
          `          The hold came too late. Check what it did before relying on it.\n`
      );
    }
  }

  const skipped = files.filter((f) => held.has(f) && !applied.has(f));
  if (skipped.length) {
    console.log(`[migrate] ${skipped.length} file(s) HELD (see db/migrations/HOLD):`);
    for (const f of skipped) console.log(`    ${f}  — skipped on purpose`);
    console.log("");
  }

  const pending = files.filter((f) => !applied.has(f) && !held.has(f));

  if (!pending.length) {
    // Count what is actually applied, not every .sql in the folder - held
    // files live there too and counting them reads as "all done" when four
    // migrations are deliberately still waiting.
    console.log(`[migrate] up to date - ${applied.size} migration(s) applied.`);
  } else {
    console.log(`[migrate] ${pending.length} outstanding:`);
    for (const f of pending) console.log(`    ${f}`);
    console.log("");
  }

  if (DRY) {
    console.log("[migrate] --dry: nothing was changed.");
    await client.end();
    return;
  }

  for (const f of pending) {
    const full = path.join(MIGRATIONS, f);
    const text = fs.readFileSync(full, "utf8");
    const started = Date.now();
    process.stdout.write(`[migrate] applying ${f} ... `);
    try {
      // The file brings its own BEGIN/COMMIT. Sent as one batch.
      await client.query(text);
      const ms = Date.now() - started;
      await client.query(
        `INSERT INTO schema_migrations (filename, sha256, ms) VALUES ($1, $2, $3)`,
        [f, sha(text), ms]
      );
      console.log(`ok (${ms}ms)`);
    } catch (err) {
      console.log("FAILED");
      console.error(`\n  ${err.message}\n`);
      console.error(
        "  Nothing was recorded for this file, so fixing it and re-running is safe.\n" +
          "  Later migrations were not attempted."
      );
      await client.end();
      process.exit(4);
    }
  }

  // ---- 3. Seeds, on request ------------------------------------------------
  if (WITH_SEED) {
    const seeds = sqlFiles(SEEDS);
    for (const f of seeds) {
      const started = Date.now();
      process.stdout.write(`[seed]    applying ${f} ... `);
      try {
        await client.query(fs.readFileSync(path.join(SEEDS, f), "utf8"));
        console.log(`ok (${Date.now() - started}ms)`);
      } catch (err) {
        console.log("FAILED");
        console.error(`\n  ${err.message}\n`);
        await client.end();
        process.exit(5);
      }
    }
  }

  // ---- 4. Say what the database now looks like ----------------------------
  const summary = await client.query(`
    SELECT (SELECT count(*) FROM schema_migrations)                       AS migrations,
           (SELECT count(*) FROM information_schema.tables
             WHERE table_schema='public' AND table_type='BASE TABLE')     AS tables,
           (SELECT count(*) FROM pg_proc WHERE proname LIKE 'asb%')       AS asb_functions
  `);
  const s = summary.rows[0];
  console.log(
    `\n[migrate] done - ${s.migrations} migration(s) recorded, ` +
      `${s.tables} tables, ${s.asb_functions} asb_* functions.`
  );

  await client.end();
}

main().catch(async (e) => {
  console.error("[migrate] unexpected failure:", e.message);
  process.exit(1);
});
