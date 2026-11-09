// Seth Ji's picture cards and tap buttons (bhao/cards.js, migration 027).
// Needs a scratch Postgres (TEST_PG_URL, default postgres://postgres@localhost:54330).
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { Client } = require("pg");
const H = require("./support/harness");
const K = require("../bhao/cards");
const BW = require("../bhao/whatsapp");

let db, n = 0;
const T0 = new Date("2026-11-08T07:00:00Z");
const at = (sec) => new Date(T0.getTime() + sec * 1000);
const phone = () => "92331" + String(1000000 + ++n);
const wamid = () => "wamid.U" + ++n;
const speak = async () => ({ text: "Ji baji.", source: "template", rejected: [] });
const say = (p, text, sec, extra = {}) => BW.onInbound(db, { phone: p, text, wamid: wamid(), now: at(sec), env: {}, speak, ...extra });
const outbox = async (p) => (await db.query(
  `SELECT m.* FROM bhao_messages m JOIN bhao_conversations c ON c.id = m.conversation_id WHERE c.phone = $1 AND m.direction = 'out' ORDER BY m.id`, [p])).rows;

before(async () => {
  const url = await H.createDatabase("asb_test_ui", path.join(__dirname, ".."), { grocery: false });
  db = new Client({ connectionString: url });
  await db.connect();
  for (const [id, name] of [["ASB-NG-POT-5L", "Steel ki Degchi 5 litre"], ["ASB-NG-KARAHI", "Steel ki Karahi"]])
    await db.query(
      `INSERT INTO bhao_items (item_id, variant_gid, name, anchor_paisa, floor_paisa, cost_paisa, group_tiers, max_qty, facts, approved_by)
       VALUES ($1, 'gid://shopify/ProductVariant/900001', $2, 180000, 85000, 60000, '[{"minQty":5,"floorPaisa":75000}]', 20, '[]', 'test')`, [id, name]);
});
after(async () => { if (db) await db.end(); });

const isJpeg = (b) => Buffer.isBuffer(b) && b[0] === 0xff && b[1] === 0xd8 && b[b.length - 2] === 0xff && b[b.length - 1] === 0xd9;

test("the Bhao Card and the victory card are drawn as JPG; no saving, no victory card", () => {
  assert.ok(K.available());
  const card = K.bhaoCard({ itemName: "Steel ki Degchi 5 litre", askPaisa: 180000, perks: ["Gold customer ⭐", "Subah ki bohni 🌅"], more: ["💵 Advance payment"], title: "Bhao Khiladi 🥈" });
  assert.ok(isJpeg(card) && card.length > 20000 && card.length < 5e6, "a real JPG under WhatsApp's 5 MB");
  const win = K.victoryCard({ itemName: "Degchi", openPaisa: 180000, unitPaisa: 120000, title: "Bhao Shagird 🥉", itemCode: "DEGCHI" });
  assert.ok(isJpeg(win));
  assert.equal(K.victoryCard({ itemName: "x", openPaisa: 120000, unitPaisa: 120000, itemCode: "X" }), null);
  assert.equal(K.plain("Gold customer ⭐"), "Gold customer");
});

test("buttons: her price is always one of the three; ids carry the price she saw; titles fit WhatsApp's 20 characters", () => {
  const item = { groupTiers: [{ minQty: 5, floorPaisa: 75000 }] };
  const b = BW.priceButtons(42, 1250000, { perks: [], qty: 1 }, item);
  assert.deepEqual(b.map((x) => x.id), ["bhao:ok:42:1250000", "bhao:mine:42", "bhao:adv:42"]);
  assert.ok(b.every((x) => [...x.title].length <= 20), JSON.stringify(b.map((x) => x.title)));
  assert.equal(b[1].title, "🙋 Apna daam");
  const afterAdvance = BW.priceButtons(42, 175000, { perks: [{ key: "advance" }], qty: 1 }, item);
  assert.deepEqual(afterAdvance.map((x) => x.id), ["bhao:ok:42:175000", "bhao:mine:42", "bhao:group:42:5"]);
});

test("a tap reads exactly as if she had typed it", () => {
  assert.deepEqual(BW.fromButton("bhao:ok:42:180000"), { text: "Rs 1,800", intent: "accept_tap" });
  assert.equal(BW.readOffer(BW.fromButton("bhao:ok:42:180000").text), 180000);
  assert.equal(BW.fromButton("bhao:mine:42").intent, "mine");
  assert.match(BW.fromButton("bhao:adv:42").text, /advance/i);
  assert.equal(BW.readQty(BW.fromButton("bhao:group:42:5").text), 5);
  assert.deepEqual(BW.fromButton("bhao:item:ASB-NG-KARAHI"), { text: "BHAO ASB-NG-KARAHI", intent: "start" });
  assert.equal(BW.fromButton("something:else"), null);
  assert.equal(BW.fromButton("bhao:ok:42:notanumber"), null);
});

