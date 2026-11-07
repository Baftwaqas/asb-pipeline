#!/usr/bin/env node
// ============================================================================
// ASB PIPELINE — scripts/price-watch-run.js
//
// Competitor price watch for Bhao Tao (migration 024).
//
//   # a PERSON confirms a competitor page is the same item, once:
//   node scripts/price-watch-run.js --add ASB-NG-POT-5L daraz https://www.daraz.pk/products/... --by "Waqas"
//
//   # check every active page (daily, e.g. a Render Cron Job):
//   node scripts/price-watch-run.js --check
//
//   # see the latest price per page:
//   node scripts/price-watch-run.js --list
//
// Needs DATABASE_URL. --check reads only the listed product pages, obeys each
// site's robots.txt, waits between requests, identifies itself, and records
// a blocked or unreadable page as such - it never works around a block.
// ============================================================================
"use strict";

const { Client } = require("pg");
const PW = require("../bhao/price-watch");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function add(db, { itemId, marketplace, url, by, note = null }) {
  if (!itemId || !marketplace || !url || !by) throw new Error("usage: --add ITEM_ID MARKETPLACE URL --by NAME");
  const u = new URL(url);
  if (/\/(catalog|search)\b/i.test(u.pathname) || u.searchParams.has("q"))
    throw new Error("list a single PRODUCT page, not a search or catalogue page");
  const r = await db.query(
    `INSERT INTO competitor_price_watches (item_id, marketplace, url, confirmed_same_item_by, note)
     VALUES ($1, lower($2), $3, $4, $5)
     ON CONFLICT (item_id, marketplace, url) DO UPDATE SET active = TRUE
     RETURNING id`, [itemId, marketplace, u.href, by, note]);
  return r.rows[0].id;
}

async function check(db, { fetchImpl = fetch, delayMs = 4000, log = console.log } = {}) {
  const watches = (await db.query(
    `SELECT id, item_id, marketplace, url FROM competitor_price_watches WHERE active ORDER BY id`)).rows;
  const robotsCache = new Map();
  const summary = { ok: 0, notOk: 0 };
  for (let i = 0; i < watches.length; i++) {
    if (i > 0) await sleep(delayMs);
    const w = watches[i];
    const r = await PW.checkWatch(w, { fetchImpl, robotsCache });
    await db.query(
      `INSERT INTO competitor_price_checks (watch_id, status, http_status, price_paisa, via) VALUES ($1, $2, $3, $4, $5)`,
      [w.id, r.status, r.httpStatus ?? null, r.status === "ok" ? r.pricePaisa : null, r.via ?? null]);
    if (r.status === "ok") summary.ok++; else summary.notOk++;
    log(`${w.item_id}  ${w.marketplace}  ${r.status}${r.status === "ok" ? "  Rs " + (r.pricePaisa / 100) : ""}${r.via ? "  (" + r.via + ")" : ""}`);
  }
  return summary;
}

async function list(db, log = console.log) {
  const rows = (await db.query(`SELECT * FROM competitor_price_latest ORDER BY item_id, marketplace`)).rows;
  for (const r of rows)
    log(`${r.item_id}  ${r.marketplace}  ${r.status || "never checked"}${r.price_paisa ? "  Rs " + Number(r.price_paisa) / 100 : ""}  ${r.checked_at ? new Date(r.checked_at).toISOString() : ""}${r.active ? "" : "  (inactive)"}`);
  return rows;
}

async function main() {
  const a = process.argv.slice(2);
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  try {
    if (a[0] === "--add") {
      const by = a.includes("--by") ? a[a.indexOf("--by") + 1] : null;
      const id = await add(db, { itemId: a[1], marketplace: a[2], url: a[3], by });
      console.log("watch", id, "saved");
    } else if (a[0] === "--check") {
      const s = await check(db);
      console.log(`done: ${s.ok} priced, ${s.notOk} without a usable price`);
    } else if (a[0] === "--list") {
      await list(db);
    } else {
      console.log("usage: --add ITEM MARKETPLACE URL --by NAME | --check | --list");
    }
  } finally {
    await db.end();
  }
}

if (require.main === module) main().catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { add, check, list };
