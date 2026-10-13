"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Client } = require("pg");

const AWARE_DIR = path.resolve(process.env.AWARE_DIR || "");
const ROLLBACK_DIR = path.resolve(process.env.ROLLBACK_DIR || process.cwd());
const AWARE_SHA = process.env.AWARE_SHA;
const ROLLBACK_CODE_SHA = process.env.ROLLBACK_CODE_SHA;
const BASE = String(process.env.TEST_PG_URL || "").replace(/\/+$/, "");

if (!AWARE_DIR || !ROLLBACK_DIR || !AWARE_SHA || !ROLLBACK_CODE_SHA || !BASE) {
  throw new Error("missing AWARE_DIR / ROLLBACK_DIR / AWARE_SHA / ROLLBACK_CODE_SHA / TEST_PG_URL");
}

const baseUrl = new URL(BASE);
if (!["127.0.0.1", "localhost"].includes(baseUrl.hostname)) {
  throw new Error(`refusing non-local TEST_PG_URL host: ${baseUrl.hostname}`);
}

function git(args, cwd) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed in ${cwd}: ${r.stderr}`);
  return r.stdout.trim();
}

assert.equal(git(["rev-parse", "HEAD"], AWARE_DIR), AWARE_SHA, "aware checkout SHA mismatch");
assert.equal(
  spawnSync(
    "git",
    [
      "diff", "--quiet", ROLLBACK_CODE_SHA, "HEAD", "--",
      "server.js",
      "test/support/harness.js",
      "test/community-hardening.test.js",
      "test/community-phase1.test.js",
      "test/fixtures/017_shopify_order_sources.sql",
      "test/rollback-compat-017.test.js",
    ],
    { cwd: ROLLBACK_DIR }
  ).status,
  0,
  "rollback executable/test-support code changed after the proven rollback commit"
);

function runPhase(label, cwd, fn, env) {
  process.stdout.write(`\n=== ${label} ===\n`);
  const code = `(${fn.toString()})().catch((e) => { console.error(e && e.stack || e); process.exit(1); });`;
  const r = spawnSync(process.execPath, ["-e", code], {
    cwd,
    env: { ...process.env, ...env },
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  if (r.stdout) process.stdout.write(r.stdout);
  if (r.stderr) process.stderr.write(r.stderr);
  if (r.status !== 0) throw new Error(`${label} failed with exit ${r.status}`);
}

async function awareCapture() {
  const assert = require("node:assert/strict");
  const H = require("./test/support/harness");
  const scenario = process.env.SCENARIO;
  const dbName = process.env.DB_NAME;
  const orderId = Number(process.env.ORDER_ID);
  const lineId = Number(process.env.LINE_ID);
  const url = await H.createDatabase(dbName, process.cwd());

  H.setEnv(url);
  process.env.GROCERY_SOURCE_WORKER = scenario === "received" ? "off" : "on";
  process.env.GROCERY_BILL_SEND = scenario === "pending" ? "off" : "on";

  const sent = H.stubOutside(process.cwd());
  const mod = require("./server.js");
  const db = require("./db");
  await require("./productSync.js").ensureSchema(db);
  await db.query(H.FIXTURE_SQL);

  const line = { id: lineId, quantity: 1, vendor: "Apna Sasta Bazaar", ...H.GROCERY.aloo };
  const order = H.shopifyOrder({
    id: orderId,
    name: scenario === "received" ? "#OVR-R" : "#OVR-P",
    lines: [line],
    phone: scenario === "received" ? "+92 300 7100001" : "+92 300 7100002",
  });

  const server = mod.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    assert.equal(await H.postShopify(base, order, { id: `aware-${scenario}-capture` }), 200);

    const src = await H.waitFor(async () => {
      const r = await db.query(
        `SELECT origin, status, bill_state, order_id, customer_id, cycle_id, disposition
           FROM shopify_order_sources
          WHERE shopify_order_id = $1`,
        [String(orderId)]
      );
      const s = r.rows[0];
      if (!s) return null;
      if (scenario === "received") {
        return s.status === "received" && s.bill_state === "not_ready" ? s : null;
      }
      return s.status === "applied" && s.bill_state === "pending" ? s : null;
    });

    assert.equal(src.origin, "live");
    assert.equal(sent.length, 0, "aware pre-rollback phase must not send a bill");

    if (scenario === "received") {
      assert.equal(src.order_id, null);
      assert.equal(src.customer_id, null);
      assert.equal(src.cycle_id, null);
      assert.equal(src.disposition, null);
    } else {
      assert.ok(src.order_id);
      assert.equal(src.disposition === "created" || src.disposition === "merged", true);
      const q = await db.query(
        `SELECT oi.qty_ordered::float AS q
           FROM order_items oi
           JOIN shopify_order_sources s ON s.order_id = oi.order_id
          WHERE s.shopify_order_id = $1`,
        [String(orderId)]
      );
      assert.equal(q.rows[0].q, 1);
    }

    console.log(`aware capture state OK: ${src.status}/${src.bill_state}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (db.shutdown) await db.shutdown();
  }
}

