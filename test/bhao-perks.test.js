// The Bhao Card (bhao/perks.js): why her price differs, shown to her.
// Needs a scratch Postgres (TEST_PG_URL, default postgres://postgres@localhost:54330).
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { Client } = require("pg");
const H = require("./support/harness");
const P = require("../bhao/perks");
const BW = require("../bhao/whatsapp");
const B = require("../bhao/engine");

const POT = { itemId: "ASB-NG-POT-5L", variantGid: "gid://shopify/ProductVariant/900001", bhaoTaoEnabled: true, isGrocery: false,
  anchorPaisa: 180000, floorPaisa: 85000, costPaisa: 60000, maxQty: 20, approvedBy: "test",
  groupTiers: [{ minQty: 5, floorPaisa: 75000 }] };

test("perks lower the opening price and the floor a little - capped, rounded, never below cost, tiers kept valid", () => {
  const gold = P.applyPerks(POT, [{ key: "standing:gold", pct: 0.06 }]);
  assert.deepEqual([gold.anchorPaisa, gold.floorPaisa, gold.groupTiers[0].floorPaisa], [170000, 80000, 71000]);
  const all = P.applyPerks(POT, [{ pct: 0.06 }, { pct: 0.03 }, { pct: 0.03 }, { pct: 0.02 }]);
  assert.equal(P.totalPct([{ pct: 0.06 }, { pct: 0.03 }, { pct: 0.03 }, { pct: 0.02 }]), 0.10, "capped at 10%");
  assert.equal(all.floorPaisa, 77000, "Rs 765 rounds up to Rs 770");
  assert.ok(all.floorPaisa >= POT.costPaisa);
  B.validateItem(all); B.validateItem(gold);
  const thin = P.applyPerks({ ...POT, floorPaisa: 61000, groupTiers: [{ minQty: 5, floorPaisa: 60500 }] }, [{ pct: 0.1 }]);
  assert.equal(thin.floorPaisa, 60000, "never below cost");
  assert.deepEqual(thin.groupTiers, [], "a tier that would no longer be lower is dropped, not broken");
  B.validateItem(thin);
  assert.equal(P.applyPerks(POT, []), POT, "no perks: the item as approved");
});

test("what she writes can earn a perk: advance payment, self-pickup", () => {
  assert.deepEqual(P.perksFromText("advance de dungi").map((p) => p.key), ["advance"]);
  assert.deepEqual(P.perksFromText("JazzCash se pehle payment kar doon gi, khud le jaungi").map((p) => p.key), ["advance", "pickup"]);
  assert.deepEqual(P.perksFromText("advance", [{ key: "advance" }]), [], "earned once");
  assert.deepEqual(P.perksFromText("900 mein de do"), []);
  assert.ok(P.perksFromText("advance").every((p) => p.conditional));
});

test("Karachi time decides bohni and closing time", () => {
  assert.equal(P.karachiHour(new Date("2026-11-08T03:30:00Z")), 8);
  assert.equal(P.karachiHour(new Date("2026-11-08T16:30:00Z")), 21);
});

test("the card shows what she has and what would give her more room - no percentages", () => {
  const t = P.cardText([{ key: "standing:gold", label: "Gold customer ⭐", recentOrders: 12 }, { key: "bohni", label: "Subah ki bohni 🌅" }], { groupSizes: [5] });
  assert.match(t, /Bhao Card/);
  assert.match(t, /Gold customer ⭐ \(pichle 3 mahine: 12 order\)/);
  assert.match(t, /Subah ki bohni/);
  assert.match(t, /advance payment · 🛵 khud pickup · 👥 5 milke/);
  assert.doesNotMatch(t, /%/);
});

let db, n = 0;
const phone = () => "92311" + String(1000000 + ++n);
const wamid = () => "wamid.P" + ++n;
const speakSpy = (seen) => async (args) => { seen.push(args); return { text: "Ji baji.", source: "template", rejected: [] }; };
before(async () => {
  const url = await H.createDatabase("asb_test_perks", path.join(__dirname, ".."), { grocery: false });
  db = new Client({ connectionString: url });
  await db.connect();
  await db.query(
    `INSERT INTO bhao_items (item_id, variant_gid, name, anchor_paisa, floor_paisa, cost_paisa, group_tiers, max_qty, facts, approved_by)
     VALUES ('ASB-NG-POT-5L', 'gid://shopify/ProductVariant/900001', 'Steel ki Degchi 5 litre', 180000, 85000, 60000,
             '[{"minQty":5,"floorPaisa":75000}]', 20, '["5 litre"]', 'test')`);
});
after(async () => { if (db) await db.end(); });
const outbox = async (p) => (await db.query(
  `SELECT m.* FROM bhao_messages m JOIN bhao_conversations c ON c.id = m.conversation_id WHERE c.phone = $1 AND m.direction = 'out' ORDER BY m.id`, [p])).rows;

