// Bhao Tao over WhatsApp (migration 025, bhao/whatsapp.js, bhao/runtime.js).
// Needs a scratch Postgres (TEST_PG_URL, default postgres://postgres@localhost:54330).
//   node --test test/bhao-whatsapp.test.js
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { Client } = require("pg");
const H = require("./support/harness");
const BW = require("../bhao/whatsapp");
const RT = require("../bhao/runtime");

let db, n = 0;
const T0 = new Date("2026-11-08T07:00:00Z");
const at = (sec) => new Date(T0.getTime() + sec * 1000);
const phone = () => "92300" + String(1000000 + ++n);
const wamid = () => "wamid.T" + ++n;

before(async () => {
  const url = await H.createDatabase("asb_test_025", path.join(__dirname, ".."), { grocery: false });
  db = new Client({ connectionString: url });
  await db.connect();
  await db.query(
    `INSERT INTO bhao_items (item_id, variant_gid, name, anchor_paisa, floor_paisa, cost_paisa, group_tiers, max_qty, facts, approved_by)
     VALUES ('ASB-NG-POT-5L', 'gid://shopify/ProductVariant/900001', 'Steel ki Degchi 5 litre', 180000, 85000, 60000,
             '[{"minQty":5,"floorPaisa":75000}]', 20, '["5 litre","mota steel","dhakkan ke saath"]', 'test')`);
});
after(async () => { if (db) await db.end(); });

const say = (p, text, sec, extra = {}) => BW.onInbound(db, { phone: p, text, wamid: extra.wamid || wamid(), now: at(sec), env: {}, ...extra });
const outbox = async (p) => (await db.query(
  `SELECT m.* FROM bhao_messages m JOIN bhao_conversations c ON c.id = m.conversation_id
    WHERE c.phone = $1 AND m.direction = 'out' ORDER BY m.id`, [p])).rows;
const conv = async (p) => (await db.query(`SELECT * FROM bhao_conversations WHERE phone = $1 ORDER BY id DESC LIMIT 1`, [p])).rows[0];

test("'BHAO <code>' opens a bargain at the anchor; Seth Ji's reply waits for its pause, then is sent and logged", async () => {
  const p = phone();
  const r = await say(p, "BHAO ASB-NG-POT-5L", 0);
  assert.equal(r.handled, true);
  const [o] = await outbox(p);
  assert.match(o.body, /Rs 1,800/);
  assert.equal(o.send_status, "pending");
  assert.ok(new Date(o.send_after) > T0, "not instant");
  const sent = [], logged = [];
  const sendText = async (to, body) => { sent.push({ to, body }); return { ok: true, wamid: "wamid.OUT" + sent.length }; };
  assert.deepEqual(await BW.sendDue(db, { sendText, now: T0 }), { sent: 0, failed: 0 });
  assert.deepEqual(await BW.sendDue(db, { sendText, now: at(600), logOutbound: async (x) => logged.push(x) }), { sent: 1, failed: 0 });
  assert.equal(sent[0].to, p);
  assert.equal(logged[0].agent, "seth-ji");
  assert.equal((await outbox(p))[0].send_status, "sent");
  assert.deepEqual(await BW.sendDue(db, { sendText, now: at(600) }), { sent: 0, failed: 0 }, "never twice");
});

test("a full bargain on WhatsApp: lowball, refusals, counters, a settle; never above the ask", async () => {
  const p = phone();
  await say(p, "BHAO ASB-NG-POT-5L", 0);
  const kinds = [];
  let t = 1000;
  for (const m of ["500", "900 mein de do", "900", "1000", "1100", "Rs 2,000"]) {
    const r = await say(p, m, t += 1000);
    kinds.push(r.kind);
    if (r.kind === "accept") break;
  }
  assert.equal(kinds[0], "lowball_check");
  assert.equal(kinds[1], "refuse");
  assert.ok(kinds.includes("counter"));
  assert.equal(kinds.at(-1), "accept");
  const c = await conv(p);
  assert.equal(c.status, "accepted");
  // she wins a fair offer (Rs 1,100) or overpays and is charged only the ask - never her Rs 2,000
  assert.ok(["fair_offer_after_rounds", "offer_above_ask_extra_refused"].includes(c.accepted_offer.why), c.accepted_offer.why);
  assert.ok(c.accepted_offer.unitPaisa >= 85000 && c.accepted_offer.unitPaisa < 200000);
  const out = await outbox(p);
  assert.match(out.at(-1).body, /Sauda pakka.*Hamari team aap ko order confirm/);
  // after acceptance the bargain is over: her next message goes to the normal inbox
  assert.equal((await say(p, "shukriya", t + 1000)).handled, false);
});

