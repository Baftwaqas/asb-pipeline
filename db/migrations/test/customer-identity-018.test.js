"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { Pool } = require("pg");
const H = require("./support/harness");

const ROOT = path.join(__dirname, "..");

let db;
let url;

before(async () => {
  url = await H.createDatabase("asb_t_customer_identity_018", ROOT);
  db = new Pool({ connectionString: url });
});

after(async () => {
  await db?.end();
});

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

test("018: same Shopify customer id with different phones creates two ASB customers", async () => {
  const { upsertCustomer } = require("../orders");

  const shopifyId = "8800000000001";

  const a = await upsertCustomer(db, {
    phone: "923001110001",
    name: "Customer A",
    shopifyCustomerId: shopifyId,
  });

  const b = await upsertCustomer(db, {
    phone: "923001110002",
    name: "Customer B",
    shopifyCustomerId: shopifyId,
  });

  assert.notEqual(a.id, b.id);

  const rows = (
    await db.query(
      `SELECT id, phone, shopify_customer_id
         FROM customers
        WHERE shopify_customer_id = $1
        ORDER BY phone`,
      [shopifyId]
    )
  ).rows;

  assert.equal(rows.length, 2);
  assert.deepEqual(
    rows.map((r) => r.phone),
    ["923001110001", "923001110002"]
  );
  assert.ok(rows.every((r) => r.shopify_customer_id === shopifyId));
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
