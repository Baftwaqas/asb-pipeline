// scripts/cancel-order.js: dry run changes nothing; --apply cancels once; packed orders are refused.
"use strict";
const { test, before } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { execFileSync } = require("child_process");
const { Client } = require("pg");
const H = require("./support/harness");

const ROOT = path.join(__dirname, "..");
let url;
const run = (...args) => execFileSync(process.execPath, [path.join(ROOT, "scripts", "cancel-order.js"), ...args],
  { env: { ...process.env, DATABASE_URL: url }, encoding: "utf8" });
const q = async (sql, p) => { const c = new Client({ connectionString: url }); await c.connect(); try { return (await c.query(sql, p)).rows; } finally { await c.end(); } };

before(async () => {
  url = await H.createDatabase("asb_t_cancel", ROOT, { grocery: false });
  await q(H.FIXTURE_SQL);
  const cyc = (await q(`SELECT id FROM cycles ORDER BY id LIMIT 1`))[0]
    || (await q(`INSERT INTO cycles (code, cycle_date, opens_at, locks_at, delivery_date, status) VALUES ('C-T', current_date + 2, now(), now() + interval '1 day', current_date + 3, 'open') RETURNING id`))[0];
  const cust = (await q(`INSERT INTO customers (phone, name) VALUES ('923001112222', 'Test') RETURNING id`))[0];
  await q(`INSERT INTO orders (customer_id, cycle_id, channel, status, order_number) VALUES ($1, $2, 'whatsapp', 'confirmed', 'ASB-009001')`, [cust.id, cyc.id]);
  const cust2 = (await q(`INSERT INTO customers (phone, name) VALUES ('923001113333', 'Packed') RETURNING id`))[0];
  await q(`INSERT INTO orders (customer_id, cycle_id, channel, status, order_number) VALUES ($1, $2, 'whatsapp', 'packed', 'ASB-009002')`, [cust2.id, cyc.id]);
});

test("dry run shows the order and changes nothing; --apply cancels it", async () => {
  const dry = run("ASB-009001");
  assert.match(dry, /DRY RUN - nothing changed/);
  assert.equal((await q(`SELECT status::text FROM orders WHERE order_number = 'ASB-009001'`))[0].status, "confirmed");
  assert.match(run("ASB-009001", "--apply"), /CANCELLED/);
  assert.equal((await q(`SELECT status::text FROM orders WHERE order_number = 'ASB-009001'`))[0].status, "cancelled");
  assert.match(run("ASB-009001", "--apply"), /Not cancelled: status is 'cancelled'/);
});

test("a packed order is refused", async () => {
  assert.match(run("ASB-009002", "--apply"), /Not cancelled: status is 'packed'/);
  assert.equal((await q(`SELECT status::text FROM orders WHERE order_number = 'ASB-009002'`))[0].status, "packed");
});
