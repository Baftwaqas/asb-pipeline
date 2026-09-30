// ============================================================================
// ASB PIPELINE — catalogOrder.js
//
// When a customer builds a cart from the WhatsApp catalogue and taps "Send",
// Meta delivers a message of type "order":
//
//   { type: "order",
//     order: { catalog_id: "…",
//              text: "optional note",
//              product_items: [ { product_retailer_id: "…", quantity: 2,
//                                 item_price: 200, currency: "PKR" }, … ] } }
//
// There are no product NAMES in it — only each item's retailer id (the
// "Content ID" the product has in the Meta catalogue). This file turns that
// into a readable order for the inbox and the phone notification:
//
//   🛒 Catalogue order — 3 items, Rs 1,240
//   • Tamatar: 2 kg — Rs 400
//   • 2 × Aloo 1 kg — Rs 240
//
// Where the names come from, in order:
//   1. our own products table, if the retailer id is our SKU or a Shopify id
//      (catalogues fed from Shopify use those);
//   2. the Meta catalogue itself. Catalogues built by hand in Commerce Manager
//      give every product a random id like "09s209nscn", so the whole
//      catalogue is read once (retailer id -> name) and kept in memory,
//      refreshed every few hours and whenever an unknown id turns up.
//      Reading it needs the token to have the catalog_management permission
//      on that catalogue; if it hasn't, Meta's reason is logged once, with
//      the fix, as "[catalogue] cannot read Meta catalogue …".
//   3. if both fail, the retailer id is shown, so nothing is ever hidden.
// ============================================================================

"use strict";

const bill = require("./bill");

const GRAPH_VERSION = process.env.GRAPH_VERSION || "v25.0";
const BASE = process.env.GRAPH_BASE || `https://graph.facebook.com/${GRAPH_VERSION}`;
const TOKEN = process.env.WHATSAPP_TOKEN || "";

const REFRESH_EVERY_MS = 6 * 60 * 60 * 1000;   // routine refresh
const RETRY_AFTER_MS = 10 * 60 * 1000;         // at most this often on demand

// catalog id -> { items: Map(retailer id -> {name, price}), loadedAt, triedAt, error }
const catalogues = new Map();

function entry(catalogId) {
  if (!catalogues.has(catalogId)) {
    catalogues.set(catalogId, { items: new Map(), loadedAt: 0, triedAt: 0, error: null, loading: null });
  }
  return catalogues.get(catalogId);
}

async function graphGet(url) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: ctl.signal });
    const body = await res.json().catch(() => ({}));
    if (body.error) throw new Error(`(#${body.error.code}) ${body.error.message}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} from Meta`);
    return body;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Read every product of a Meta catalogue into memory. Never throws; the
 * reason for a failure is kept in `error` and logged once per distinct reason.
 */
async function syncCatalogue(catalogId) {
  if (!catalogId) return null;
  const e = entry(String(catalogId));
  if (e.loading) return e.loading;
  e.loading = (async () => {
    e.triedAt = Date.now();
    if (!TOKEN) { e.error = "WHATSAPP_TOKEN is not set"; return e; }
    try {
      const items = new Map();
      const first = new URL(`${BASE}/${catalogId}/products`);
      first.searchParams.set("fields", "retailer_id,name,price");
      first.searchParams.set("limit", "500");
      let next = first.toString();
      let pages = 0;
      while (next && pages < 40) {
        const body = await graphGet(next);
        for (const p of body.data || []) {
          if (p.retailer_id) items.set(String(p.retailer_id), { name: p.name || null, price: p.price || null });
        }
        next = body.paging?.next || null;
        pages += 1;
      }
      e.items = items;
      e.loadedAt = Date.now();
      if (e.error) console.log(`[catalogue] catalogue ${catalogId} readable again`);
      e.error = null;
      console.log(`[catalogue] read ${items.size} product(s) from Meta catalogue ${catalogId}`);
    } catch (err) {
      const reason = err.name === "AbortError" ? "Meta did not answer in time" : err.message;
      if (reason !== e.error) {
        console.error(`[catalogue] cannot read Meta catalogue ${catalogId}: ${reason}` +
          ` — the token needs the catalog_management permission on this catalogue` +
          ` (Business Settings > System users > Assign assets > Catalogues), then a new token`);
      }
      e.error = reason;
    }
    return e;
  })().finally(() => { e.loading = null; });
  return e.loading;
}

/** Names from the Meta catalogue, refreshing it when stale or when ids are unknown. */
async function metaNames(catalogId, rids) {
  if (!catalogId) return new Map();
  const e = entry(String(catalogId));
  const unknown = rids.some((r) => !e.items.has(String(r)));
  const stale = Date.now() - e.loadedAt > REFRESH_EVERY_MS;
  const mayRetry = Date.now() - e.triedAt > RETRY_AFTER_MS;
  if ((stale || unknown) && mayRetry) await syncCatalogue(catalogId);
  return e.items;
}

/** Every id a retailer id might stand for in our products table. */
function candidates(rid) {
  const s = String(rid || "").trim();
  const out = new Set([s]);
  const nums = s.match(/\d{6,}/g) || [];          // Shopify ids are long numbers
  for (const n of nums) out.add(n);
  return [...out].filter(Boolean);
}

