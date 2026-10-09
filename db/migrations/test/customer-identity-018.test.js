"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { Pool } = require("pg");
const H = require("./support/harness");

const ROOT = path.join(__dirname, "..");

let db;

before(async () => {
  const url = await H.createDatabase("asb_t_customer_identity_018", ROOT);
  db = new Pool({ connectionString: url });

  // Real grocery products needed by writeGroceryOrder().
  await db.query(H.FIXTURE_SQL);
});

after(async () => {
  await db?.end();
});

async function writeOrder(order, phone) {
  const { writeGroceryOrder } = require("../grocery/write");
  const c = await db.connect();

  try {
    await c.query("BEGIN");
    const result = await writeGroceryOrder(c, order, phone);
    await c.query("COMMIT");
    return result;
  } catch (e) {
    await c.query("ROLLBACK");
    throw e;
  } finally {
    c.release();
  }
}

test("018: Shopify customer id is non-unique metadata, while phone remains unique identity", async () => {
  const uniqueShopify = await db.query(`
    SELECT indexname, indexdef
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'customers'
       AND indexdef ILIKE '%UNIQUE%'
       AND indexdef ILIKE '%shopify_customer_id%'
  `);

  assert.equal(
    uniqueShopify.rows.length,
    0,
    `shopify_customer_id must not remain unique: ${JSON.stringify(uniqueShopify.rows)}`
  );

  const normalIndex = await db.query(`
    SELECT indexname, indexdef
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'customers'
       AND indexname = 'idx_customers_shopify_customer_id'
  `);

  assert.equal(normalIndex.rows.length, 1);
  assert.doesNotMatch(normalIndex.rows[0].indexdef, /\bUNIQUE\b/i);

  const phoneUnique = await db.query(`
    SELECT indexdef
      FROM pg_indexes
     WHERE schemaname = 'public'
       AND tablename = 'customers'
       AND indexdef ILIKE '%UNIQUE%'
       AND indexdef ILIKE '%(phone)%'
  `);

  assert.ok(phoneUnique.rows.length >= 1, "phone must remain uniquely constrained");
});

test("018: same Shopify customer id with different phones allows both grocery orders to apply", async () => {
  const shopifyCustomerId = 8800000000001;

  const orderA = H.shopifyOrder({
    id: 9818000000001,
    name: "#T018-A",
    lines: [H.line(H.GROCERY.aloo, 1)],
    phone: "+92 300 1110001",
  });

  const orderB = H.shopifyOrder({
    id: 9818000000002,
    name: "#T018-B",
    lines: [H.line(H.GROCERY.mango, 1)],
    phone: "+92 300 1110002",
  });

  // Same real Shopify account, two different ASB phone identities.
  orderA.customer.id = shopifyCustomerId;
  orderB.customer.id = shopifyCustomerId;

  const a = await writeOrder(orderA, "923001110001");
  const b = await writeOrder(orderB, "923001110002");

  assert.equal(a.alreadyPersisted, false);
  assert.equal(b.alreadyPersisted, false);
  assert.notEqual(a.orderId, b.orderId);
  assert.notEqual(a.customerId, b.customerId);

  const customers = (
    await db.query(
      `SELECT id, phone, shopify_customer_id
         FROM customers
        WHERE shopify_customer_id = $1
        ORDER BY phone`,
      [String(shopifyCustomerId)]
    )
  ).rows;

  assert.equal(customers.length, 2);
  assert.deepEqual(
    customers.map((r) => r.phone),
    ["923001110001", "923001110002"]
  );

  const orders = (
    await db.query(
      `SELECT shopify_order_id, customer_id
         FROM orders
        WHERE shopify_order_id = ANY($1)
        ORDER BY shopify_order_id`,
      [[String(orderA.id), String(orderB.id)]]
    )
  ).rows;

  assert.equal(orders.length, 2);
  assert.notEqual(orders[0].customer_id, orders[1].customer_id);
});

test("018: same phone still resolves to exactly one ASB customer", async () => {
  const { upsertCustomer } = require("../orders");

  const phone = "923001110003";

  const first = await upsertCustomer(db, {
    phone,
    name: "First Name",
    shopifyCustomerId: "8800000000002",
  });

  const second = await upsertCustomer(db, {
    phone,
    name: "Second Name",
    shopifyCustomerId: "8800000000999",
  });

  assert.equal(first.id, second.id);

  const rows = (
    await db.query(
      `SELECT id, phone, name, shopify_customer_id
         FROM customers
        WHERE phone = $1`,
      [phone]
    )
  ).rows;

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, first.id);

  // Existing identity metadata is not silently replaced by a later order.
  assert.equal(rows[0].shopify_customer_id, "8800000000002");
});

test("018: customer without Shopify id behaves unchanged", async () => {
  const { upsertCustomer } = require("../orders");

  const phone = "923001110004";

  const first = await upsertCustomer(db, {
    phone,
    name: "WhatsApp Customer",
  });

  const second = await upsertCustomer(db, {
    phone,
    name: "WhatsApp Customer Again",
  });

  assert.equal(first.id, second.id);

  const row = (
    await db.query(
      `SELECT phone, shopify_customer_id
         FROM customers
        WHERE phone = $1`,
      [phone]
    )
  ).rows[0];

  assert.equal(row.phone, phone);
  assert.equal(row.shopify_customer_id, null);
});

test("018: migration history contains 017 before 018 and both applied successfully", async () => {
  const rows = (
    await db.query(`
      SELECT filename
        FROM schema_migrations
       WHERE filename IN (
         '017_shopify_order_sources.sql',
         '018_customer_shopify_id_nonunique.sql'
       )
       ORDER BY filename
    `)
  ).rows.map((r) => r.filename);

  assert.deepEqual(rows, [
    "017_shopify_order_sources.sql",
    "018_customer_shopify_id_nonunique.sql",
  ]);
});
