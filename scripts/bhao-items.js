#!/usr/bin/env node
// ============================================================================
// ASB PIPELINE — scripts/bhao-items.js
// Founder-approved Bhao Tao items (migration 025). Prices in RUPEES here.
//
//   node scripts/bhao-items.js --add ASB-NG-POT-5L "Steel ki Degchi 5 litre" \
//        --variant gid://shopify/ProductVariant/123 --anchor 1800 --floor 850 --cost 600 \
//        --group 5:750 --max 20 --fact "5 litre" --fact "mota steel" --by "Waqas"
//   node scripts/bhao-items.js --stock ASB-NG-POT-5L 2      (real stock; 3 or fewer lets Seth Ji say so)
//   node scripts/bhao-items.js --off ASB-NG-POT-5L           (stop bargaining on it)
//   node scripts/bhao-items.js --list
// Needs DATABASE_URL.
// ============================================================================
"use strict";
const { Client } = require("pg");

const arg = (a, k) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : null; };
const all = (a, k) => a.flatMap((x, i) => (x === k ? [a[i + 1]] : []));
const paisa = (rs, name) => {
  const m = /^(\d{1,7})$/.exec(String(rs ?? ""));
  if (!m) throw new Error(`${name} must be whole rupees, e.g. 1800`);
  return Number(m[1]) * 100;
};

async function main() {
  const a = process.argv.slice(2);
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    if (a[0] === "--add") {
      const groups = all(a, "--group").map((g) => {
        const [q, f] = String(g).split(":");
        return { minQty: Number(q), floorPaisa: paisa(f, "--group floor") };
      });
      await db.query(
        `INSERT INTO bhao_items (item_id, variant_gid, name, anchor_paisa, floor_paisa, cost_paisa, group_tiers, max_qty, facts, approved_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [a[1], arg(a, "--variant"), a[2], paisa(arg(a, "--anchor"), "--anchor"), paisa(arg(a, "--floor"), "--floor"),
         arg(a, "--cost") ? paisa(arg(a, "--cost"), "--cost") : null, JSON.stringify(groups),
         Number(arg(a, "--max") || 10), JSON.stringify(all(a, "--fact")), arg(a, "--by")]);
      console.log("added", a[1]);
    } else if (a[0] === "--stock") {
      await db.query(`UPDATE bhao_items SET stock_left = $2 WHERE item_id = $1`, [a[1], Number(a[2])]);
      console.log("stock set");
    } else if (a[0] === "--off") {
      await db.query(`UPDATE bhao_items SET active = FALSE WHERE item_id = $1`, [a[1]]);
      console.log("bargaining off for", a[1]);
    } else {
      for (const r of (await db.query(`SELECT * FROM bhao_items ORDER BY item_id`)).rows)
        console.log(`${r.item_id}  ${r.name}  open Rs ${r.anchor_paisa / 100}  floor Rs ${r.floor_paisa / 100}` +
          `${r.stock_left != null ? "  stock " + r.stock_left : ""}${r.active ? "" : "  (off)"}  approved by ${r.approved_by}`);
    }
  } finally { await db.end(); }
}
main().catch((e) => { console.error(e.message); process.exit(1); });