async function lookupProducts(db, rids) {
  const keys = [...new Set(rids.flatMap(candidates))];
  if (!keys.length) return [];
  const { rows } = await db.query(
    `SELECT sku, name_en, name_roman, unit::text AS unit, min_qty AS pack_size,
            shopify_product_id, shopify_variant_id
       FROM products
      WHERE sku = ANY($1) OR shopify_variant_id = ANY($1) OR shopify_product_id = ANY($1)`,
    [keys]
  );
  return rows;
}

/** Best product row for one retailer id: exact SKU/variant beats product id. */
function match(rows, rid) {
  const s = String(rid || "").trim();
  const nums = s.match(/\d{6,}/g) || [];
  const last = nums[nums.length - 1];
  return (
    rows.find((r) => r.sku === s || r.shopify_variant_id === s) ||
    (last && rows.find((r) => r.shopify_variant_id === last)) ||
    rows.find((r) => nums.includes(r.shopify_variant_id)) ||
    rows.find((r) => r.shopify_product_id === s || nums.includes(r.shopify_product_id)) ||
    null
  );
}

/** True when a saved preview still has an item without a name. */
function hasUnnamed(text) {
  return /• \d+ × item \S+/.test(String(text || "")) || text === "(catalogue order)";
}

/**
 * Readable text for a catalogue order. Never throws: a database or network
 * problem gives the plainer version, not a lost message.
 */
async function describe(db, order) {
  const items = Array.isArray(order?.product_items) ? order.product_items : [];
  if (!items.length) return "🛒 Catalogue order (no items were included)";
  const rids = items.map((i) => String(i.product_retailer_id || ""));

  let rows = [];
  try { rows = await lookupProducts(db, rids); }
  catch (e) { console.error("[catalogue] product lookup failed:", e.message); }

  const needMeta = rids.filter((r) => !match(rows, r));
  let names = new Map();
  if (needMeta.length) {
    try { names = await metaNames(order.catalog_id, needMeta); }
    catch (e) { console.error("[catalogue] name lookup failed:", e.message); }
  }

  let total = 0;
  const lines = [];
  for (const it of items) {
    const qty = Number(it.quantity) || 1;
    const price = Number(it.item_price) || 0;
    const lineTotal = qty * price;
    total += lineTotal;

    const rid = String(it.product_retailer_id || "");
    const cost = price ? ` — ${bill.money(lineTotal)}` : "";
    const p = match(rows, rid);
    if (p) {
      const name = p.name_roman || p.name_en;
      lines.push(`• ${name}: ${bill.qtyPhrase(qty, p.unit, p.pack_size)}${cost}`);
    } else {
      const name = names.get(rid)?.name || `item ${rid}`;
      lines.push(`• ${qty} × ${name}${cost}`);
    }
  }

  const head = `🛒 Catalogue order — ${items.length} item${items.length === 1 ? "" : "s"}` +
    (total ? `, ${bill.money(total)}` : "");
  const note = order.text ? `\nNote: ${String(order.text).trim()}` : "";
  return `${head}\n${lines.join("\n")}${note}`;
}

/**
 * Re-write saved catalogue orders whose items are still unnamed (older ones,
 * or ones that arrived while the catalogue could not be read).
 */
async function refillSaved(db) {
  const { rows } = await db.query(
    `SELECT wamid, payload, body_preview FROM whatsapp_messages
      WHERE msg_type = 'order'
        AND (body_preview = '(catalogue order)' OR body_preview LIKE '%× item %')
      ORDER BY received_at DESC LIMIT 500`);
  let fixed = 0;
  for (const r of rows) {
    if (!r.payload?.order) continue;
    const text = (await describe(db, r.payload.order)).slice(0, 1500);
    if (text !== r.body_preview) {
      await db.query(`UPDATE whatsapp_messages SET body_preview = $2 WHERE wamid = $1`, [r.wamid, text]);
      if (!hasUnnamed(text)) fixed += 1;
    }
  }
  if (fixed) console.log(`[catalogue] wrote the product names into ${fixed} earlier catalogue order(s)`);
  return fixed;
}

/** Start-up: read the catalogues seen in past orders, fix old rows, refresh every 6 h. */
function start(db) {
  const run = async () => {
    const { rows } = await db.query(
      `SELECT DISTINCT payload->'order'->>'catalog_id' AS id FROM whatsapp_messages
        WHERE msg_type = 'order' AND payload->'order'->>'catalog_id' IS NOT NULL`);
    const ids = new Set(rows.map((r) => r.id));
    if (process.env.CATALOG_ID) ids.add(process.env.CATALOG_ID);
    for (const id of ids) await syncCatalogue(id);
    await refillSaved(db);
  };
  run().catch((e) => console.error("[catalogue] start-up refresh failed:", e.message));
  const t = setInterval(() => run().catch((e) => console.error("[catalogue] refresh failed:", e.message)),
    REFRESH_EVERY_MS);
  t.unref?.();
}

function status() {
  return [...catalogues.entries()].map(([id, e]) => ({
    catalogId: id, products: e.items.size,
    loadedAt: e.loadedAt ? new Date(e.loadedAt).toISOString() : null, error: e.error,
  }));
}

module.exports = { describe, candidates, match, syncCatalogue, refillSaved, start, status, hasUnnamed };