test("Meta redelivering the same message changes nothing", async () => {
  const p = phone();
  await say(p, "BHAO ASB-NG-POT-5L", 0);
  const w = wamid();
  await say(p, "900", 100, { wamid: w });
  const before = (await outbox(p)).length;
  const r = await say(p, "900", 100, { wamid: w });
  assert.equal(r.duplicate, true);
  assert.equal((await outbox(p)).length, before);
});

test("her new message supersedes a reply Seth Ji has not sent yet", async () => {
  const p = phone();
  await say(p, "BHAO ASB-NG-POT-5L", 0);
  await say(p, "900", 10);
  await say(p, "acha 950?", 20);
  const out = await outbox(p);
  assert.deepEqual(out.map((o) => o.send_status), ["superseded", "superseded", "pending"]);
});

test("messages that are not a bargain stay with the normal inbox", async () => {
  assert.equal((await say(phone(), "Assalam o alaikum, aaj delivery hogi?", 0)).handled, false);
  assert.equal((await say(phone(), "BHAO NOT-AN-ITEM", 0)).handled, false);
});

test("restarting within 7 days continues at her last ask, never back at the anchor or below", async () => {
  const p = phone();
  await say(p, "BHAO ASB-NG-POT-5L", 0);
  for (const [i, m] of ["900", "900", "1000", "1000"].entries()) await say(p, m, 100 + i * 100);
  const lastAsk = Number((await conv(p)).state.askPaisa);
  assert.ok(lastAsk < 180000);
  await say(p, "BHAO ASB-NG-POT-5L", 3 * 864e2); // 3 days later... same open bargain continues
  await db.query(`UPDATE bhao_conversations SET status = 'closed' WHERE phone = $1`, [p]);
  await say(p, "BHAO ASB-NG-POT-5L", 4 * 864e2);   // a NEW bargain, 4 days later
  const c = await conv(p);
  assert.equal(Number(c.state.askPaisa), lastAsk);
  assert.match((await outbox(p)).at(-1).body, new RegExp("Rs " + (lastAsk / 100).toLocaleString("en-US")));
});

test("a bargain silent for 24 hours lapses; her next plain message goes to the inbox", async () => {
  const p = phone();
  await say(p, "BHAO ASB-NG-POT-5L", 0);
  assert.equal((await say(p, "900", 25 * 3600)).handled, false);
  assert.equal((await conv(p)).status, "expired");
});

test("'5 lein' then a price uses the group floor", async () => {
  const p = phone();
  await say(p, "BHAO ASB-NG-POT-5L", 0);
  assert.equal((await say(p, "5 lein toh?", 10)).kind, "talk");
  let r;
  for (let i = 0; i < 12; i++) { r = await say(p, "760", 20 + i * 10); if (r.kind === "accept" || r.kind === "closed") break; }
  const c = await conv(p);
  assert.equal(c.status, "accepted");
  assert.equal(c.accepted_offer.qty, 5);
  assert.equal(c.accepted_offer.unitPaisa, 76000); // above the Rs 750 group floor; never allowed for one pot
});

