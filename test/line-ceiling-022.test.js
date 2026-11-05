// Migration 022 — order_items never bills a line above the amount accepted at
// checkout (F05/F14). Covers the weigh-station path, the order header, the
// bill text agreeing with the database to the paisa, and the migration's
// treatment of rows that already exist (unbilled refreshed; sent left alone).
// Needs a scratch Postgres (TEST_PG_URL, default postgres://postgres@localhost:54330).
//   node --test test/line-ceiling-022.test.js
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { Client } = require("pg");
const H = require("./support/harness");
const bill = require("../bill");

const ROOT = path.join(__dirname, "..");
let db, cycleId, seq = 0;

before(async () => {
  const url = await H.createDatabase("asb_test_022", ROOT, { grocery: false });
  db = new Client({ connectionString: url });
  await db.connect();
  cycleId = (await db.query(
    `INSERT INTO cycles (code, cycle_date, opens_at, locks_at, delivery_date)
     VALUES ('MON-T022', current_date, now() - interval '1 day', now() + interval '1 day', current_date + 1)
     RETURNING id`)).rows[0].id;
});
after(async () => { if (db) await db.end(); });

// One household per order: an order is unique per (customer, cycle).
async function newOrder() {
  seq += 1;
  const cust = (await db.query(`INSERT INTO customers (phone) VALUES ($1) RETURNING id`,
    [String(923000000100 + seq)])).rows[0].id;
  const o = (await db.query(`INSERT INTO orders (customer_id, cycle_id) VALUES ($1, $2) RETURNING id, order_number`,
    [cust, cycleId])).rows[0];
  return { ...o, customerId: cust };
}
// One product per line: a line is unique per (order, product).
async function item(orderId, { ordered = "1.000", packed = null, ceiling = "100.00", final = "95.00" } = {}) {
  seq += 1;
  const productId = (await db.query(
    `INSERT INTO products (sku, name_en, category) VALUES ($1, 'Onion', 'veg') RETURNING id`, ["ASB-T-" + seq])).rows[0].id;
  return (await db.query(
    `INSERT INTO order_items (order_id, product_id, name_snapshot, unit, qty_ordered, qty_packed,
       ceiling_unit_price, final_unit_price)
     VALUES ($1, $2, 'Onion', 'kg', $3, $4, $5, $6) RETURNING id`,
    [orderId, productId, ordered, packed, ceiling, final])).rows[0].id;
}
const row = async (id) => (await db.query(
  `SELECT qty_ordered, qty_packed, ceiling_unit_price, final_unit_price, billed_unit_price,
          line_total, ceiling_line_total, line_savings FROM order_items WHERE id = $1`, [id])).rows[0];
const header = async (orderId) => (await db.query(
  `SELECT billed_total, ceiling_total, savings_total, grand_total FROM orders WHERE id = $1`, [orderId])).rows[0];

test("weigh station: 1.08 kg packed at Rs 95/kg bills Rs 100.00, and the order header agrees", async () => {
  const o = await newOrder();
  const id = await item(o.id);
  const r = (await db.query(`SELECT * FROM asb_set_packed_qty($1, 1.080)`, [id])).rows[0];
  assert.equal(r.line_total, "100.00");
  const l = await row(id);
  assert.deepEqual([l.line_total, l.ceiling_line_total, l.line_savings], ["100.00", "100.00", "0.00"]);
  const h = await header(o.id);
  assert.equal(h.billed_total, "100.00");
  assert.equal(h.ceiling_total, "100.00");
  const v = (await db.query(`SELECT billed_total FROM v_order_totals WHERE order_id = $1`, [o.id])).rows[0];
  assert.equal(v.billed_total, "100.00");
});