async function rollbackVisit() {
  const assert = require("node:assert/strict");
  const H = require("./test/support/harness");
  const scenario = process.env.SCENARIO;
  const orderId = Number(process.env.ORDER_ID);
  const lineId = Number(process.env.LINE_ID);
  const url = `${String(process.env.TEST_PG_URL).replace(/\/+$/, "")}/${process.env.DB_NAME}`;

  H.setEnv(url);
  const sent = H.stubOutside(process.cwd());
  const mod = require("./server.js");
  const db = require("./db");

  const line = { id: lineId, quantity: 9, vendor: "Apna Sasta Bazaar", ...H.GROCERY.aloo };
  const order = H.shopifyOrder({
    id: orderId,
    name: scenario === "received" ? "#OVR-R" : "#OVR-P",
    lines: [line],
    phone: scenario === "received" ? "+92 300 7100001" : "+92 300 7100002",
  });

  const server = mod.app.listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    const hook = `rollback-${scenario}-redelivery`;
    assert.equal(await H.postShopify(base, order, { id: hook }), 200);
    assert.equal(await H.waitWebhookDone(db, "shopify", hook), "processed");

    const s = (
      await db.query(
        `SELECT origin, status, bill_state, order_id, customer_id, cycle_id, disposition
           FROM shopify_order_sources
          WHERE shopify_order_id = $1`,
        [String(orderId)]
      )
    ).rows[0];

    assert.ok(s);
    assert.equal(s.origin, "live");
    assert.equal(sent.length, 0, "rollback must never bill an order already known to 017");

    const count = await db.query(
      `SELECT count(*)::int AS n FROM shopify_order_sources WHERE shopify_order_id = $1`,
      [String(orderId)]
    );
    assert.equal(count.rows[0].n, 1);

    if (scenario === "received") {
      assert.equal(s.status, "received");
      assert.equal(s.bill_state, "not_ready");
      assert.equal(s.order_id, null);
      const orders = await db.query(
        `SELECT count(*)::int AS n FROM orders WHERE shopify_order_id = $1`,
        [String(orderId)]
      );
      assert.equal(orders.rows[0].n, 0, "rollback must not create a legacy bag for an in-flight 017 source");
    } else {
      assert.equal(s.status, "applied");
      assert.equal(s.bill_state, "pending");
      const q = await db.query(
        `SELECT oi.qty_ordered::float AS q
           FROM order_items oi
           JOIN shopify_order_sources src ON src.order_id = oi.order_id
          WHERE src.shopify_order_id = $1`,
        [String(orderId)]
      );
      assert.equal(q.rows[0].q, 1, "rollback redelivery must not merge quantity 9");
      const attempts = await db.query(
        `SELECT count(*)::int AS n FROM shopify_order_bill_attempts WHERE source_id = $1`,
        [(await db.query(`SELECT id FROM shopify_order_sources WHERE shopify_order_id = $1`, [String(orderId)])).rows[0].id]
      );
      assert.equal(attempts.rows[0].n, 0, "rollback must not consume the pending 017 bill");
    }

    console.log(`rollback overlap state preserved: ${s.status}/${s.bill_state}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (db.shutdown) await db.shutdown();
  }
}

async function awareResume() {
  const assert = require("node:assert/strict");
  const H = require("./test/support/harness");
  const orderId = Number(process.env.ORDER_ID);
  const url = `${String(process.env.TEST_PG_URL).replace(/\/+$/, "")}/${process.env.DB_NAME}`;

  H.setEnv(url);
  process.env.GROCERY_SOURCE_WORKER = "on";
  process.env.GROCERY_BILL_SEND = "on";

  const sent = H.stubOutside(process.cwd());
  const db = require("./db");
  const worker = require("./grocery/worker.js");

  try {
    await worker.runOnce(db);

    const s = await H.waitFor(async () => {
      const r = await db.query(
        `SELECT * FROM shopify_order_sources WHERE shopify_order_id = $1`,
        [String(orderId)]
      );
      const row = r.rows[0];
      return row && row.status === "applied" && row.bill_state === "sent" ? row : null;
    });

    const q = await db.query(
      `SELECT oi.qty_ordered::float AS q
         FROM order_items oi
         JOIN shopify_order_sources src ON src.order_id = oi.order_id
        WHERE src.shopify_order_id = $1`,
      [String(orderId)]
    );
    assert.equal(q.rows[0].q, 1, "017 resume must apply the original quantity exactly once");

    const attempts = await db.query(
      `SELECT count(*)::int AS n FROM shopify_order_bill_attempts WHERE source_id = $1`,
      [s.id]
    );
    assert.equal(attempts.rows[0].n, 1, "017 resume must make exactly one bill attempt");

    const messages = await db.query(
      `SELECT count(*)::int AS n
         FROM whatsapp_messages
        WHERE idempotency_key LIKE $1`,
      [`order_confirmed:shopify:${orderId}%`]
    );
    assert.equal(messages.rows[0].n, 1, "017 resume must record exactly one outbound bill");
    assert.equal(sent.length, 1, "017 resume must send exactly one bill");

    console.log("017 resumed exactly once: applied/sent, qty=1, bill_attempts=1");
  } finally {
    if (db.shutdown) await db.shutdown();
  }
}

async function dropDb(name) {
  const c = new Client({ connectionString: `${BASE}/postgres` });
  await c.connect();
  try {
    await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  } finally {
    await c.end();
  }
}

(async () => {
  const cases = [
    { scenario: "received", db: "asb_overlap_017_received", order: "8800000002001", line: "16000000002001" },
    { scenario: "pending", db: "asb_overlap_017_pending", order: "8800000002002", line: "16000000002002" },
  ];

  try {
    for (const c of cases) {
      const env = {
        SCENARIO: c.scenario,
        DB_NAME: c.db,
        ORDER_ID: c.order,
        LINE_ID: c.line,
      };
      runPhase(`${c.scenario}: 017-aware capture`, AWARE_DIR, awareCapture, env);
      runPhase(`${c.scenario}: rollback-compat overlap`, ROLLBACK_DIR, rollbackVisit, env);
      runPhase(`${c.scenario}: 017-aware resume`, AWARE_DIR, awareResume, env);
      console.log(`PASS overlap scenario: ${c.scenario}`);
    }
  } finally {
    for (const c of cases) {
      try { await dropDb(c.db); } catch (e) { console.error(`cleanup ${c.db}: ${e.message}`); }
    }
  }

  console.log("\nROLLBACK/017 OVERLAP REHEARSAL PASSED");
})().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
