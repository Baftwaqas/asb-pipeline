// "Rate list?" answered by the bot (founder, 19 Nov 2026): a menu, then the
// chosen part of today's prices from the products table.
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const H = require("./support/harness");

const ROOT = path.join(__dirname, "..");
let db, server, base, sent, R;
let n = 0;
const hook = (phone, message) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "1", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", contacts: [{ wa_id: phone, profile: { name: "T" } }],
    messages: [{ from: phone, id: `wamid.rl${++n}`, timestamp: String(1795000000 + n), ...message }],
  } }] }],
});
const say = (p, text) => H.postWhatsApp(base, hook(p, { type: "text", text: { body: text } }));
const pick = (p, id, title) => H.postWhatsApp(base, hook(p, { type: "interactive", interactive: { type: "list_reply", list_reply: { id, title } } }));
const to = (p) => sent.filter((s) => s.phone === p);

before(async () => {
  const url = await H.createDatabase("asb_t_ratelist", ROOT);
  H.setEnv(url);
  process.env.RATELIST_BOT = "on";
  process.env.AREA_BOT = "off";
  sent = H.stubOutside(ROOT);
  const wa = require(path.join(ROOT, "whatsapp.js"));
  wa.sendList = async (phone, text, button, rows) => { sent.push({ kind: "list", phone, text, button, rows }); return { ok: true, wamid: "wamid.L" + n, data: {} }; };
  const mod = require(path.join(ROOT, "server.js"));
  db = require(path.join(ROOT, "db"));
  R = require(path.join(ROOT, "ratelist.js"));
  await db.query(H.FIXTURE_SQL);
  await db.query(`INSERT INTO products (sku, name_en, category, unit, step_qty, min_qty, shopify_variant_id, is_active, asb_price, market_price) VALUES
    ('T1', 'Tamatar', 'sabziyaan', 'kg', 0.5, 0.5, 'v1', true, 99, 200),
    ('T2', 'Pakora Mirch', 'sabziyaan', 'g', 250, 250, 'v2', true, 15, 60),
    ('T3', 'Dhania', 'sabziyaan', 'bundle', 1, 1, 'v3', true, 25, 30),
    ('T4', 'Kinno', 'phal', 'pcs', 1, 1, 'v4', true, 39, 42),
    ('T5', 'Off Item', 'sabziyaan', 'kg', 1, 1, 'v5', false, 10, 20)`);
  server = mod.app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { server?.close(); await new Promise((r) => setTimeout(r, 200)); await db?.shutdown(); });

test("what counts as asking for the rate list", () => {
  for (const t of ["Rate list?", "rate list bhej dein", "aaj ka rate kya hai", "ratelist", "Bhao?", "price list please", "qeemat batayein"]) assert.ok(R.isAsk(t), t);
  for (const t of ["2 kg aloo", "salam", "kal delivery kab hogi", ""]) assert.ok(!R.isAsk(t), t);
});

test("pack sizes read the way the posters say them", () => {
  assert.equal(R.packOf({ unit: "kg", min_qty: 0.5 }), "500 g");
  assert.equal(R.packOf({ unit: "kg", min_qty: 1 }), "1 kg");
  assert.equal(R.packOf({ unit: "g", min_qty: 250 }), "250 g");
  assert.equal(R.packOf({ unit: "bundle", min_qty: 1 }), "1 gaddi");
  assert.equal(R.packOf({ unit: "dozen", min_qty: 1 }), "1 darjan");
});

test("'Rate list?' -> the menu; a choice -> today's prices for that part", async () => {
  const p = "923008000001";
  await say(p, "Rate list?");
  await H.waitFor(async () => to(p).length >= 1);
  assert.equal(to(p)[0].kind, "list");
  assert.equal(to(p)[0].rows.length, 5);

  await pick(p, "ratelist:deals", "🔥 Sab se bari bachat");
  await H.waitFor(async () => to(p).length >= 2);
  const deals = to(p)[1].text;
  assert.match(deals, /Pakora Mirch \(250 g\) — \*Rs 15\*  ~Rs 60~  -75%/);
  assert.ok(deals.indexOf("Pakora Mirch") < deals.indexOf("Tamatar"), "biggest saving first");
  assert.doesNotMatch(deals, /Off Item|Payaz — Community/);

  await pick(p, "ratelist:daily", "🥔 Roz ki sabzi");
  await H.waitFor(async () => to(p).length >= 3);
  assert.match(to(p)[2].text, /Tamatar \(500 g\)[\s\S]*Dhania \(1 gaddi\)|Aloo White[\s\S]*Tamatar/);
  assert.doesNotMatch(to(p)[2].text, /Kinno/);

  await pick(p, "ratelist:fruit", "🍎 Phal");
  await H.waitFor(async () => to(p).length >= 4);
  assert.match(to(p)[3].text, /Kinno \(1 piece\) — \*Rs 39\*/);
  assert.match(to(p)[3].text, /Chonsa Aam/);

  // logged in the chat for the team
  const n2 = (await db.query(`SELECT count(*)::int AS n FROM whatsapp_messages WHERE phone = $1 AND agent = 'rate list bot'`, [p])).rows[0].n;
  assert.equal(n2, 4);
});

test("an order message is left for the team; the switch off means silence", async () => {
  const p = "923008000002";
  await say(p, "2 kg aloo aur 1 kg tamatar");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(to(p).length, 0);
  process.env.RATELIST_BOT = "off";
  await say(p, "rate list");
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(to(p).length, 0);
  process.env.RATELIST_BOT = "on";
});