test("0.92 kg and exact 1 kg are unchanged from 001 (customer pays for what arrived)", async () => {
  const o = await newOrder();
  const under = await row(await item(o.id, { packed: "0.920" }));
  assert.deepEqual([under.line_total, under.ceiling_line_total, under.line_savings], ["87.40", "92.00", "4.60"]);
  const exact = await row(await item(o.id, { packed: "1.000" }));
  assert.deepEqual([exact.line_total, exact.ceiling_line_total, exact.line_savings], ["95.00", "100.00", "5.00"]);
});

test("over-packed but cheaper than the promise bills by weight; before lock it stops at the ceiling", async () => {
  const o = await newOrder();
  const cheap = await row(await item(o.id, { packed: "1.080", final: "90.00" }));
  assert.deepEqual([cheap.line_total, cheap.ceiling_line_total, cheap.line_savings], ["97.20", "100.00", "2.80"]);
  const preLock = await row(await item(o.id, { packed: "1.080", final: null }));
  assert.deepEqual([preLock.line_total, preLock.ceiling_line_total, preLock.line_savings], ["100.00", "100.00", "0.00"]);
});

test("a direct UPDATE cannot push a line above its accepted ceiling", async () => {
  const o = await newOrder();
  const id = await item(o.id);
  await db.query(`UPDATE order_items SET qty_packed = 2.500 WHERE id = $1`, [id]);
  assert.equal((await row(id)).line_total, "100.00");
});

test("randomised rows: never above ceiling; identical to 001 when not over-packed; bill.js agrees to the paisa", async () => {
  const o = await newOrder();
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  for (let i = 0; i < 300; i++) {
    const ordered = (1 + Math.floor(rnd() * 5000)) / 1000;
    const packed = Math.round(ordered * (0.8 + rnd() * 0.4) * 1000) / 1000;
    const ceiling = (100 + Math.floor(rnd() * 40000)) / 100;
    const final = Math.round(ceiling * (0.7 + rnd() * 0.5) * 100) / 100;
    await item(o.id, { ordered: ordered.toFixed(3), packed: packed.toFixed(3), ceiling: ceiling.toFixed(2), final: final.toFixed(2) });
  }
  const above = (await db.query(
    `SELECT count(*)::int AS n FROM order_items
      WHERE order_id = $1 AND line_total > ROUND(qty_ordered * ceiling_unit_price, 2)`, [o.id])).rows[0].n;
  assert.equal(above, 0);
  const drifted = (await db.query(
    `SELECT count(*)::int AS n FROM order_items
      WHERE order_id = $1 AND qty_packed <= qty_ordered AND (
        line_total IS DISTINCT FROM ROUND(qty_packed * LEAST(ceiling_unit_price, COALESCE(final_unit_price, ceiling_unit_price)), 2)
        OR ceiling_line_total IS DISTINCT FROM ROUND(qty_packed * ceiling_unit_price, 2)
        OR line_savings IS DISTINCT FROM ROUND(qty_packed * (ceiling_unit_price
             - LEAST(ceiling_unit_price, COALESCE(final_unit_price, ceiling_unit_price))), 2))`, [o.id])).rows[0].n;
  assert.equal(drifted, 0);

  // JS rule (no line_total given) == the generated column, row by row.
  const rows = (await db.query(
    `SELECT qty_ordered, qty_packed, ceiling_unit_price, final_unit_price, billed_unit_price, line_total
       FROM order_items WHERE order_id = $1`, [o.id])).rows;
  for (const r of rows) {
    const { line_total, ...noDb } = r;
    assert.equal(bill.billedLinePaisa(noDb), Math.round(Number(line_total) * 100), JSON.stringify(r));
  }

  // Header, view and bill all agree.
  await db.query(`SELECT asb_refresh_order_totals($1)`, [o.id]);
  const h = await header(o.id);
  const b = bill.finalBill({ order_number: o.order_number, customer_name: "T", billed_total: h.billed_total,
    lines: rows.map((r) => ({ ...r, unit: "kg", pack_size: 1, name_en: "Onion" })) });
  assert.equal(b.billedPaisa, b.linePaisa.reduce((s, p) => s + p, 0));
  assert.equal(b.billedPaisa, Math.round(Number(h.billed_total) * 100));
  assert.equal(b.payablePaisa + b.roundingCreditPaisa, b.billedPaisa);
  assert.equal(b.payablePaisa % 100, 0);
});

