"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Client } = require("pg");
const G = require("../scripts/lib/db-target-guard");
const rehearsalDb = require("../scripts/rehearsal-db");

const ROOT = path.join(__dirname, "..");

test("db target guard allows loopback but remote writes need exact independent authorization", () => {
  assert.deepEqual(
    G.assertMutationTarget({ databaseUrl: "postgres://u:p@127.0.0.1:5432/testdb" }),
    { host: "127.0.0.1", database: "testdb", local: true }
  );

  assert.throws(
    () => G.assertMutationTarget({
      databaseUrl: "postgres://u:p@ep-safe.us-east-1.aws.neon.tech/neondb",
      operation: "test"
    }),
    /remote writes require/
  );

  assert.throws(
    () => G.assertMutationTarget({
      databaseUrl: "postgres://u:p@ep-safe.us-east-1.aws.neon.tech/neondb",
      expectedHost: "ep-other.us-east-1.aws.neon.tech",
      expectedDatabase: "neondb",
      operation: "test"
    }),
    /authorized host/
  );

  assert.throws(
    () => G.assertMutationTarget({
      databaseUrl: "postgres://u:p@ep-safe.us-east-1.aws.neon.tech/neondb",
      expectedHost: "ep-safe.us-east-1.aws.neon.tech",
      expectedDatabase: "wrongdb",
      operation: "test"
    }),
    /authorized database/
  );

  assert.throws(
    () => G.assertMutationTarget({
      databaseUrl: "postgres://u:p@ep-safe-pooler.us-east-1.aws.neon.tech/neondb",
      expectedHost: "ep-safe-pooler.us-east-1.aws.neon.tech",
      expectedDatabase: "neondb",
      operation: "test"
    }),
    /pooled Neon endpoint/
  );

  assert.deepEqual(
    G.assertMutationTarget({
      databaseUrl: "postgres://u:p@ep-safe.us-east-1.aws.neon.tech/neondb",
      expectedHost: "ep-safe.us-east-1.aws.neon.tech",
      expectedDatabase: "neondb",
      operation: "test"
    }),
    {
      host: "ep-safe.us-east-1.aws.neon.tech",
      database: "neondb",
      local: false
    }
  );
});

test("connection-string host query override cannot bypass mutation or rehearsal guards", () => {
  const exploit =
    "postgres://u:p@localhost/neondb?host=ep-mute-field-aucqmus1.c-10.us-east-1.aws.neon.tech";

  assert.throws(
    () => G.assertMutationTarget({ databaseUrl: exploit, operation: "test exploit" }),
    /query parameter.*host.*refused/i
  );

  assert.throws(
    () => rehearsalDb.checkHost({
      databaseUrl: exploit,
      expectedHost: "localhost",
      productionHost: "ep-mute-field-aucqmus1.c-10.us-east-1.aws.neon.tech"
    }),
    /query parameter.*host.*refused/i
  );

  assert.throws(
    () => G.assertMutationTarget({
      databaseUrl: "postgres://u:p@localhost/neondb?hostaddr=127.0.0.1",
      operation: "hostaddr exploit"
    }),
    /query parameter.*hostaddr.*refused/i
  );
});

test("migrate --dry is genuinely read-only on an empty database", async () => {
  const base = String(process.env.TEST_PG_URL || "").replace(/\/+$/, "");
  assert.ok(base, "TEST_PG_URL required");

  const admin = new Client({ connectionString: `${base}/postgres` });
  await admin.connect();
  try {
    await admin.query("DROP DATABASE IF EXISTS asb_t_migrate_dry WITH (FORCE)");
    await admin.query("CREATE DATABASE asb_t_migrate_dry");
  } finally {
    await admin.end();
  }

  const url = `${base}/asb_t_migrate_dry`;
  const r = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "migrate.js"), "--dry"],
    { cwd: ROOT, encoding: "utf8", env: { ...process.env, DATABASE_URL: url } }
  );
  assert.equal(r.status, 0, `stdout=${r.stdout}\nstderr=${r.stderr}`);

  const c = new Client({ connectionString: url });
  await c.connect();
  try {
    const table = (await c.query(
      "SELECT to_regclass('public.schema_migrations') AS t"
    )).rows[0].t;
    assert.equal(table, null, "dry run must not create schema_migrations");

    const publicObjects = (await c.query(
      `SELECT count(*)::int AS n
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='public' AND c.relkind IN ('r','p','S','v','m')`
    )).rows[0].n;
    assert.equal(publicObjects, 0, "dry run must not create any public relation");
  } finally {
    await c.end();
  }
});

test("remote mutation CLIs refuse before attempting a network connection", () => {
  const fake = "postgres://u:p@ep-production.us-east-1.aws.neon.tech/neondb";
  const env = { ...process.env, DATABASE_URL: fake };
  delete env.ASB_MUTATION_DB_HOST;
  delete env.ASB_MUTATION_DB_NAME;

  const migrate = spawnSync(
    process.execPath,
    [path.join(ROOT, "scripts", "migrate.js")],
    { cwd: ROOT, encoding: "utf8", env, timeout: 3000 }
  );
  assert.equal(migrate.status, 2, `stdout=${migrate.stdout}\nstderr=${migrate.stderr}`);
  assert.match(migrate.stderr, /REFUSED.*remote writes require/i);

  const backfill = spawnSync(
    process.execPath,
    [
      path.join(ROOT, "scripts", "grocery-backfill.js"),
      "--apply",
      "--plan-sha", "deadbeef",
      "--shop", "x.myshopify.com",
      "--by", "test",
      "--reason", "guard test"
    ],
    { cwd: ROOT, encoding: "utf8", env, timeout: 3000 }
  );
  assert.equal(backfill.status, 2, `stdout=${backfill.stdout}\nstderr=${backfill.stderr}`);
  assert.match(backfill.stderr, /REFUSED.*remote writes require/i);
});
