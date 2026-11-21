"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const { plan, createData, titleOf, packLabel } = require(path.join(ROOT, "catalogPlan.js"));

const P = (id, name, extra = {}) => ({
  id, sku: `SHP-${id}`, name_en: name, name_roman: name, name_ur: null, unit: "kg", min_qty: 1,
  asb_price: 100, market_price: 150, is_active: true, image_url: `https://img/${id}.jpg`,
  shopify_variant_id: String(id), shopify_handle: null, meta_retailer_id: null, ...extra,
});
const M = (rid, name) => ({ retailer_id: rid, name, availability: "in stock" });

test("linked, add, link, orphans and problems are told apart", () => {
  const products = [
    P(1, "Tamatar", { meta_retailer_id: "m1" }),
    P(2, "Chicken Mix Boti"),
    P(3, "Adrak", { unit: "g", min_qty: 250 }),
    P(4, "Aloo Lal"),
    P(5, "Amla", { image_url: null }),
    P(6, "Old thing", { is_active: false }),
  ];
  const items = [M("m1", "Tamatar 1kg"), M("m2", "Adrak 1kg"), M("m3", "Aloo"), M("m4", "Falsa")];
  const r = plan(products, items);
  assert.equal(r.counts.linked, 1);
  assert.deepEqual(r.link.map((l) => [l.product, l.retailer_id, l.pack_differs]), [["Adrak", "m2", true]]);
  assert.deepEqual(r.add.map((a) => a.product).sort(), ["Aloo Lal", "Chicken Mix Boti"]);
  assert.deepEqual(r.problems.map((p) => [p.product, p.why]), [["Amla", ["no picture"]]]);
  // "Aloo" is not silently taken as "Aloo Lal" - it is left over, with a hint.
  const aloo = r.orphans.find((o) => o.retailer_id === "m3");
  assert.equal(aloo.maybe.product, "Aloo Lal");
  assert.equal(aloo.maybe.score, 0.5);
  assert.equal(r.orphans.find((o) => o.retailer_id === "m4").maybe, null);
});

test("each catalogue item is joined to one product only, best match first", () => {
  const r = plan([P(1, "Kinnow"), P(2, "Kinnow Special")], [M("k", "Kinnow (Dozen)")]);
  assert.deepEqual(r.link.map((l) => l.product), ["Kinnow"]);
  assert.deepEqual(r.add.map((a) => a.product), ["Kinnow Special"]);
});

test("titles and packs read the way people talk", () => {
  assert.equal(packLabel("g", 500), "500 gm");
  assert.equal(packLabel("g", 1000), "1 kg");
  assert.equal(packLabel("dozen", 1), "1 darjan");
  assert.equal(titleOf(P(1, "Eggs", { unit: "dozen" })), "Eggs — 1 darjan");
});

test("a new catalogue item carries the bazaar rate struck through and our sku as its id", () => {
  const d = createData(P(9, "Chicken Boneless", { name_ur: "چکن", shopify_handle: "chicken-boneless" }),
    { storeUrl: "https://shop.example/" });
  assert.equal(d.id, "SHP-9");
  assert.equal(d.price, "150.00 PKR");
  assert.equal(d.sale_price, "100.00 PKR");
  assert.equal(d.link, "https://shop.example/products/chicken-boneless");
  assert.equal(d.availability, "in stock");
  assert.match(d.description, /چکن/);
  for (const k of ["title", "description", "availability", "condition", "brand", "image_link", "link", "price"]) {
    assert.ok(d[k], k);
  }
  const noBazaar = createData(P(9, "X", { market_price: null }));
  assert.equal(noBazaar.price, "100.00 PKR");
  assert.equal(noBazaar.sale_price, undefined);
});

test("metaCreate links only the items Meta accepted", async () => {
  process.env.WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "t";
  delete require.cache[require.resolve(path.join(ROOT, "productSync.js"))];
  const productSync = require(path.join(ROOT, "productSync.js"));
  const sent = [];
  const realFetch = global.fetch;
  const realTimeout = global.setTimeout;
  global.setTimeout = (fn) => realTimeout(fn, 0);
  global.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("items_batch")) {
      sent.push(JSON.parse(new URLSearchParams(init.body).get("requests")));
      return { ok: true, json: async () => ({ handles: ["h1"] }) };
    }
    return { ok: true, json: async () => ({ data: [{ status: "finished",
      errors: [{ id: "SHP-2", message: "image too small" }] }] }) };
  };
  const updates = [];
  const db = { query: async (sql, params) => { updates.push(params); return { rows: [] }; } };
  try {
    const r = await productSync.metaCreate(db, "cat", [P(1, "Eggs"), P(2, "Amla")]);
    assert.equal(sent[0].length, 2);
    assert.equal(sent[0][0].method, "CREATE");
    assert.deepEqual(r.linked, ["SHP-1"]);
    assert.deepEqual(r.failed, ["SHP-2"]);
    assert.deepEqual(updates, [["SHP-1", "1"]]);
  } finally {
    global.fetch = realFetch;
    global.setTimeout = realTimeout;
  }
});