test("competitor facts reach the voice only when fresh and higher than the ask", async () => {
  const w = (await db.query(
    `INSERT INTO competitor_price_watches (item_id, marketplace, url, confirmed_same_item_by)
     VALUES ('ASB-NG-POT-5L', 'daraz', 'https://www.daraz.pk/products/x-i1.html', 'test') RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO competitor_price_checks (watch_id, status, price_paisa, via, checked_at) VALUES ($1, 'ok', 299900, 'rendered', $2)`,
    [w, at(-3600)]);
  const seen = [];
  const speak = async (args) => { seen.push(args); return { text: "Baji, Rs 1,800.", source: "template", rejected: [] }; };
  const p = phone();
  await BW.onInbound(db, { phone: p, text: "BHAO ASB-NG-POT-5L", wamid: wamid(), now: T0, env: {}, speak });
  assert.deepEqual(seen[0].competitorFacts.map((f) => [f.marketplace, f.pricePaisa]), [["daraz", 299900]]);
  assert.deepEqual(seen[0].itemFacts, ["5 litre", "mota steel", "dhakkan ke saath"]);
  await BW.onInbound(db, { phone: p, text: "900", wamid: wamid(), now: at(4 * 86400), env: {}, speak });
  assert.equal((await conv(p)).status, "expired", "4 days of silence lapses the bargain");
  const q = phone();
  await BW.onInbound(db, { phone: q, text: "BHAO ASB-NG-POT-5L", wamid: wamid(), now: at(3 * 86400), env: {}, speak });
  assert.deepEqual(seen.at(-1).competitorFacts, [], "a 3-day-old Daraz price is stale: never quoted");
});

test("messages are evidence: text, decision and timing never change; send status only moves forward", async () => {
  const p = phone();
  await say(p, "BHAO ASB-NG-POT-5L", 0);
  const [o] = await outbox(p);
  await assert.rejects(db.query(`UPDATE bhao_messages SET body = 'x' WHERE id = $1`, [o.id]), /immutable/);
  await assert.rejects(db.query(`DELETE FROM bhao_messages WHERE id = $1`, [o.id]), /never deleted/);
  await db.query(`UPDATE bhao_messages SET send_status = 'sent' WHERE id = $1`, [o.id]);
  await assert.rejects(db.query(`UPDATE bhao_messages SET send_status = 'pending' WHERE id = $1`, [o.id]), /final/);
  await assert.rejects(db.query(
    `INSERT INTO bhao_items (item_id, variant_gid, name, anchor_paisa, floor_paisa, cost_paisa, approved_by)
     VALUES ('BAD-1', 'gid://shopify/ProductVariant/1', 'x', 1000, 500, 600, 't')`), /floor_not_below_cost/);
});

test("switched off, the runtime does nothing", async () => {
  const prev = process.env.BHAO_TAO_WHATSAPP;
  delete process.env.BHAO_TAO_WHATSAPP;
  try {
    assert.equal(RT.enabled(), false);
    assert.deepEqual(await RT.onInbound({}, { phone: "923001234567", text: "BHAO ASB-NG-POT-5L", wamid: "w" }), { handled: false, reason: "off" });
  } finally { if (prev !== undefined) process.env.BHAO_TAO_WHATSAPP = prev; }
});

test("reading her message: amounts vs quantities", () => {
  assert.equal(BW.readOffer("900 mein de do"), 90000);
  assert.equal(BW.readOffer("Rs 1,200"), 120000);
  assert.equal(BW.readOffer("5 lein toh?"), null);
  assert.equal(BW.readOffer("5 lein, 760 mein"), 76000);
  assert.equal(BW.readOffer("itna mehenga kyun?"), null);
  assert.equal(BW.readQty("5 lein toh?"), 5);
  assert.equal(BW.readQty("paanch chahiye"), 5);
  assert.equal(BW.readQty("900 mein de do"), null);
});

test("an over-offer on WhatsApp is charged only the ask", async () => {
  const p = phone();
  await say(p, "BHAO ASB-NG-POT-5L", 0);
  const r = await say(p, "Rs 2,000", 10);
  assert.equal(r.kind, "accept");
  const c = await conv(p);
  assert.deepEqual([c.accepted_offer.unitPaisa, c.accepted_offer.why], [180000, "offer_above_ask_extra_refused"]);
  assert.match((await outbox(p))[1].body, /Rs 2,000 nahi! Daam Rs 1,800/);
});

test("a lowball waits 1-2 minutes now (founder, 7 Nov), not 3-7", async () => {
  assert.deepEqual(BW.POLICY.delaySeconds.lowball, [60, 120]);
  const p = phone();
  await say(p, "BHAO ASB-NG-POT-5L", 0);
  const r = await say(p, "200", 100);
  assert.equal(r.kind, "lowball_check");
  const wait = (new Date(r.due) - at(100)) / 1000;
  assert.ok(wait >= 60 && wait <= 120, String(wait));
});

test("'200' then 'fazool baat mat karo': one reply answers BOTH, still a lowball reply, at the original pause", async () => {
  const seen = [];
  const speak = async (args) => { seen.push(args); return { text: "Baji, mazaaq na karein.", source: "template", rejected: [] }; };
  const p = phone();
  await BW.onInbound(db, { phone: p, text: "BHAO ASB-NG-POT-5L", wamid: wamid(), now: at(0), env: {}, speak });
  await BW.sendDue(db, { sendText: async () => ({ ok: true, wamid: "w" + ++n }), now: at(600) });
  const first = await BW.onInbound(db, { phone: p, text: "200", wamid: wamid(), now: at(700), env: {}, speak });
  const second = await BW.onInbound(db, { phone: p, text: "Fazool baat mat kiya karo", wamid: wamid(), now: at(712), env: {}, speak });
  assert.equal(first.kind, "lowball_check");
  assert.equal(second.kind, "lowball_check", "the unanswered price is not dropped because she kept talking");
  assert.equal(new Date(second.due).getTime(), new Date(first.due).getTime(), "chatting never resets the pause");
  const last = seen.at(-1);
  assert.deepEqual(last.customerMessages, ["200", "Fazool baat mat kiya karo"]);
  assert.equal(last.offerPaisa, 20000);
  assert.ok(!last.history.some((h) => h.text === "200"), "unanswered lines are not repeated as history");
  const out = await outbox(p);
  assert.deepEqual(out.map((o) => o.send_status), ["sent", "superseded", "pending"]);
});

test("two questions in one message reach the voice whole; when she asks the price he may repeat his ask", async () => {
  const seen = [];
  const speak = async (args) => { seen.push(args); return { text: "Ji baji.", source: "template", rejected: [] }; };
  const p = phone();
  await BW.onInbound(db, { phone: p, text: "BHAO ASB-NG-POT-5L", wamid: wamid(), now: at(0), env: {}, speak });
  await BW.sendDue(db, { sendText: async () => ({ ok: true, wamid: "w" + ++n }), now: at(600) });
  const r = await BW.onInbound(db, { phone: p, text: "Kitne litre ki hai? Aur dhakkan saath hai?", wamid: wamid(), now: at(700), env: {}, speak });
  assert.equal(r.kind, "talk");
  assert.deepEqual(seen.at(-1).customerMessages, ["Kitne litre ki hai? Aur dhakkan saath hai?"]);
  assert.equal(seen.at(-1).decision.askPaisa, 180000);
});

test("a bargain opened under an older policy carries on under the new one, at her last ask", async () => {
  const p = phone();
  await say(p, "BHAO ASB-NG-POT-5L", 0);
  for (const [i, m] of ["900", "900", "1000", "1000"].entries()) await say(p, m, 100 + i * 100);
  const old = await conv(p);
  const lastAsk = Number(old.state.askPaisa);
  await db.query(`UPDATE bhao_conversations SET policy_version = 'BHAO-DRAFT-1', state = jsonb_set(state, '{policyVersion}', '"BHAO-DRAFT-1"') WHERE id = $1`, [old.id]);
  const r = await say(p, "1100", 1000);
  assert.equal(r.handled, true);
  const c = await conv(p);
  assert.notEqual(c.id, old.id);
  assert.equal(c.policy_version, BW.POLICY.version);
  assert.ok(Number(c.state.askPaisa) <= lastAsk, "never back up to the anchor");
  assert.notEqual(r.kind, "open", "her message is answered, not greeted");
  assert.equal((await db.query(`SELECT status FROM bhao_conversations WHERE id = $1`, [old.id])).rows[0].status, "closed");
});

