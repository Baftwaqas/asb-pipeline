// ============================================================================
// ASB PIPELINE — productSync.js
//
// ONE PLACE TO CHANGE A PRICE: SHOPIFY.
//
// Change a price (or a product's title/unit) in Shopify - from the Shopify app
// on the phone, or by sending the day's rate list to Claude - and this file
// carries it everywhere else:
//
//   Shopify ──products/update webhook──▶ products table (inbox order panel,
//                                        bills, catalogue-order names)
//                                     └─▶ WhatsApp catalogue on Meta
//                                         (price = bazaar rate, struck through;
//                                          sale price = ASB rate)
//
// The WhatsApp catalogue was built by hand, so its products carry Meta's own
// random ids ("09s209nscn"). Each of our products remembers its catalogue id
// in products.meta_retailer_id (column added by ensureSchema() at start-up);
// that link is made once per product (inbox:
// POST /api/inbox/rates/link) and after that every Shopify change flows
// through on its own.
//
// Titles follow one pattern so the unit can be read back reliably:
//   "Tamatar — 500 gm | ٹماٹر"     "Dhania — 1 gaddi | ہرا دھنیا"
// ============================================================================

"use strict";

const communityRegistry = require("./community/registry");

const GRAPH_VERSION = process.env.GRAPH_VERSION || "v25.0";
const BASE = process.env.GRAPH_BASE || `https://graph.facebook.com/${GRAPH_VERSION}`;
const TOKEN = process.env.WHATSAPP_TOKEN || "";

// "500 gm" -> how products stores it (unit + pack size = min_qty).
// Grams use unit 'g' so bills say "aadha kg" / "pao", exactly as people talk.
const UNITS = [
  { re: /^(\d+(?:\.\d+)?)\s*(kg|kilo)$/i,               to: (n) => ({ unit: "kg", pack: n }) },
  { re: /^(\d+(?:\.\d+)?)\s*(g|gm|gms|gram|grams)$/i,   to: (n) => ({ unit: "g", pack: n }) },
  { re: /^(\d+)?\s*(gaddi|bunch|bundle)$/i,             to: (n) => ({ unit: "bundle", pack: n || 1 }) },
  { re: /^(\d+)?\s*(darjan|dozen)$/i,                   to: (n) => ({ unit: "dozen", pack: n || 1 }) },
  { re: /^(\d+)?\s*(piece|pieces|pcs|adad|dana)$/i,     to: (n) => ({ unit: "pcs", pack: n || 1 }) },
  { re: /^(\d+)?\s*(packet|pack|box)$/i,                to: (n) => ({ unit: "packet", pack: n || 1 }) },
];

/**
 * "Tamatar — 500 gm | ٹماٹر" -> { name: "Tamatar", unit: "g", pack: 500, urdu: "ٹماٹر" }
 * Titles in older styles ("Fresh Carrots – 1kg | تازہ گاجر") are read too;
 * anything unreadable returns unit null and the existing unit is kept.
 */
function parseTitle(title) {
  const t = String(title || "").trim();
  const [left, ...rest] = t.split("|");
  const urdu = rest.join("|").trim() || null;
  const m = left.match(/^(.*?)\s*[—–-]\s*([^—–-]+)$/);
  let name = left.trim();
  let unit = null;
  let pack = null;
  const tryUnit = (s) => {
    for (const u of UNITS) {
      const mm = String(s).trim().match(u.re);
      if (mm) return u.to(mm[1] ? Number(mm[1]) : null);
    }
    return null;
  };
  if (m) {
    const got = tryUnit(m[2]);
    if (got) { name = m[1].trim(); unit = got.unit; pack = got.pack; }
  }
  if (!unit) {
    // "Onions 1kg" style: unit glued to the end of the name
    const mm = left.match(/^(.*?)[\s|]+(\d+(?:\.\d+)?\s*(?:kg|g|gm|gms))\s*$/i);
    const got = mm && tryUnit(mm[2]);
    if (got) { name = mm[1].trim(); unit = got.unit; pack = got.pack; }
  }
  return { name, unit, pack, urdu };
}

/**
 * The one column this needs (products.meta_retailer_id) is added at start-up,
 * so there is no database step to run by hand. Additive and idempotent.
 */
async function ensureSchema(db) {
  await db.query(`ALTER TABLE products ADD COLUMN IF NOT EXISTS meta_retailer_id TEXT`);
  await db.query(`CREATE UNIQUE INDEX IF NOT EXISTS products_meta_retailer_id_key
                    ON products (meta_retailer_id) WHERE meta_retailer_id IS NOT NULL`);
}

