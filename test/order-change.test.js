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
  const url = await H.createDatabase("asb_t_orderchange", ROOT);
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

const S = require(path.join(ROOT, "schedule.js"));
let aiReply = null, aiPrompt = "";
function fakeAI() {
  Object.assign(process.env, { ORDER_AI_PROVIDER: "groq", GROQ_API_KEY: "test-only", GROQ_MODEL: "test-model" });
  const real = global.fetch;
  global.fetch = async (url, init) => {
    if (String(url).includes("api.groq.com")) {
      const b = JSON.parse(init.body); aiPrompt = b.messages[0].content + "\n" + b.messages[1].content;
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(aiReply) } }] }), { status: 200 });
    }
    return real(url, init);
  };
  return () => { global.fetch = real; delete process.env.GROQ_API_KEY; };
}
const items = async (p) => (await db.query(
  `SELECT p.sku, oi.qty_ordered::float AS q FROM order_items oi JOIN products p ON p.id = oi.product_id
     JOIN orders o ON o.id = oi.order_id JOIN customers c ON c.id = o.customer_id
    WHERE c.phone = $1 AND o.status <> 'cancelled' ORDER BY p.sku`, [p])).rows.map((r) => [r.sku, r.q]);
async function placed(p, rid, qty) {
  const n0 = to(p).length;
  await cart(p, [{ product_retailer_id: rid, quantity: qty }]);
  await wait(p, n0 + 1);
  await tap(p, to(p)[n0].buttons[0].id, "✅ Theek hai");
  await wait(p, n0 + 2);
  return to(p)[n0 + 1];
}

test("cut-off is 9pm Karachi: Sunday 8:59pm -> Monday, Sunday 9:00pm -> Thursday; Wednesday 9pm closes Thursday", () => {
  assert.equal(S.CUTOFF_HOUR, 21);
  assert.equal(S.deliveryFor(new Date("2026-11-22T15:59:59Z")).deliveryDay, "Monday");    // Sun 20:59:59 PKT
  assert.equal(S.deliveryFor(new Date("2026-11-22T16:00:00Z")).deliveryDay, "Thursday");  // Sun 21:00 PKT
  assert.equal(S.deliveryFor(new Date("2026-11-25T15:59:59Z")).deliveryDay, "Thursday");  // Wed 20:59:59
  assert.equal(S.deliveryFor(new Date("2026-11-25T16:00:00Z")).deliveryDay, "Monday");    // Wed 21:00
});

test("✏️ Order badlein before the cut-off: she types only the change, confirms, the SAME order changes (no same-day question)", async () => {
  const restore = fakeAI();
  try {
    const p = "923009100001";
    const short = await placed(p, "RT1", 2);   // Tamatar 1 kg
    assert.deepEqual(short.buttons.map((b) => b.title), ["🧾 Poora bill", "✏️ Order badlein"]);
    const num = /\*(ASB-\d+)\*/.exec(short.text)[1];
    await tap(p, short.buttons[1].id, "✏️ Order badlein");
    await wait(p, 3);
    assert.match(to(p)[2].text, new RegExp(`^✏️ Order \\*${num}\\* \\(`));
    aiReply = { items: [{ sku: "T1", qty: 2, unit: "kg", said: "tamatar 2 kg" }, { sku: "T3", qty: 6, unit: "piece", said: "6 kinno" }] };
    await say(p, "tamatar 2 kg kar dein, 6 kinno aur");
    await wait(p, 4);
    assert.match(aiPrompt, /CURRENT ORDER[\s\S]*T1 \| Tamatar \| 1 kg/);
    const d = to(p)[3];
    assert.match(d.text, new RegExp(`^✏️ Order \\*${num}\\* ab aisa hoga:`));
    await tap(p, d.buttons[0].id, "✅ Theek hai");
    await wait(p, 5);
    assert.match(to(p)[4].text, new RegExp(`^✏️ Order \\*${num}\\* badal diya\\.`));
    assert.doesNotMatch(to(p)[4].text, /pehle se hai/);
    assert.deepEqual(await items(p), [["T1", 4], ["T3", 6]]);
    const orders = (await db.query(`SELECT count(*)::int AS n FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.phone = $1 AND o.status <> 'cancelled'`, [p])).rows[0].n;
    assert.equal(orders, 1);
    // the change is on record: before and after
    const rec = (await db.query(`SELECT note, lines FROM order_drafts WHERE phone = $1 AND status = 'confirmed' AND note LIKE 'change:%'`, [p])).rows;
    assert.equal(rec.length, 1);
    assert.deepEqual(JSON.parse(rec[0].note.slice(7)).before, [{ sku: "T1", packs: 2 }]);
  } finally { restore(); }
});

