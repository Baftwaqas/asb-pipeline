// Orders without a human (founder, 19 Nov 2026): "order" -> how? -> the
// WhatsApp product list / repeat last order / a catalogue cart -> she checks
// the order -> Theek hai -> a real order (same path as the inbox), once.
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const H = require("./support/harness");

const ROOT = path.join(__dirname, "..");
let db, server, base, sent, O;
let n = 0;
const hook = (phone, message) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "1", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", contacts: [{ wa_id: phone, profile: { name: "Ayesha" } }],
    messages: [{ from: phone, id: `wamid.ao${++n}`, timestamp: String(Math.floor(Date.now() / 1000)), ...message }],
  } }] }],
});
const say = (p, text) => H.postWhatsApp(base, hook(p, { type: "text", text: { body: text } }));
const tap = (p, id, title = "x") => H.postWhatsApp(base, hook(p, { type: "interactive", interactive: { type: "button_reply", button_reply: { id, title } } }));
const cart = (p, items) => H.postWhatsApp(base, hook(p, { type: "order", order: { catalog_id: "CAT1", product_items: items } }));
const to = (p) => sent.filter((s) => s.phone === p);
const wait = (p, k) => H.waitFor(async () => to(p).length >= k);

before(async () => {
  const url = await H.createDatabase("asb_t_autoorder", ROOT);
  H.setEnv(url);
  Object.assign(process.env, { ORDER_BOT: "on", RATELIST_BOT: "on", AREA_BOT: "off", CATALOG_ID: "CAT1" });
  sent = H.stubOutside(ROOT);
  const wa = require(path.join(ROOT, "whatsapp.js"));
  let k = 0;
  const ok = () => ({ ok: true, wamid: `wamid.X${++k}`, data: {} });
  wa.sendButtons = async (phone, text, buttons) => { sent.push({ kind: "buttons", phone, text, buttons }); return ok(); };
  wa.sendList = async (phone, text, button, rows) => { sent.push({ kind: "list", phone, text, rows }); return ok(); };
  wa.sendProductList = async (phone, header, text, cat, sections) => { sent.push({ kind: "products", phone, text, cat, sections }); return ok(); };
  wa.sendCatalog = async (phone, text) => { sent.push({ kind: "catalog", phone, text }); return ok(); };
  const mod = require(path.join(ROOT, "server.js"));
  db = require(path.join(ROOT, "db"));
  O = require(path.join(ROOT, "autoorder.js"));
  await require(path.join(ROOT, "productSync.js")).ensureSchema(db);
  await db.query(H.FIXTURE_SQL);
  await db.query(`INSERT INTO products (sku, name_en, category, unit, step_qty, min_qty, shopify_variant_id, is_active, asb_price, market_price, meta_retailer_id) VALUES
    ('T1', 'Tamatar', 'sabziyaan', 'kg', 0.5, 0.5, 'v1', true, 99, 200, 'RT1'),
    ('T2', 'Pakora Mirch', 'sabziyaan', 'g', 250, 250, 'v2', true, 15, 60, 'RT2'),
    ('T3', 'Kinno', 'phal', 'pcs', 1, 1, 'v3', true, 39, 42, 'RT3'),
    ('T4', 'Gone Item', 'sabziyaan', 'kg', 1, 1, 'v4', false, 10, 20, 'RT4')`);
  server = mod.app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.close(); await new Promise((r) => setTimeout(r, 200)); await db?.shutdown(); });

test("what counts as wanting to order", () => {
  for (const t of ["order", "Order karna hai", "aarder", "mujhe order", "saman mangwana"]) assert.ok(O.isAsk(t), t);
  for (const t of ["2 kg aloo", "order kab aayega?", "mera order kahan hai", "rate list"]) assert.ok(!O.isAsk(t), t);
});

test("new customer: 'order' -> List / Likh kar; the list is WhatsApp's own product list", async () => {
  const p = "923009000001";
  await say(p, "order");
  await wait(p, 1);
  assert.deepEqual(to(p)[0].buttons.map((b) => b.id), ["order:list", "order:write"]);
  await tap(p, "order:list");
  await wait(p, 3);
  const pl = to(p)[1];
  assert.equal(pl.kind, "products");
  assert.equal(pl.cat, "CAT1");
  const ids = pl.sections.flatMap((s) => s.product_items.map((x) => x.product_retailer_id));
  assert.ok(ids.includes("RT1") && ids.includes("RT3"));
  assert.ok(!ids.includes("RT4"), "not for sale");
  assert.equal(to(p)[2].kind, "catalog");
});