const CATEGORY = (productType) =>
  /fruit|phal/i.test(String(productType || "")) ? "phal" : "sabziyaan";

/**
 * Write one Shopify product (webhook/REST shape, or the same shape posted by
 * the inbox) into products. Only the first variant is used: every ASB product
 * has a single "Default Title" variant.
 * Returns the saved row, or null when the product has no variant or is a
 * Community product (see community/registry.js).
 */
async function upsertFromShopify(db, p) {
  // Community products never enter `products` (the grocery catalogue, the
  // inbox order panel, the Meta catalogue). They are kept in the Community
  // registry instead - registering here too covers products posted by the
  // inbox rates screen, which do not pass through the webhook.
  const v = (p.variants || [])[0];
  if (!v || !v.id) return null;
  if (await communityRegistry.isCommunityProduct(db, p)) {
    // The inbox may post a subset of a product's variants, so this path never
    // marks unlisted variants absent (only webhooks/reconcile, which carry the
    // full product, do).
    await communityRegistry.upsertProduct(db, p, "product_sync", { markMissingAbsent: false });
    console.log(`[rates] "${p.title}" is a Community product - kept out of products and the catalogue`);
    return null;
  }
  const parsed = parseTitle(p.title);
  const price = v.price == null ? null : Number(v.price);
  const market = v.compare_at_price == null || v.compare_at_price === "" ? null : Number(v.compare_at_price);
  const active = String(p.status || "active").toLowerCase() === "active" && price > 0;
  const image = p.image?.src || (p.images || [])[0]?.src || null;

  const { rows } = await db.query(
    `INSERT INTO products (sku, name_en, name_ur, name_roman, category, unit, step_qty, min_qty,
                           is_weighed, shopify_product_id, shopify_variant_id, image_url,
                           is_active, asb_price, market_price)
     VALUES ($1, $2, $3, $2, $4, COALESCE($5::unit_type, 'kg'), COALESCE($6, 1), COALESCE($6, 1),
             COALESCE($5::text, 'kg') IN ('kg','g'), $7, $8, $9, $10, $11, $12)
     ON CONFLICT (shopify_variant_id) DO UPDATE SET
       name_en      = EXCLUDED.name_en,
       name_roman   = EXCLUDED.name_roman,
       name_ur      = COALESCE(EXCLUDED.name_ur, products.name_ur),
       category     = EXCLUDED.category,
       unit         = COALESCE($5::unit_type, products.unit),
       step_qty     = COALESCE($6, products.step_qty),
       min_qty      = COALESCE($6, products.min_qty),
       shopify_product_id = EXCLUDED.shopify_product_id,
       image_url    = COALESCE(EXCLUDED.image_url, products.image_url),
       is_active    = EXCLUDED.is_active,
       asb_price    = EXCLUDED.asb_price,
       market_price = EXCLUDED.market_price
     RETURNING id, sku, name_en, unit::text AS unit, min_qty, asb_price, market_price,
               is_active, meta_retailer_id`,
    [
      `SHP-${v.id}`, parsed.name, parsed.urdu, CATEGORY(p.product_type),
      parsed.unit, parsed.pack, String(p.id), String(v.id), image,
      active, price, market,
    ]
  );
  return rows[0];
}

// ---------------------------------------------------------------------------
// Meta catalogue
// ---------------------------------------------------------------------------

async function graph(method, path, { params, form } = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params || {})) url.searchParams.set(k, v);
  const init = { method, headers: { Authorization: `Bearer ${TOKEN}` } };
  if (form) {
    init.headers["Content-Type"] = "application/x-www-form-urlencoded";
    init.body = new URLSearchParams(form).toString();
  }
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(url, { ...init, signal: ctl.signal });
    const body = await res.json().catch(() => ({}));
    if (body.error) throw new Error(`(#${body.error.code}) ${body.error.message}`);
    if (!res.ok) throw new Error(`HTTP ${res.status} from Meta`);
    return body;
  } finally {
    clearTimeout(t);
  }
}

/** The catalogue the WhatsApp number shows. CATALOG_ID wins; else ask Meta. */
async function catalogId(db) {
  if (process.env.CATALOG_ID) return process.env.CATALOG_ID;
  const { rows } = await db.query(
    `SELECT payload->'order'->>'catalog_id' AS id FROM whatsapp_messages
      WHERE msg_type = 'order' AND payload->'order'->>'catalog_id' IS NOT NULL
      ORDER BY received_at DESC LIMIT 1`);
  if (rows[0]?.id) return rows[0].id;
  const waba = process.env.WABA_ID || "1506772514186139";
  const cats = await graph("GET", `/${waba}/product_catalogs`, { params: { fields: "id,name" } });
  return cats.data?.[0]?.id || null;
}