test("typed 'kinno hata dein' with no order on screen changes her confirmed order; removing everything asks to cancel", async () => {
  const restore = fakeAI();
  try {
    const p = "923009100002";
    await placed(p, "RT3", 6);
    aiReply = { items: [] };
    await say(p, "kinno hata dein");
    await wait(p, 3);
    const ask = to(p)[2];
    assert.match(ask.text, /sab items nikal diye\. Poora order \*cancel\* kar doon\?/);
    await tap(p, ask.buttons[1].id, "Nahi, rehne dein");
    await wait(p, 4);
    assert.match(to(p)[3].text, /waise hi rahega/);
    assert.deepEqual(await items(p), [["T3", 6]]);
    await tap(p, ask.buttons[0].id, "🗑️ Haan, cancel");
    await wait(p, 5);
    assert.match(to(p)[4].text, /cancel kar diya/);
    assert.deepEqual(await items(p), []);
  } finally { restore(); }
});

test("after the cut-off: a change is refused kindly (the team takes over); a new list goes to the NEXT delivery and says so", async () => {
  const restore = fakeAI();
  try {
    const p = "923009100003";
    const short = await placed(p, "RT1", 2);
    // the delivery is now past its cut-off
    await db.query(`UPDATE cycles SET status = 'locked' WHERE id = (SELECT o.cycle_id FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.phone = $1 LIMIT 1)`, [p]);
    await tap(p, short.buttons[1].id, "✏️ Order badlein");
    await wait(p, 3);
    assert.match(to(p)[2].text, /band ho chuka hai — cutoff (Sunday|Wednesday) raat 9 baje/);
    await say(p, "tamatar hata dein");
    await wait(p, 4);
    assert.match(to(p)[3].text, /band ho chuka hai/);
    assert.deepEqual(await items(p), [["T1", 2]]);
    // a fresh list: shown for the next delivery, with the reason
    aiReply = { items: [{ sku: "T3", qty: 6, unit: "piece", said: "6 kinno" }] };
    await say(p, "6 kinno");
    await wait(p, 5);
    // the locked cycle cannot take orders: deliveryFor still names it, so this test only checks the notice
    assert.match(to(p)[4].text, /order band ho chuka hai \(cutoff .* raat 9 baje\)\. Ye naya order agli delivery ke liye hai/);
    await db.query(`UPDATE cycles SET status = 'open'`);
  } finally { restore(); }
});

test("⏰ reminder 3 hours before the cut-off: only customers with 3+ changes in 30 days, once per order, inside the 24h window", async () => {
  const p = "923009100004", q = "923009100005";
  const a = await placed(p, "RT1", 2);
  await placed(q, "RT1", 2);
  const slot = S.deliveryFor(new Date());
  const now = new Date(slot.locksAt.getTime() - 2 * 3600e3);
  for (let i = 0; i < 3; i++) {
    await db.query(`INSERT INTO order_drafts (phone, source, lines, status, note, decided_at) VALUES ($1, 'typed', '[]', 'confirmed', 'change:{}', now())`, [p]);
  }
  await db.query(`UPDATE whatsapp_messages SET received_at = $2 WHERE phone = $1 AND direction = 'inbound'`, [p, new Date(now.getTime() - 3600e3)]);
  const out = [];
  const send = { text: async (to, body) => { out.push({ to, body });
    await require(path.join(ROOT, "inbox.js")).logOutbound({ phone: to, body, agent: "order bot", wamid: "w" + Math.random(), ok: true }); } };
  const r1 = await O.remindFrequentChangers(db, { send, now });
  assert.equal(r1.sent, 1);
  assert.equal(out[0].to, p);
  assert.match(out[0].body, new RegExp(`⏰ Yaad dahani: aap ka order \\*${/\*(ASB-\d+)\*/.exec(a.text)[1]}\\*`));
  const r2 = await O.remindFrequentChangers(db, { send, now });
  assert.equal(r2.sent, 0, "once per order");
  const early = await O.remindFrequentChangers(db, { send, now: new Date(slot.locksAt.getTime() - 5 * 3600e3) });
  assert.equal(early.sent, 0, "not before the last 3 hours");
});