test("a gold customer opens lower than a new one, and both see their Bhao Card after the greeting", async () => {
  const noon = new Date("2026-11-08T07:00:00Z"); // 12:00 Karachi: no bohni, no closing time
  const g = phone();
  await db.query(`INSERT INTO customers (phone, badge) VALUES ($1, 'gold')`, [g]);
  const seen = [];
  await BW.onInbound(db, { phone: g, text: "BHAO ASB-NG-POT-5L", wamid: wamid(), now: noon, env: {}, speak: speakSpy(seen) });
  const fresh = phone();
  await BW.onInbound(db, { phone: fresh, text: "BHAO ASB-NG-POT-5L", wamid: wamid(), now: noon, env: {}, speak: speakSpy(seen) });
  assert.equal(seen[0].decision.askPaisa, 170000, "gold: 6% more room from the start (Rs 1,692 -> Rs 1,700)");
  assert.equal(seen[1].decision.askPaisa, 180000, "new: the approved opening price");
  assert.deepEqual(seen[0].perks, ["Gold customer ⭐"]);
  const [greet, card] = await outbox(g);
  assert.equal(card.decision.kind, "bhao_card");
  assert.match(card.body, /Gold customer/);
  assert.ok(new Date(card.send_after) > new Date(greet.send_after), "the card follows the greeting");
  assert.match((await outbox(fresh))[1].body, /Naye mehmaan/);
});

test("the morning's first customer gets the bohni; once a deal is done today, the next one does not", async () => {
  const morning = new Date("2026-11-09T03:30:00Z"); // 08:30 Karachi
  const seen = [];
  const a = phone();
  await BW.onInbound(db, { phone: a, text: "BHAO ASB-NG-POT-5L", wamid: wamid(), now: morning, env: {}, speak: speakSpy(seen) });
  assert.ok(seen.at(-1).perks.some((l) => /bohni/.test(l)));
  await BW.onInbound(db, { phone: a, text: "Rs 2,000", wamid: wamid(), now: new Date(morning.getTime() + 60e3), env: {}, speak: speakSpy(seen) });
  const b = phone();
  await BW.onInbound(db, { phone: b, text: "BHAO ASB-NG-POT-5L", wamid: wamid(), now: new Date(morning.getTime() + 120e3), env: {}, speak: speakSpy(seen) });
  assert.ok(!seen.at(-1).perks.some((l) => /bohni/.test(l)), "bohni ho gayi");
});

test("'advance de dungi' mid-bargain earns room, and becomes a CONDITION written into the deal", async () => {
  const noon = new Date("2026-11-10T07:00:00Z");
  const seen = [];
  const p = phone();
  await BW.onInbound(db, { phone: p, text: "BHAO ASB-NG-POT-5L", wamid: wamid(), now: noon, env: {}, speak: speakSpy(seen) });
  const r = await BW.onInbound(db, { phone: p, text: "advance de dungi", wamid: wamid(), now: new Date(noon.getTime() + 30e3), env: {}, speak: speakSpy(seen) });
  assert.equal(r.kind, "talk");
  assert.deepEqual(seen.at(-1).decision.perksGained, ["Advance payment 💵"]);
  const card = (await outbox(p)).find((o) => o.decision && o.decision.kind === "bhao_card");
  assert.equal(card.send_status, "pending", "a quick reply never drops her Bhao Card");
  const acc = await BW.onInbound(db, { phone: p, text: "Rs 2,000", wamid: wamid(), now: new Date(noon.getTime() + 60e3), env: {}, speak: speakSpy(seen) });
  assert.equal(acc.kind, "accept");
  const c = (await db.query(`SELECT accepted_offer FROM bhao_conversations WHERE phone = $1`, [p])).rows[0];
  assert.deepEqual(c.accepted_offer.conditions, ["advance"]);
  assert.equal(c.accepted_offer.unitPaisa, 175000, "the ask, lowered 3% by advance payment (Rs 1,746 -> Rs 1,750)");
  assert.match((await outbox(p)).at(-1).body, /Shart: Advance payment 💵 - is ke baghair yeh daam nahi/);
});

test("'meri dost ko 800 mein mili': checked against our records, never revealing anyone's price", async () => {
  const noon = new Date("2026-11-11T07:00:00Z");
  const seen = [];
  const p = phone();
  await BW.onInbound(db, { phone: p, text: "BHAO ASB-NG-POT-5L", wamid: wamid(), now: noon, env: {}, speak: speakSpy(seen) });
  await BW.onInbound(db, { phone: p, text: "meri dost ko 800 mein mili thi", wamid: wamid(), now: new Date(noon.getTime() + 30e3), env: {}, speak: speakSpy(seen) });
  assert.deepEqual(seen.at(-1).claim, { claimedPaisa: 80000, neverSoldThatLow: true });
  await BW.onInbound(db, { phone: p, text: "padosan ne 2000 mein li hai", wamid: wamid(), now: new Date(noon.getTime() + 60e3), env: {}, speak: speakSpy(seen) });
  assert.equal(seen.at(-1).claim.neverSoldThatLow, false, "someone did pay that or less: admit prices differ");
  const V = require("../bhao/voice");
  const u = V.buildPrompt({ decision: { kind: "talk" }, itemName: "x", qty: 1, customerText: "", history: [], claim: { claimedPaisa: 80000, neverSoldThatLow: true } }).user;
  assert.match(u, /NEVER been sold by us at Rs 800 or less/);
});
