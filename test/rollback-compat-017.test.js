"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const H = require("./support/harness");

const ROOT = path.join(__dirname, "..");

let db;
let server;
let base;
let sent;

before(async () => {
  const url = await H.createDatabase("asb_t_rollback_compat_017", ROOT);
  H.setEnv(url);
  sent = H.stubOutside(ROOT);

  const mod = require(path.join(ROOT, "server.js"));
  db = require(path.join(ROOT, "db"));

  await db.query(H.FIXTURE_SQL);

  await new Promise((resolve) => {
    server = mod.app.listen(0, "127.0.0.1", resolve);
  });

  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
  if (db?.shutdown) await db.shutdown();
});

test("compat order reserves a 017 source, links the bag, and a later delivery cannot merge or bill twice", async () => {
  const id = 8800000001001;
  const order = H.shopifyOrder({
    id,
    name: "#RC-1",
    lines: [H.line(H.GROCERY.aloo, 1)],
    phone: "+92 300 7000001",
  });

  assert.equal(
    await H.postShopify(base, order, { id: "rollback-compat-1" }),
    200
  );
  assert.equal(
    await H.waitWebhookDone(db, "shopify", "rollback-compat-1"),
    "processed"
  );

  const first = (
    await db.query(
      `SELECT origin, status, bill_state, legacy_reason, disposition,
              order_id, customer_id, cycle_id
         FROM shopify_order_sources
        WHERE shopify_order_id = $1`,
      [String(id)]
    )
  ).rows[0];

  assert.ok(first);
  assert.equal(first.origin, "compat");
  assert.equal(first.status, "legacy");
  assert.equal(first.bill_state, "legacy");
  assert.equal(first.legacy_reason, "compat_inline");
  assert.equal(first.disposition, "created");
  assert.ok(first.order_id);
  assert.ok(first.customer_id);
  assert.ok(first.cycle_id);

  assert.equal(sent.length, 1);

  const changedRedelivery = {
    ...order,
    line_items: [H.line(H.GROCERY.aloo, 9)],
  };

  assert.equal(
    await H.postShopify(base, changedRedelivery, { id: "rollback-compat-1b" }),
    200
  );
  assert.equal(
    await H.waitWebhookDone(db, "shopify", "rollback-compat-1b"),
    "processed"
  );

  const qty = (
    await db.query(
      `SELECT oi.qty_ordered
         FROM order_items oi
         JOIN shopify_order_sources s ON s.order_id = oi.order_id
        WHERE s.shopify_order_id = $1`,
      [String(id)]
    )
  ).rows[0];

  assert.equal(Number(qty.qty_ordered), 1);
  assert.equal(sent.length, 1);

  const sources = await db.query(
    `SELECT count(*)::int AS n
       FROM shopify_order_sources
      WHERE shopify_order_id = $1`,
    [String(id)]
  );
  assert.equal(sources.rows[0].n, 1);
});

test("an existing 017 received source is left untouched by rollback compat", async () => {
  const id = 8800000001002;

  const ev = await db.query(
    `INSERT INTO webhook_events
       (source, event_id, topic, payload, status)
     VALUES ('shopify', 'rollback-preexisting-source', 'orders/create', '{}'::jsonb, 'received')
     RETURNING id`
  );

  await db.query(
    `INSERT INTO shopify_order_sources
       (origin, shop, shopify_order_id, shopify_order_name,
        first_webhook_event_id,
        payload_sha256, payload_raw,
        commerce_fingerprint, commerce_fingerprint_version, commerce_canonical,
        status, bill_state)
     VALUES
       ('live', $1, $2, '#RC-2',
        $3,
        $4, '{}',
        $5, 1, '{}'::jsonb,
        'received', 'not_ready')`,
    [
      H.SHOP,
      String(id),
      ev.rows[0].id,
      "a".repeat(64),
      "b".repeat(64),
    ]
  );

  const beforeSends = sent.length;

  const order = H.shopifyOrder({
    id,
    name: "#RC-2",
    lines: [H.line(H.GROCERY.aloo, 3)],
    phone: "+92 300 7000002",
  });

  assert.equal(
    await H.postShopify(base, order, { id: "rollback-compat-2" }),
    200
  );
  assert.equal(
    await H.waitWebhookDone(db, "shopify", "rollback-compat-2"),
    "processed"
  );

  const src = (
    await db.query(
      `SELECT origin, status, bill_state, disposition, order_id,
              customer_id, cycle_id
         FROM shopify_order_sources
        WHERE shopify_order_id = $1`,
      [String(id)]
    )
  ).rows[0];

  assert.equal(src.origin, "live");
  assert.equal(src.status, "received");
  assert.equal(src.bill_state, "not_ready");
  assert.equal(src.disposition, null);
  assert.equal(src.order_id, null);
  assert.equal(src.customer_id, null);
  assert.equal(src.cycle_id, null);

  const orders = await db.query(
    `SELECT count(*)::int AS n FROM orders WHERE shopify_order_id = $1`,
    [String(id)]
  );

  assert.equal(orders.rows[0].n, 0);
  assert.equal(sent.length, beforeSends);
});

test("a grocery persistence failure sends no improvised WhatsApp bill", async () => {
  const id = 8800000001003;
  const beforeSends = sent.length;

  const impossiblePrice = {
    ...H.GROCERY.aloo,
    price: "999999999999999999999999999999.00",
  };

  const order = H.shopifyOrder({
    id,
    name: "#RC-3",
    lines: [H.line(impossiblePrice, 1)],
    phone: "+92 300 7000003",
  });

  assert.equal(
    await H.postShopify(base, order, { id: "rollback-compat-3" }),
    200
  );

  assert.equal(
    await H.waitWebhookDone(db, "shopify", "rollback-compat-3"),
    "failed"
  );

  assert.equal(sent.length, beforeSends);

  const sources = await db.query(
    `SELECT count(*)::int AS n
       FROM shopify_order_sources
      WHERE shopify_order_id = $1`,
    [String(id)]
  );
  assert.equal(sources.rows[0].n, 0);

  const orders = await db.query(
    `SELECT count(*)::int AS n FROM orders WHERE shopify_order_id = $1`,
    [String(id)]
  );
  assert.equal(orders.rows[0].n, 0);
});