test("opening: a plain greeting, then the Bhao Card as a picture with the three buttons; replies carry buttons too", async () => {
  const p = phone();
  await say(p, "BHAO ASB-NG-POT-5L", 0);
  const [greet, card] = await outbox(p);
  assert.equal(greet.ui, null, "the greeting itself has no buttons");
  assert.equal(card.ui.type, "buttons");
  assert.equal(card.ui.image.kind, "bhao_card");
  assert.equal(card.ui.image.askPaisa, 180000);
  assert.ok(card.ui.buttons.some((b) => b.id.startsWith("bhao:mine:")));
  await say(p, "900", 100);
  const reply = (await outbox(p)).at(-1);
  assert.equal(reply.decision.kind, "refuse");
  assert.equal(reply.ui.type, "buttons");
  assert.equal(reply.ui.text, reply.body, "the buttons carry his own words");
});

test("tapping 'Apna daam' invites her number; tapping 'manzoor' closes the deal at the price on the button", async () => {
  const p = phone();
  const seen = [];
  const spy = async (a) => { seen.push(a); return { text: "Ji baji.", source: "template", rejected: [] }; };
  await say(p, "BHAO ASB-NG-KARAHI", 0, { speak: spy });
  const mine = BW.fromButton(`bhao:mine:1`);
  await say(p, mine.text, 60, { speak: spy, intent: mine.intent });
  assert.equal(seen.at(-1).decision.herPriceInvited, true);
  assert.equal(require("../bhao/voice").priceOf(seen.at(-1).decision), null, "her turn: he names no price");
  const card = (await outbox(p)).find((o) => o.decision.kind === "bhao_card");
  const ok = BW.fromButton(card.ui.buttons[0].id);
  const r = await say(p, ok.text, 120, { speak: spy, intent: ok.intent });
  assert.equal(r.kind, "accept");
  const victory = (await outbox(p)).find((o) => o.decision.kind === "victory");
  assert.equal(victory, undefined, "accepting the listed price is no victory - no fake 'bachat'");
});

test("'BHAO' alone returns the menu of items, never a bargain", async () => {
  const r = await say(phone(), "bhao", 0);
  assert.equal(r.handled, true);
  assert.deepEqual(r.menu.map((m) => m.id), ["bhao:item:ASB-NG-POT-5L", "bhao:item:ASB-NG-KARAHI"]);
  assert.match(r.menu[0].description, /Seth Ji ka daam Rs 1,800/);
});

test("sending: card -> upload -> buttons with the image header; victory -> picture; any failure falls back to the plain words", async () => {
  const calls = [];
  const deps = {
    sendText: async (to, body) => { calls.push(["text", body]); return { ok: true, wamid: "t" }; },
    sendButtons: async (to, m) => { calls.push(["buttons", m.headerImageId, m.buttons.length]); return { ok: true, wamid: "b" }; },
    sendImage: async (to, id, cap) => { calls.push(["image", id]); return { ok: true, wamid: "i" }; },
    uploadMedia: async (buf, mime) => { calls.push(["upload", mime, buf.length > 1000]); return { ok: true, id: "MEDIA1" }; },
  };
  const card = { phone: "92300", body: "fallback", ui: { type: "buttons", text: "Ye raha", image: { kind: "bhao_card", itemName: "x", askPaisa: 180000 }, buttons: [{ id: "a", title: "A" }] } };
  await BW.sendRich(card, deps);
  assert.deepEqual(calls.splice(0), [["upload", "image/jpeg", true], ["buttons", "MEDIA1", 1]]);
  await BW.sendRich({ phone: "92300", body: "Jeet!", ui: { type: "image", image: { kind: "victory", itemName: "x", openPaisa: 180000, unitPaisa: 120000, itemCode: "X" } } }, deps);
  assert.deepEqual(calls.splice(0), [["upload", "image/jpeg", true], ["image", "MEDIA1"]]);
  await BW.sendRich(card, { ...deps, sendButtons: async () => ({ ok: false }) });
  assert.deepEqual(calls.splice(0).at(-1), ["text", "fallback"], "buttons refused: the words still go");
  await BW.sendRich(card, { ...deps, uploadMedia: async () => ({ ok: false }) });
  assert.deepEqual(calls.splice(0), [["buttons", null, 1]], "no picture: buttons without it");
});

test("migration 027: the UI she was shown is evidence too - it never changes", async () => {
  const p = phone();
  await say(p, "BHAO ASB-NG-POT-5L", 0);
  const card = (await outbox(p)).find((o) => o.ui);
  await assert.rejects(db.query(`UPDATE bhao_messages SET ui = '{"type":"x"}' WHERE id = $1`, [card.id]), /immutable/);
});
