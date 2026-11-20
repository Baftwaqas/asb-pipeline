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
  await wait(p, 2);
  const pl = to(p)[1];
  assert.equal(pl.kind, "products");
  assert.equal(pl.cat, "CAT1");
  const ids = pl.sections.flatMap((s) => s.product_items.map((x) => x.product_retailer_id));
  assert.ok(ids.includes("RT1") && ids.includes("RT3"));
  assert.ok(!ids.includes("RT4"), "not for sale");
  assert.match(pl.text, /sab items/);
  // one list only; the whole catalogue only when she asks
  await new Promise((r) => setTimeout(r, 150));
  assert.equal(to(p).length, 2);
  await say(p, "sab items");
  await wait(p, 3);
  assert.equal(to(p)[2].kind, "catalog");
});

// ---------------------------------------------------------------------------
// Typed orders, read by the AI (a fake model here; the real one in Render).
// ---------------------------------------------------------------------------
let aiReply = null, aiCalls = 0;
test("typed order -> the AI reads it -> the same confirmation -> Theek hai -> a real order", async () => {
  Object.assign(process.env, { ORDER_AI_PROVIDER: "groq", GROQ_API_KEY: "test-only", GROQ_MODEL: "test-model" });
  const realFetch = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).includes("api.groq.com")) {
      aiCalls++;
      const body = JSON.parse(init.body);
      assert.match(body.messages[1].content, /T1 \| Tamatar/);   // our list goes to the model
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(aiReply) } }] }), { status: 200 });
    }
    return realFetch(url, init);
  };
  try {
    const p = "923009000010";
    await say(p, "order");
    await wait(p, 1);
    await tap(p, "order:write");
    await wait(p, 2);
    assert.match(to(p)[1].text, /Apni list likh dein/);
    assert.doesNotMatch(to(p)[1].text, /team/);
    aiReply = { items: [
      { sku: "T1", qty: 1, unit: "kg", said: "1 kilo tamatar" },        // 500 g packs -> 2
      { sku: "T2", qty: 0.5, unit: "kg", said: "aadha kilo pakora mirch" },  // 250 g packs -> 2
      { sku: "FAKE", qty: 1, unit: "kg", said: "1 kg made up" },         // invented sku -> dropped
    ], unknown: ["2 kg chicken"], unclear: ["thoda dhania"] };
    await say(p, "1 kilo tamatar, aadha kilo pakora mirch, 2 kg chicken, thoda dhania");
    await wait(p, 3);
    const c = to(p)[2];
    assert.equal(c.kind, "buttons");
    assert.match(c.text, /Ye abhi hamare paas nahi: 2 kg chicken\. Hum ne note kar liya hai/);
    const miss = (await db.query(`SELECT item, source FROM missing_items WHERE phone = $1`, [p])).rows;
    assert.deepEqual(miss, [{ item: "2 kg chicken", source: "typed" }]);
    assert.match(c.text, /samajh nahi aaya[\s\S]*thoda dhania[\s\S]*1 kg made up/);
    assert.match(c.text, /Tamatar — 1 kg — Rs 198/);
    assert.doesNotMatch(c.text, /adhoora nahi milta/);
    assert.match(c.text, /Pakora Mirch — aadha kg — Rs 30/);
    await tap(p, c.buttons[0].id, "✅ Theek hai");
    await wait(p, 4);
    assert.match(to(p)[3].text, /Aap ka order mil gaya/);
    const src = (await db.query(`SELECT source, status FROM order_drafts WHERE phone = $1 ORDER BY id DESC LIMIT 1`, [p])).rows[0];
    assert.deepEqual([src.source, src.status], ["typed", "confirmed"]);

    // chatter is not sent to the AI; a message with quantities is
    const before = aiCalls;
    await say(p, "shukriya bhai");
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(aiCalls, before);
    // AI finds nothing in a non-order message with a number: silence, the team sees it
    aiReply = { items: [], unknown: [], unclear: [] };
    await say(p, "kal 5 baje aa jana");
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(to(p).length, 4);
  } finally {
    global.fetch = realFetch;
  }
});