test("a cart -> she checks it -> Theek hai -> a real order and the usual confirmation, once", async () => {
  const p = "923009000002";
  await cart(p, [{ product_retailer_id: "RT1", quantity: 2 }, { product_retailer_id: "RT2", quantity: 1 }, { product_retailer_id: "RT4", quantity: 1 }]);
  await wait(p, 1);
  const c = to(p)[0];
  assert.equal(c.kind, "buttons");
  assert.match(c.text, /Aap ka order:[\s\S]*Tamatar — 1 kg — Rs 198[\s\S]*Pakora Mirch — (250 g|pao) — Rs 15[\s\S]*Total: \*Rs 213\*/);
  assert.match(c.text, /abhi available nahi/, "the item no longer for sale is dropped and said so");
  const okId = c.buttons[0].id;
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM orders`)).rows[0].n, 0, "nothing saved before she confirms");

  await tap(p, okId, "✅ Theek hai");
  await wait(p, 2);
  assert.match(to(p)[1].text, /Aap ka order mil gaya — \*[A-Z0-9-]+\*/);
  const o = (await db.query(`SELECT o.id, o.channel::text AS ch FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.phone = $1`, [p])).rows;
  assert.equal(o.length, 1);
  const items = (await db.query(`SELECT p.sku, oi.qty_ordered::float AS q FROM order_items oi JOIN products p ON p.id = oi.product_id WHERE oi.order_id = $1 ORDER BY p.sku`, [o[0].id])).rows;
  assert.deepEqual(items.map((r) => [r.sku, r.q]), [["T1", 2], ["T2", 1]]);

  // tapping again does not save it twice
  await tap(p, okId, "✅ Theek hai");
  await wait(p, 3);
  assert.match(to(p)[2].text, /pehle hi confirm/);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN customers c ON c.id = o.customer_id WHERE c.phone = $1`, [p])).rows[0].n, 2);
});

test("'Badlein' saves nothing and offers the list again", async () => {
  const p = "923009000003";
  await cart(p, [{ product_retailer_id: "RT3", quantity: 6 }]);
  await wait(p, 1);
  const editId = to(p)[0].buttons[1].id;
  await tap(p, editId, "✏️ Badlein");
  await wait(p, 2);
  assert.deepEqual(to(p)[1].buttons.map((b) => b.id), ["order:list", "order:write"]);
  assert.equal((await db.query(`SELECT status FROM order_drafts WHERE id = $1`, [Number(editId.split(":")[2])])).rows[0].status, "changed");
  // the old Theek hai no longer works
  await tap(p, to(p)[0].buttons[0].id, "✅ Theek hai");
  await wait(p, 3);
  assert.match(to(p)[2].text, /purana order tha/);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.phone = $1`, [p])).rows[0].n, 0);
});

test("repeat last order: shown at today's prices, then confirmed", async () => {
  const p = "923009000002";   // ordered above
  await say(p, "order karna hai");
  await wait(p, 4);
  assert.deepEqual(to(p)[3].buttons.map((b) => b.id), ["order:repeat", "order:list", "order:write"]);
  await db.query(`UPDATE products SET asb_price = 90 WHERE sku = 'T1'`);   // today's price changed
  await tap(p, "order:repeat");
  await wait(p, 5);
  assert.match(to(p)[4].text, /Tamatar — 1 kg — Rs 180/);
});

test("the rate-list menu ends with 'Order karein'; choosing it starts an order", async () => {
  const p = "923009000004";
  await say(p, "rate list");
  await wait(p, 1);
  assert.equal(to(p)[0].rows.at(-1).id, "ratelist:order");
  await H.postWhatsApp(base, hook(p, { type: "interactive", interactive: { type: "list_reply", list_reply: { id: "ratelist:order", title: "🛒 Order karein" } } }));
  await wait(p, 2);
  assert.deepEqual(to(p)[1].buttons.map((b) => b.id), ["order:list", "order:write"]);
});

test("switch off: carts are left for the team as before", async () => {
  process.env.ORDER_BOT = "off";
  const p = "923009000005";
  await cart(p, [{ product_retailer_id: "RT1", quantity: 1 }]);
  await new Promise((r) => setTimeout(r, 250));
  assert.equal(to(p).length, 0);
  process.env.ORDER_BOT = "on";
});