/** Every product in the catalogue, with its current prices. */
async function metaItems(catId) {
  const out = [];
  let next = null;
  let params = { fields: "id,retailer_id,name,price,sale_price,availability,currency", limit: "500" };
  for (let page = 0; page < 40; page++) {
    const body = next
      ? await fetch(next, { headers: { Authorization: `Bearer ${TOKEN}` } }).then((r) => r.json())
      : await graph("GET", `/${catId}/products`, { params });
    if (body.error) throw new Error(`(#${body.error.code}) ${body.error.message}`);
    out.push(...(body.data || []));
    next = body.paging?.next || null;
    if (!next) break;
    params = null;
  }
  return out;
}

const money = (n) => `${Number(n).toFixed(2)} PKR`;

/**
 * Push prices (and optionally names/availability) to the catalogue.
 * updates: [{ retailer_id, asb_price, market_price, name?, in_stock? }]
 * The bazaar rate goes in `price` and the ASB rate in `sale_price`, which the
 * WhatsApp shop shows as "~~Rs 400~~ Rs 150". With no bazaar rate the ASB
 * rate is the plain price.
 */
async function metaUpdate(catId, updates) {
  const requests = updates.map((u) => {
    const data = { id: String(u.retailer_id) };
    const asb = Number(u.asb_price);
    const mkt = u.market_price == null ? null : Number(u.market_price);
    if (asb > 0 && mkt > asb) { data.price = money(mkt); data.sale_price = money(asb); }
    else if (asb > 0) { data.price = money(asb); data.sale_price = ""; }
    if (u.name) data.title = u.name;
    if (u.in_stock != null) data.availability = u.in_stock ? "in stock" : "out of stock";
    return { method: "UPDATE", data };
  });
  const handles = [];
  for (let i = 0; i < requests.length; i += 500) {
    const body = await graph("POST", `/${catId}/items_batch`, {
      form: { item_type: "PRODUCT_ITEM", requests: JSON.stringify(requests.slice(i, i + 500)) },
    });
    handles.push(...(body.handles || []));
  }
  // Meta applies the batch in the background; wait briefly for the verdict.
  const results = [];
  for (const h of handles) {
    let status = null;
    for (let tries = 0; tries < 10; tries++) {
      await new Promise((r) => setTimeout(r, 1500));
      const s = await graph("GET", `/${catId}/check_batch_request_status`, { params: { handle: h } });
      status = s.data?.[0] || s;
      if (status.status && status.status !== "started" && status.status !== "dispatched") break;
    }
    results.push({ handle: h, status: status?.status || "unknown", errors: status?.errors || [],
                   warnings: status?.warnings || [] });
  }
  return { sent: requests.length, results };
}

/**
 * After a product changed: if it is linked to the catalogue, send its new
 * prices there. Never throws - a Meta hiccup must not break the webhook.
 */
async function pushOne(db, row) {
  if (!row?.meta_retailer_id || !TOKEN) return null;
  try {
    const catId = await catalogId(db);
    if (!catId) return null;
    const r = await metaUpdate(catId, [{
      retailer_id: row.meta_retailer_id, asb_price: row.asb_price, market_price: row.market_price,
      in_stock: row.is_active,
    }]);
    const errs = r.results.flatMap((x) => x.errors);
    if (errs.length) console.error(`[rates] catalogue update for ${row.name_en} had errors:`, JSON.stringify(errs).slice(0, 300));
    else console.log(`[rates] catalogue: ${row.name_en} -> Rs ${Number(row.asb_price)}` +
      (row.market_price ? ` (bazaar ${Number(row.market_price)})` : ""));
    return r;
  } catch (e) {
    console.error(`[rates] catalogue update for ${row.name_en} failed: ${e.message}`);
    return null;
  }
}

/** The whole Shopify webhook step: save, then pass the price on. */
async function fromShopifyWebhook(db, product) {
  const row = await upsertFromShopify(db, product);
  if (!row) return null;
  console.log(`[rates] ${row.name_en}: Rs ${Number(row.asb_price)}` +
    (row.market_price ? ` (bazaar ${Number(row.market_price)})` : "") +
    ` · ${row.is_active ? "on sale" : "not on sale"}`);
  await pushOne(db, row);
  return row;
}

module.exports = {
  ensureSchema, parseTitle, upsertFromShopify, fromShopifyWebhook, pushOne,
  catalogId, metaItems, metaUpdate,
};