test("migration on existing rows: unbilled header refreshed, sent bill left as the customer saw it", async () => {
  // Put order_items back to the 001 shape, load the bug, then run 022 for real.
  const restore001 = `
    DROP VIEW v_order_totals;
    ALTER TABLE order_items DROP COLUMN line_total, DROP COLUMN ceiling_line_total, DROP COLUMN line_savings;
    ALTER TABLE order_items
      ADD COLUMN line_total NUMERIC(14,2) GENERATED ALWAYS AS (ROUND(COALESCE(qty_packed, qty_ordered)
        * LEAST(ceiling_unit_price, COALESCE(final_unit_price, ceiling_unit_price)), 2)) STORED,
      ADD COLUMN ceiling_line_total NUMERIC(14,2) GENERATED ALWAYS AS (ROUND(COALESCE(qty_packed, qty_ordered) * ceiling_unit_price, 2)) STORED,
      ADD COLUMN line_savings NUMERIC(14,2) GENERATED ALWAYS AS (ROUND(COALESCE(qty_packed, qty_ordered)
        * (ceiling_unit_price - LEAST(ceiling_unit_price, COALESCE(final_unit_price, ceiling_unit_price))), 2)) STORED;
    CREATE VIEW v_order_totals AS SELECT o.id AS order_id, o.order_number, o.cycle_id, o.customer_id, o.status,
      COUNT(oi.id) AS line_count, COALESCE(SUM(oi.ceiling_line_total), 0) AS ceiling_total,
      COALESCE(SUM(oi.line_total), 0) AS billed_total, COALESCE(SUM(oi.line_savings), 0) AS savings_total,
      COALESCE(SUM(oi.line_total), 0) + o.delivery_fee - o.discount AS grand_total
      FROM orders o LEFT JOIN order_items oi ON oi.order_id = o.id AND NOT oi.is_unavailable GROUP BY o.id;`;
  await db.query(restore001);

  const unbilled = await newOrder();
  const sent = await newOrder();
  const ua = await item(unbilled.id, { packed: "1.080" });
  const sa = await item(sent.id, { packed: "1.080" });
  const keep = await item(unbilled.id, { packed: "0.920" });
  assert.equal((await row(ua)).line_total, "102.60"); // the bug, reproduced
  await db.query(`SELECT asb_refresh_order_totals($1)`, [unbilled.id]);
  await db.query(`SELECT asb_refresh_order_totals($1)`, [sent.id]);
  await db.query(
    `INSERT INTO bills (order_id, cycle_id, customer_id, subtotal, grand_total, status)
     VALUES ($1, $2, $3, 102.60, 102.60, 'sent')`, [sent.id, cycleId, sent.customerId]);
  const keepBefore = await row(keep);

  const notices = [];
  const onNotice = (n) => notices.push(n.message);
  db.on("notice", onNotice);
  await db.query(fs.readFileSync(path.join(ROOT, "db", "migrations", "022_line_ceiling_billing.sql"), "utf8"));
  db.off("notice", onNotice);

  assert.equal((await row(ua)).line_total, "100.00");
  assert.equal((await row(sa)).line_total, "100.00");
  assert.deepEqual(await row(keep), keepBefore);
  assert.equal((await header(unbilled.id)).billed_total, "187.40"); // 100.00 + 87.40
  assert.equal((await header(sent.id)).billed_total, "102.60");     // untouched: founder review
  assert.ok(notices.some((m) => m.includes(sent.order_number) && m.includes("founder review")), notices.join("\n"));
  assert.ok(notices.some((m) => /ASB022: [1-9][0-9]* unbilled order header\(s\) refreshed/.test(m)), notices.join("\n"));
});
