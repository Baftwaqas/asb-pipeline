#!/usr/bin/env node
// ============================================================================
// scripts/cancel-order.js — cancel ONE order by its number, safely.
//
//   node scripts/cancel-order.js ASB-001023            # shows it, changes nothing
//   node scripts/cancel-order.js ASB-001023 --apply    # cancels it
//
// Cancelling (not deleting) keeps the history: the order, its items and its
// messages stay; it just stops counting for packing and delivery. Only an
// order that has not been packed yet can be cancelled here (pending /
// confirmed / locked). Nothing is sent to the customer.
//
// Needs DATABASE_URL in the environment (the direct Neon URL).
// ============================================================================
"use strict";

const { Client } = require("pg");

async function main() {
  const number = String(process.argv[2] || "").trim().toUpperCase();
  const apply = process.argv.includes("--apply");
  if (!/^ASB-\d{6}$/.test(number)) {
    console.error("Usage: node scripts/cancel-order.js ASB-001023 [--apply]");
    process.exit(2);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is not set.");
    process.exit(2);
  }
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    const o = (await db.query(
      `SELECT o.id, o.order_number, o.status::text AS status, o.grand_total, o.entered_by,
              c.phone, c.name, cy.code AS cycle, cy.delivery_date
         FROM orders o JOIN customers c ON c.id = o.customer_id
         LEFT JOIN cycles cy ON cy.id = o.cycle_id
        WHERE o.order_number = $1`, [number])).rows[0];
    if (!o) { console.log(`No order ${number}.`); return; }
    const items = (await db.query(
      `SELECT name_snapshot AS item, qty_ordered::float AS qty, unit::text AS unit, ceiling_unit_price::float AS rate
         FROM order_items WHERE order_id = $1 ORDER BY id`, [o.id])).rows;
    const bills = (await db.query(
      `SELECT bill_number, status::text AS status FROM bills WHERE order_id = $1`, [o.id])).rows;

    console.log("ORDER:", JSON.stringify({ ...o, delivery_date: String(o.delivery_date).slice(0, 15) }));
    console.table(items);
    console.log("BILLS:", bills.length ? JSON.stringify(bills) : "none");

    if (!["pending", "confirmed", "locked"].includes(o.status)) {
      console.log(`Not cancelled: status is '${o.status}'. Only pending/confirmed/locked orders can be cancelled here.`);
      return;
    }
    if (!apply) {
      console.log(`\nDRY RUN - nothing changed. Add --apply to cancel ${number}.`);
      return;
    }
    const r = await db.query(
      `UPDATE orders SET status = 'cancelled'
        WHERE id = $1 AND status IN ('pending','confirmed','locked')
        RETURNING order_number, status::text AS status`, [o.id]);
    console.log(r.rowCount ? `CANCELLED: ${JSON.stringify(r.rows[0])}` : "Nothing changed (status moved meanwhile).");
  } finally {
    await db.end();
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
