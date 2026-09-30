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
// There are no product NAMES in it — only each item's retailer id (the id the
// product has in the Meta catalogue). This file turns that into a readable
// order for the inbox and the phone notification:
//
//   🛒 Catalogue order — 3 items, Rs 1,240
//   • Tamatar: 2 kg — Rs 400
//   • Aloo: 5 kg — Rs 600
//   • Dhaniya: 1 gaddi — Rs 240
//
// Names come from our own products table, matched on whatever the retailer
// id turns out to be: our SKU, the Shopify variant id, the Shopify product
// id, or the "shopify_PK_<product>_<variant>" form Shopify's Facebook channel
// uses. If none match, Meta's catalogue is asked for the product name (this
// only works if the token may read the catalogue; if not, the retailer id is
// shown so nothing is ever hidden).
// ============================================================================

"use strict";

const bill = require("./bill");

const GRAPH_VERSION = process.env.GRAPH_VERSION || "v25.0";
const BASE = process.env.GRAPH_BASE || `https://graph.facebook.com/${GRAPH_VERSION}`;
const TOKEN = process.env.WHATSAPP_TOKEN || "";

const metaNameCache = new Map();   // retailer id -> name (or null = unknown)

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

/** Ask Meta's catalogue for a product's name. Quietly gives up. */
async function metaName(catalogId, rid) {
  if (metaNameCache.has(rid)) return metaNameCache.get(rid);
  let name = null;
  if (TOKEN && catalogId) {
    try {
      const url = new URL(`${BASE}/${catalogId}/products`);
      url.searchParams.set("fields", "name,retailer_id");
      url.searchParams.set("filter", JSON.stringify({ retailer_id: { eq: String(rid) } }));
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 4000);
      const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: ctl.signal });
      clearTimeout(t);
      const body = await res.json().catch(() => ({}));
      name = body?.data?.[0]?.name || null;
    } catch (_) { name = null; }
  }
  metaNameCache.set(rid, name);
  return name;
}

/**
 * Readable text for a catalogue order. Never throws: a database or network
 * problem gives the plainer version, not a lost message.
 */
async function describe(db, order) {
  const items = Array.isArray(order?.product_items) ? order.product_items : [];
  if (!items.length) return "🛒 Catalogue order (no items were included)";

  let rows = [];
  try { rows = await lookupProducts(db, items.map((i) => i.product_retailer_id)); }
  catch (e) { console.error("[catalogue] product lookup failed:", e.message); }

  let total = 0;
  let count = 0;
  const lines = [];
  for (const it of items) {
    const qty = Number(it.quantity) || 1;
    const price = Number(it.item_price) || 0;
    const lineTotal = qty * price;
    total += lineTotal;
    count += qty;

    const p = match(rows, it.product_retailer_id);
    const cost = price ? ` — ${bill.money(lineTotal)}` : "";
    if (p) {
      const name = p.name_roman || p.name_en;
      lines.push(`• ${name}: ${bill.qtyPhrase(qty, p.unit, p.pack_size)}${cost}`);
    } else {
      const name = (await metaName(order.catalog_id, it.product_retailer_id)) ||
        `item ${it.product_retailer_id}`;
      lines.push(`• ${qty} × ${name}${cost}`);
    }
  }

  const head = `🛒 Catalogue order — ${items.length} item${items.length === 1 ? "" : "s"}` +
    (total ? `, ${bill.money(total)}` : "");
  const note = order.text ? `\nNote: ${String(order.text).trim()}` : "";
  return `${head}\n${lines.join("\n")}${note}`;
}

module.exports = { describe, candidates, match };