test("pack arithmetic is done in code, not by the AI", () => {
  const TD = require(path.join(ROOT, "typedorder.js"));
  assert.equal(TD.packsFor({ unit: "kg", min_qty: 0.5 }, 2, "kg"), 4);
  assert.equal(TD.packsFor({ unit: "kg", min_qty: 1 }, 0.5, "kg"), 0.5);     // any quantity: half a pack
  assert.equal(TD.packsFor({ unit: "g", min_qty: 250 }, 1, "pao"), 1);
  assert.equal(TD.packsFor({ unit: "g", min_qty: 250 }, 1, "kg"), 4);
  assert.equal(TD.packsFor({ unit: "bundle", min_qty: 1 }, 2, "gaddi"), 2);
  assert.equal(TD.packsFor({ unit: "kg", min_qty: 1 }, 3, "piece"), null);   // "3 tamatar" by the piece: ask
  assert.ok(TD.looksLikeOrder("2kg aloo"));
  assert.ok(TD.looksLikeOrder("aadha kilo adrak"));
  assert.ok(!TD.looksLikeOrder("shukriya bhai"));
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
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.phone = $1`, [p])).rows[0].n, 0, "nothing saved before she confirms");

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

test("'Badlein' without the AI: saves nothing and offers the list again", async () => {
  delete process.env.GROQ_API_KEY;
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

test("'Badlein' with the AI: she types only the change, the rest of her order stays", async () => {
  Object.assign(process.env, { ORDER_AI_PROVIDER: "groq", GROQ_API_KEY: "test-only", GROQ_MODEL: "test-model" });
  const realFetch = global.fetch;
  let lastPrompt = "", reply = null;
  global.fetch = async (url, init) => {
    if (String(url).includes("api.groq.com")) {
      const body = JSON.parse(init.body);
      lastPrompt = body.messages[0].content + "\n" + body.messages[1].content;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(reply) } }] }), { status: 200 });
    }
    return realFetch(url, init);
  };
  try {
    const p = "923009000011";
    await cart(p, [{ product_retailer_id: "RT1", quantity: 2 }, { product_retailer_id: "RT3", quantity: 6 }]);
    await wait(p, 1);
    assert.match(to(p)[0].text, /Tamatar — 1 kg/);
    await tap(p, to(p)[0].buttons[1].id, "✏️ Badlein");
    await wait(p, 2);
    assert.match(to(p)[1].text, /Poora order dobara likhne ki zaroorat nahi/);

    // "tamatar 2 kg kar dein, kinno hata dein" — no quantity words needed for removals
    reply = { items: [{ sku: "T1", qty: 2, unit: "kg", said: "tamatar 2 kg" }], unknown: [], unclear: [] };
    await say(p, "tamatar 2 kg kar dein, kinno hata dein");
    await wait(p, 3);
    assert.match(lastPrompt, /EDIT MODE/);
    assert.match(lastPrompt, /CURRENT ORDER[\s\S]*T1 \| Tamatar \| 1 kg[\s\S]*T3 \| Kinno \| 6 pcs/);
    const c = to(p)[2];
    assert.equal(c.kind, "buttons");
    assert.match(c.text, /Tamatar — 2 kg/);
    assert.doesNotMatch(c.text, /Kinno/);
    await tap(p, c.buttons[0].id, "✅ Theek hai");
    await wait(p, 4);
    assert.match(to(p)[3].text, /Aap ka order mil gaya/);

    // removing everything: no empty order
    await cart(p, [{ product_retailer_id: "RT3", quantity: 2 }]);
    await wait(p, 5);
    await tap(p, to(p)[4].buttons[1].id, "✏️ Badlein");
    await wait(p, 6);
    reply = { items: [], unknown: [], unclear: [] };
    await say(p, "sab hata dein");
    await wait(p, 7);
    assert.match(to(p)[6].text, /sab items nikal diye/);
  } finally {
    global.fetch = realFetch;
    delete process.env.GROQ_API_KEY;
  }
});

test("only things we don't sell: 'abhi hamare paas nahi', recorded, and the founder sees the most-asked list", async () => {
  Object.assign(process.env, { ORDER_AI_PROVIDER: "groq", GROQ_API_KEY: "test-only", GROQ_MODEL: "test-model" });
  const realFetch = global.fetch;
  global.fetch = async (url, init) => String(url).includes("api.groq.com")
    ? new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ items: [], unknown: ["Chicken", "doodh"], unclear: [] }) } }] }), { status: 200 })
    : realFetch(url, init);
  try {
    const p = "923009000012";
    await say(p, "order");
    await wait(p, 1);
    await tap(p, "order:write");
    await wait(p, 2);
    await say(p, "2 kg chicken aur 1 litre doodh");
    await wait(p, 3);
    assert.match(to(p)[2].text, /abhi hamare paas nahi: Chicken, doodh\. Hum ne note kar liya hai/);
    const rep = await O.missingReport(db, 7);
    const chicken = rep.find((r) => r.item === "chicken");
    assert.equal(chicken.people, 1);
    assert.ok(rep.find((r) => r.item === "doodh"));
  } finally {
    global.fetch = realFetch;
    delete process.env.GROQ_API_KEY;
  }
});

test("same delivery day: she is asked first - ➕ Usi mein shamil (told it joined) or 🧾 Alag bill (her own bill, same number)", async () => {
  delete process.env.GROQ_API_KEY;
  const p = "923009000013";
  // first order
  await cart(p, [{ product_retailer_id: "RT1", quantity: 2 }]);
  await wait(p, 1);
  await tap(p, to(p)[0].buttons[0].id, "✅ Theek hai");
  await wait(p, 2);
  assert.match(to(p)[1].text, /Aap ka order mil gaya/);
  const first = /\*(ASB-\d+)\*/.exec(to(p)[1].text)[1];

  // second order, same delivery: asked before anything is saved
  await cart(p, [{ product_retailer_id: "RT3", quantity: 6 }]);
  await wait(p, 3);
  await tap(p, to(p)[2].buttons[0].id, "✅ Theek hai");
  await wait(p, 4);
  const ask = to(p)[3];
  assert.equal(ask.kind, "buttons");
  assert.match(ask.text, new RegExp(`order \\*${first}\\* pehle se hai`));
  assert.deepEqual(ask.buttons.map((b) => b.title), ["➕ Usi mein shamil", "🧾 Alag bill"]);
  const n = async () => (await db.query(
    `SELECT count(*)::int AS n FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.phone = $1 AND o.status <> 'cancelled'`, [p])).rows[0].n;
  assert.equal(await n(), 1);

  // ➕ joins the first order, and she is told so
  await tap(p, ask.buttons[0].id, "➕ Usi mein shamil");
  await wait(p, 5);
  assert.match(to(p)[4].text, new RegExp(`^✅ Ye items aap ke order \\*${first}\\* mein shamil kar diye`));
  assert.equal(await n(), 1);

  // third order: 🧾 Alag bill -> her name -> a separate order and bill on the same number
  await cart(p, [{ product_retailer_id: "RT2", quantity: 1 }]);
  await wait(p, 6);
  await tap(p, to(p)[5].buttons[0].id, "✅ Theek hai");
  await wait(p, 7);
  await tap(p, to(p)[6].buttons[1].id, "🧾 Alag bill");
  await wait(p, 8);
  assert.match(to(p)[7].text, /alag bill kis naam se/);
  await say(p, "Ayesha — padosan");
  await wait(p, 9);
  const billMsg = to(p)[8].text;
  assert.match(billMsg, /Aap ka order mil gaya/);
  assert.match(billMsg, /Alag bill: \*Ayesha — padosan\*/);
  assert.doesNotMatch(billMsg, /mein shamil kar diye/);
  assert.equal(await n(), 2);
  const labels = (await db.query(
    `SELECT o.bill_label FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.phone = $1 ORDER BY o.id`, [p])).rows.map((r) => r.bill_label);
  assert.deepEqual(labels, [null, "Ayesha — padosan"]);
});
