"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const H = require("./support/harness");

const ROOT = path.join(__dirname, "..");

let db;
let server;
let base;

before(async () => {
  const url = await H.createDatabase("asb_t_rollback_guard_pre017", ROOT, { compat017: false });
  H.setEnv(url);
  H.stubOutside(ROOT);

  const mod = require(path.join(ROOT, "server.js"));
  db = require(path.join(ROOT, "db"));
  await db.query(H.FIXTURE_SQL);

  await new Promise((resolve) => {
    server = mod.app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (db?.shutdown) await db.shutdown();
});

test("L3 health is 503 when migration 017 is absent", async () => {
  const res = await fetch(`${base}/healthz`);
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.rollbackCompat017?.ready, false);
  assert.equal(body.rollbackCompat017?.reason, "migration_017_missing");
  assert.equal(body.ready, false);
});

test("L3 refuses orders/create before ACK when migration 017 is absent", async () => {
  const id = 8800000001999;
  const order = H.shopifyOrder({
    id,
    name: "#RC-NO017",
    lines: [H.line(H.GROCERY.aloo, 1)],
    phone: "+92 300 7000999",
  });

  assert.equal(
    await H.postShopify(base, order, { id: "rollback-no-017" }),
    503
  );

  const events = await db.query(
    `SELECT count(*)::int AS n
       FROM webhook_events
      WHERE source = 'shopify' AND event_id = 'rollback-no-017'`
  );
  assert.equal(events.rows[0].n, 0, "order must be refused before durable capture/ACK");

  const orders = await db.query(
    `SELECT count(*)::int AS n FROM orders WHERE shopify_order_id = $1`,
    [String(id)]
  );
  assert.equal(orders.rows[0].n, 0);
});
