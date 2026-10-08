// ============================================================================
// Test harness: a real Postgres database per test process, the real
// migrations, the real Express app - with the outside world (Meta, Shopify)
// stubbed out. Nothing here talks to production.
//
//   TEST_PG_URL   base server URL, default postgres://postgres@localhost:54330
// ============================================================================

"use strict";

const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { Client } = require("pg");

const BASE = process.env.TEST_PG_URL || "postgres://postgres@localhost:54330";
const SHOPIFY_SECRET = "test-shopify-secret";
const META_SECRET = "test-meta-secret";
const SHOP = "0du4xf-6j.myshopify.com";

async function adminQuery(sql) {
  const c = new Client({ connectionString: `${BASE}/postgres` });
  await c.connect();
  try { return await c.query(sql); } finally { await c.end(); }
}

/** Fresh database, migrated by THAT repo's own migration runner. */
async function createDatabase(name, repoDir) {
  await adminQuery(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await adminQuery(`CREATE DATABASE ${name}`);
  const url = `${BASE}/${name}`;
  execFileSync(process.execPath, [path.join(repoDir, "scripts", "migrate.js")], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
  return url;
}

/** Env every test process sets before requiring the app. */
function setEnv(url) {
  Object.assign(process.env, {
    DATABASE_URL: url,
    SHOPIFY_WEBHOOK_SECRET: SHOPIFY_SECRET,
    META_APP_SECRET: META_SECRET,
    WHATSAPP_TOKEN: "test-token",
    PHONE_NUMBER_ID: "000000",
    COMMUNITY_INTAKE_WORKER: "off",   // tests drive the worker explicitly
    PORT: process.env.PORT || "0",
  });
}

/**
 * Stub every outbound call. fetch to anything but localhost throws, and the
 * WhatsApp client records what WOULD have been sent.
 */
function stubOutside(repoDir) {
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.startsWith("http://127.0.0.1") || u.startsWith("http://localhost")) return realFetch(url, init);
    throw new Error(`network blocked in tests: ${u.slice(0, 80)}`);
  };
  const wa = require(path.join(repoDir, "whatsapp.js"));
  const sent = [];
  let n = 0;
  wa.sendText = async (phone, text) => {
    sent.push({ kind: "text", phone, text });
    return { ok: true, wamid: `wamid.TEST${++n}`, data: {}, code: null };
  };
  wa.sendTemplate = async (phone, name, params, opts) => {
    sent.push({ kind: "template", phone, name, params, lang: opts?.lang || null });
    return { ok: true, wamid: `wamid.TEST${++n}`, data: {}, code: null };
  };
  wa.markRead = async () => ({ ok: true });
  return sent;
}

// topic: null / shop: null omit that header entirely.
function shopifyHeaders(body, { topic, id, shop = SHOP }) {
  const hmac = crypto.createHmac("sha256", SHOPIFY_SECRET).update(body).digest("base64");
  const h = {
    "Content-Type": "application/json",
    "X-Shopify-Hmac-Sha256": hmac,
    "X-Shopify-Webhook-Id": id,
  };
  if (topic !== null) h["X-Shopify-Topic"] = topic;
  if (shop !== null) h["X-Shopify-Shop-Domain"] = shop;
  return h;
}

async function postShopify(base, payload, { topic = "orders/create", id, shop = SHOP } = {}) {
  const body = Buffer.from(JSON.stringify(payload));
  const res = await fetch(`${base}/webhooks/shopify`, {
    method: "POST", headers: shopifyHeaders(body, { topic, id, shop }), body,
  });
  return res.status;
}

async function postWhatsApp(base, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  const sig = "sha256=" + crypto.createHmac("sha256", META_SECRET).update(body).digest("hex");
  const res = await fetch(`${base}/webhooks/whatsapp`, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Hub-Signature-256": sig }, body,
  });
  return res.status;
}

async function waitFor(fn, { timeoutMs = 8000, everyMs = 40 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/** Wait until the webhook_events row for this delivery is closed out. */
function waitWebhookDone(db, source, eventId) {
  return waitFor(async () => {
    const { rows } = await db.query(
      `SELECT status FROM webhook_events WHERE source = $1 AND event_id = $2`, [source, eventId]);
    return rows[0] && rows[0].status !== "received" ? rows[0].status : null;
  });
}

// ---------------------------------------------------------------------------
// Fixtures shared by every scenario
// ---------------------------------------------------------------------------

/** Two grocery products, plus one LEGACY products row for a Community variant
 *  (the 17 such rows exist in production, inactive, category 'community-excluded'). */
const FIXTURE_SQL = `
  INSERT INTO products (sku, name_en, name_ur, category, unit, step_qty, min_qty, is_weighed,
                        shopify_product_id, shopify_variant_id, is_active, asb_price, market_price)
  VALUES
   ('ASB-VEG-001', 'Aloo White', 'آلو', 'sabziyaan', 'kg', 1, 1, true, '9000000000001', '47000000000001', true, 50, 60),
   ('ASB-FRT-001', 'Chonsa Aam', 'آم', 'phal', 'kg', 1, 1, true, '9000000000002', '47000000000002', true, 250, 350),
   ('SHP-50595473817858', 'Payaz — Community Deal', NULL, 'community-excluded', 'kg', 1, 1, true,
    '10341692014850', '50595473817858', false, 700, NULL);
`;

const GROCERY = {
  aloo:  { variant_id: 47000000000001, product_id: 9000000000001, sku: "ASB-VEG-001", title: "Aloo White — 1 kg | آلو", price: "50.00" },
  mango: { variant_id: 47000000000002, product_id: 9000000000002, sku: "ASB-FRT-001", title: "Chonsa Aam — 1 kg | آم", price: "250.00" },
};

// Exact ids from the 2026-10-08 registry snapshot.
const COMMUNITY = {
  onion5Draft:    { variant_id: 50595473817858, product_id: 10341692014850, sku: "ASB-COM-DEMO-ONION-5KG", title: "Payaz — Community Deal", variant_title: "5 kg", price: "700.00" },
  tomato10Draft:  { variant_id: 50595474014466, product_id: 10341692113154, sku: "ASB-COM-DEMO-TOMATO-10KG", title: "Tamatar — Community Deal", variant_title: "10 kg", price: "1300.00" },
  onion5Archived: { variant_id: 50595412640002, product_id: 10341680578818, sku: "ASB-COM-DEMO-ONION-5KG", title: "ASB Community Bulk Deals — DEMO 5 Oct 2026", variant_title: "Onion 5 kg", price: "700.00" },
};

let lineSeq = 1000;
function line(base, quantity = 1) {
  return { id: 16000000000000 + ++lineSeq, quantity, vendor: "Apna Sasta Bazaar", ...base };
}

function shopifyOrder({ id, name, lines, phone = "+92 300 1234567", first = "Ayesha", createdAt = "2026-10-08T06:00:00+05:00" }) {
  return {
    id, name, created_at: createdAt, total_price: String(lines.reduce((s, l) => s + Number(l.price) * l.quantity, 0) + 150),
    note: null, phone: null,
    customer: { id: 7700000000000 + (id % 1000), first_name: first, last_name: "Test", phone: null },
    shipping_address: { first_name: first, last_name: "Test", phone, address1: "Flat 4", address2: "Block 13" },
    line_items: lines,
  };
}

module.exports = {
  BASE, SHOP, createDatabase, setEnv, stubOutside, postShopify, postWhatsApp,
  waitFor, waitWebhookDone, FIXTURE_SQL, GROCERY, COMMUNITY, line, shopifyOrder, adminQuery,
};
