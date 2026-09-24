#!/usr/bin/env node
// ============================================================================
// ASB PIPELINE — scripts/preview-bill.js
//
// Prints both customer messages for a real order, straight from the database.
// Sends nothing. Needs no Meta permission. This is how you read a bill before
// a customer does.
//
//   node scripts/preview-bill.js ASB-001003
//   node scripts/preview-bill.js ASB-001003 --mandi 'ASB-FRT-001=230,ASB-VEG-022=110'
//
// --mandi simulates the post-mandi price drop and re-weigh WITHOUT touching
// the live row, so you can see what the asal bill will look like before the
// cycle ever locks. Format: SKU=newUnitPrice[@packedQty], comma separated.
// ============================================================================

"use strict";

const db = require("../db");
const bill = require("../bill");

const RULE = "─".repeat(46);

async function main() {
  const orderNumber = process.argv[2];
  if (!orderNumber) {
    console.error("usage: node scripts/preview-bill.js <ORDER_NUMBER> [--mandi SKU=price[@qty],...]");
    process.exit(1);
  }

  const mandi = parseMandi(
    (process.argv.includes("--mandi") &&
      process.argv[process.argv.indexOf("--mandi") + 1]) || ""
  );

  const head = await db.query(
    `SELECT o.id, o.order_number, o.status::text AS status,
            o.ceiling_total, o.billed_total, o.savings_total, o.grand_total,
            o.market_total, o.community_total,
            cy.code AS cycle_code,
            COALESCE(c.name, 'Customer') AS customer_name,
            c.phone
       FROM orders o
       JOIN cycles cy   ON cy.id = o.cycle_id
       LEFT JOIN customers c ON c.id = o.customer_id
      WHERE o.order_number = $1`,
    [orderNumber]
  );

  if (!head.rows.length) {
    console.error(`No order ${orderNumber}.`);
    process.exit(2);
  }
  const order = head.rows[0];

  const items = await db.query(
    `SELECT p.sku, oi.name_snapshot AS name_en, oi.name_ur_snapshot AS name_ur,
            oi.unit::text AS unit,
            oi.qty_ordered, oi.qty_packed,
            oi.ceiling_unit_price, oi.final_unit_price, oi.billed_unit_price,
            oi.market_unit_price, oi.market_line_total, oi.community_savings,
            oi.line_total, oi.ceiling_line_total, oi.line_savings
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
      WHERE oi.order_id = $1
      ORDER BY oi.id`,
    [order.id]
  );
  order.lines = items.rows;

  // ---- message 1: exactly what the live row says today -------------------
  const confirm = bill.orderConfirmation(order);

  console.log(`\n${RULE}\n  1. ORDER CONFIRMATION  (sent at checkout)\n${RULE}`);
  console.log(confirm.rich);

  console.log(`\n${RULE}\n  template-safe version of the item list\n${RULE}`);
  console.log(confirm.params.order_items);
  const safe = bill.templateSafe(confirm.params.order_items);
  console.log(`\n  newline/tab safe for a template parameter: ${safe.ok ? "YES" : "NO"}`);

  // ---- message 2: apply the simulated mandi run in memory only -----------
  const after = {
    ...order,
    lines: order.lines.map((l) => {
      const sim = mandi[l.sku];
      if (!sim) return l;
      const finalPrice = sim.price;
      const packed = sim.qty != null ? sim.qty : l.qty_packed;
      // mirror the generated columns from 001_init exactly
      const billedQty = Number(packed ?? l.qty_ordered);
      const billedRate = Math.min(Number(l.ceiling_unit_price), Number(finalPrice));
      return {
        ...l,
        qty_packed: packed,
        final_unit_price: finalPrice,
        billed_unit_price: billedRate,
        line_total: round2(billedQty * billedRate),
        ceiling_line_total: round2(billedQty * Number(l.ceiling_unit_price)),
      };
    }),
  };
  after.ceiling_total = after.lines.reduce((s, l) => s + Number(l.ceiling_line_total), 0);
  after.billed_total = after.lines.reduce((s, l) => s + Number(l.line_total), 0);
  after.market_total = after.lines.reduce(
    (s, l) => s + Number(l.qty_packed ?? l.qty_ordered) * Number(l.market_unit_price ?? l.ceiling_unit_price), 0);

  const final = bill.finalBill(after);

  console.log(`\n${RULE}\n  2. ASAL BILL  (sent after the mandi run and weighing)\n${RULE}`);
  console.log(final.rich);

  console.log(`\n${RULE}\n  template-safe version of the item list\n${RULE}`);
  console.log(final.params.bill_items);
  console.log(
    `\n  newline/tab safe: ${bill.templateSafe(final.params.bill_items).ok ? "YES" : "NO"}`
  );
  console.log(`\n  bachat: ${bill.money(final.saved)}\n`);

  await db.shutdown();
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

function parseMandi(spec) {
  const out = {};
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [sku, rest] = part.split("=");
    if (!sku || !rest) continue;
    const [price, qty] = rest.split("@");
    out[sku.trim()] = {
      price: Number(price),
      qty: qty != null ? Number(qty) : null,
    };
  }
  return out;
}

main().catch(async (e) => {
  console.error("preview failed:", e.message);
  try {
    await db.shutdown();
  } catch (_) {}
  process.exit(1);
});
