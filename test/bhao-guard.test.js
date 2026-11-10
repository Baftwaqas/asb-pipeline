// Fair play and delight (bhao/guard.js): Bhao Tao is hard to abuse - by her
// or by Seth Ji - and fun to win.
// Needs a scratch Postgres (TEST_PG_URL, default postgres://postgres@localhost:54330).
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { Client } = require("pg");
const H = require("./support/harness");
const G = require("../bhao/guard");
const P = require("../bhao/perks");
const V = require("../bhao/voice");
const BW = require("../bhao/whatsapp");

let db, n = 0;
const T0 = new Date("2026-11-08T07:00:00Z"); // 12:00 Karachi, not a mood day
const at = (sec) => new Date(T0.getTime() + sec * 1000);
const phone = () => "92321" + String(1000000 + ++n);
const wamid = () => "wamid.G" + ++n;
const seen = [];
const speak = async (args) => { seen.push(args); return { text: "Ji baji.", source: "template", rejected: [] }; };
const say = (p, text, sec) => BW.onInbound(db, { phone: p, text, wamid: wamid(), now: at(sec), env: {}, speak });
const outbox = async (p) => (await db.query(
  `SELECT m.* FROM bhao_messages m JOIN bhao_conversations c ON c.id = m.conversation_id WHERE c.phone = $1 AND m.direction = 'out' ORDER BY m.id`, [p])).rows;

before(async () => {
  const url = await H.createDatabase("asb_test_guard", path.join(__dirname, ".."), { grocery: false });
  db = new Client({ connectionString: url });
  await db.connect();
  for (const [id, name] of [["ASB-NG-POT-5L", "Steel ki Degchi 5 litre"], ["ASB-NG-TAWA", "Tawa"], ["ASB-NG-KARAHI", "Karahi"], ["ASB-NG-JUG", "Jug"]])
    await db.query(
      `INSERT INTO bhao_items (item_id, variant_gid, name, anchor_paisa, floor_paisa, cost_paisa, group_tiers, max_qty, facts, approved_by)
       VALUES ($1, 'gid://shopify/ProductVariant/900001', $2, 180000, 85000, 60000, '[{"minQty":5,"floorPaisa":75000}]', 20, '[]', 'test')`, [id, name]);
});
after(async () => { if (db) await db.end(); });

test("at most 3 new bargains a day per phone; the 4th gets a friendly 'kal phir aaiye ga'", async () => {
  const p = phone();
  for (const [i, code] of ["ASB-NG-POT-5L", "ASB-NG-TAWA", "ASB-NG-KARAHI"].entries())
    assert.equal((await say(p, "BHAO " + code, i * 100)).kind, "open");
  const r = await say(p, "BHAO ASB-NG-JUG", 400);
  assert.equal(r.guarded, "daily_limit");
  assert.match((await outbox(p)).at(-1).body, /Kal phir aaiye ga/);
  const tomorrow = await say(p, "BHAO ASB-NG-JUG", 86400);
  assert.equal(tomorrow.kind, "open");
});

test("one deal per item per week: buying again lower is not a game", async () => {
  const p = phone();
  await say(p, "BHAO ASB-NG-POT-5L", 0);
  assert.equal((await say(p, "Rs 2,000", 10)).kind, "accept");
  const r = await say(p, "BHAO ASB-NG-POT-5L", 3600);
  assert.equal(r.guarded, "deal_cooldown");
  assert.match((await outbox(p)).at(-1).body, /is hafte ho chuka hai/);
  assert.equal((await say(p, "BHAO ASB-NG-POT-5L", 8 * 86400)).kind, "open");
});

test("two deals said 'pakka' and cancelled in a month pause Bhao Tao for a week", async () => {
  const p = phone();
  for (const [i, code] of ["ASB-NG-POT-5L", "ASB-NG-TAWA"].entries()) {
    const t = i * 2 * 86400;
    await say(p, "BHAO " + code, t);
    assert.equal((await say(p, "Rs 2,000", t + 10)).kind, "accept");
    assert.equal((await say(p, "cancel kar do", t + 600)).kind, "cancel");
  }
  const r = await say(p, "BHAO ASB-NG-KARAHI", 5 * 86400);
  assert.equal(r.guarded, "paused_cancellations");
  assert.equal((await say(p, "BHAO ASB-NG-KARAHI", 12 * 86400)).kind, "open", "a week after the last cancellation");
});

test("gaali: first a calm warning and no price move; the second time the bargain ends and pauses", async () => {
  const p = phone();
  await say(p, "BHAO ASB-NG-POT-5L", 0);
  const before = (await db.query(`SELECT state FROM bhao_conversations WHERE phone = $1`, [p])).rows[0].state.askPaisa;
  const w = await say(p, "idiot, 500 mein do", 100);
  assert.equal(w.kind, "abuse_warning");
  assert.equal((await db.query(`SELECT state FROM bhao_conversations WHERE phone = $1`, [p])).rows[0].state.askPaisa, before, "no price move");
  const c = await say(p, "kutta hai tu", 200);
  assert.equal(c.kind, "abuse_close");
  assert.match((await outbox(p)).at(-1).body, /izzat se phir aaiye ga/);
  assert.equal((await say(p, "BHAO ASB-NG-TAWA", 300)).guarded, "paused_abuse");
  assert.notEqual((await say(phone(), "BHAO ASB-NG-TAWA", 300)).guarded, "paused_abuse", "only her phone");
});

test("haggling banter is not abuse", () => {
  for (const t of ["bohat mehenga hai", "loot macha rakhi hai", "chor bazaar lagta hai", "aap toh daaku ho 😄"]) assert.equal(G.isAbuse(t), false, t);
  for (const t of ["idiot ho", "chutiya", "harami", "ullu ke pathe"]) assert.equal(G.isAbuse(t), true, t);
});

test("a hardship story: kindness and a human - never a price lever", async () => {
  const p = phone();
  await say(p, "BHAO ASB-NG-POT-5L", 0);
  await say(p, "meri beti bimar hai, paise nahi hain", 100);
  const last = seen.at(-1);
  assert.equal(last.hardship, true);
  assert.equal(last.decision.kind, "talk", "no special price");
  const u = V.buildPrompt({ decision: last.decision, itemName: "x", qty: 1, customerText: "", history: [], hardship: true }).user;
  assert.match(u, /The price does NOT change because of it/);
});

test("a burst of messages is answered once, together", async () => {
  const p = phone();
  await say(p, "BHAO ASB-NG-POT-5L", 0);
  const r = [];
  for (let i = 0; i < 9; i++) r.push(await say(p, "jaldi batao " + i, 100 + i * 3));
  assert.ok(r.some((x) => x.throttled), "the burst is throttled");
  const pending = (await outbox(p)).filter((o) => o.send_status === "pending" && !["bhao_card", "open"].includes(o.decision.kind));
  assert.equal(pending.length, 1, "one reply waiting, not nine");
});

test("Seth Ji may never insult, shame or belittle her", () => {
  const d = { kind: "refuse" };
  for (const t of ["Baji, aap pagal hain kya?", "Sharam karo baji, itna kam!", "Aap ki aukaat nahi hai", "Ghareeb log bhao karte hain"])
    assert.equal(V.checkReply(t, { decision: d, qty: 1 }).ok, false, t);
  assert.equal(V.checkReply("Baji... mazaaq kar rahi hain? 😐", { decision: d, qty: 1 }).ok, true);
});

test("the victory card: what she saved, her title, and a line to share", () => {
  const t = G.victoryText({ openPaisa: 180000, unitPaisa: 120000, itemCode: "DEGCHI", title: "Bhao Khiladi 🥈", shareNumber: "15556512434" });
  assert.match(t, /Shuru: Rs 1,800 → Aap ka sauda: Rs 1,200/);
  assert.match(t, /Bachat: Rs 600 \(33%\)/);
  assert.match(t, /Bhao Khiladi/);
  assert.match(t, /https:\/\/wa\.me\/15556512434\?text=BHAO%20DEGCHI/);
  assert.equal(G.victoryText({ openPaisa: 120000, unitPaisa: 120000, itemCode: "X" }), null, "no saving, no victory lap");
});

test("titles are cosmetic and grow with deals; Seth Ji's mood is the same for everyone that day", async () => {
  assert.equal(G.TITLES.find((t) => 0 >= t.min).label, "Naya khiladi 🎯");
  assert.equal(G.TITLES.find((t) => 10 >= t.min).label, "Seth-Maar 👑");
  const day = new Date("2026-11-10T07:00:00Z");
  assert.equal(P.goodMoodDay(day), true);
  assert.equal(P.goodMoodDay(new Date("2026-11-10T16:00:00Z")), true, "same Karachi day, same mood");
  assert.equal(P.goodMoodDay(new Date("2026-11-11T07:00:00Z")), false);
});

// --- probing protection (founder 9 Nov: "5 phones at once to learn our lowest price") ---
test("each conversation's floor is lifted: weekly drift + a private cushion + more for new numbers; never below the approved floor", async () => {
  const p = phone();
  await say(p, "BHAO ASB-NG-POT-5L", 0);
  const st = (await db.query(`SELECT state FROM bhao_conversations WHERE phone = $1`, [p])).rows[0].state;
  const L = st.floorLift;
  assert.ok(L.weekly >= 0 && L.weekly <= P.PROTECT.weeklyDriftMaxPct);
  assert.ok(L.cushion >= 0 && L.cushion <= P.PROTECT.cushionMaxPct);
  assert.equal(L.newNumber, P.PROTECT.newNumberLiftPct, "a phone with no delivered order");
  assert.ok(Math.abs(L.pct - (L.weekly + L.cushion + L.newNumber + L.probe)) < 1e-9);
  // her lowest reachable price is above the approved Rs 850
  let r, t = 100;
  for (const m of ["900", "900", "880", "870", "860", "855", "851", "850", "850", "850", "850"]) {
    r = await say(p, m, t += 60);
    if (["accept", "closed"].includes(r.kind)) break;
  }
  const c = (await db.query(`SELECT status, state FROM bhao_conversations WHERE phone = $1`, [p])).rows[0];
  assert.notEqual(c.status, "accepted", "Rs 850 is below this conversation's lifted floor");
});

test("the weekly drift is the same for everyone and changes week to week; the cushion differs per conversation", () => {
  const a = new Date("2026-11-09T05:00:00Z"), b = new Date("2026-11-12T15:00:00Z"), next = new Date("2026-11-17T05:00:00Z");
  assert.equal(P.weekKey(a), P.weekKey(b), "Mon and Thu: same week");
  assert.notEqual(P.weekKey(a), P.weekKey(next));
  assert.equal(P.weeklyDrift("X", a), P.weeklyDrift("X", b));
  const drifts = new Set(Array.from({ length: 8 }, (_, i) => P.weeklyDrift("X", new Date(a.getTime() + i * 7 * 864e5)).toFixed(6)));
  assert.ok(drifts.size >= 6, "it really moves");
  const cushions = new Set(Array.from({ length: 20 }, (_, i) => P.cushion("923001234567:X:" + i).toFixed(6)));
  assert.ok(cushions.size >= 18);
  const lifted = P.liftFloors({ anchorPaisa: 180000, floorPaisa: 85000, groupTiers: [{ minQty: 5, floorPaisa: 75000 }] }, 0.13);
  assert.ok(lifted.floorPaisa > 85000 && lifted.floorPaisa <= 180000);
  assert.ok(lifted.groupTiers[0].floorPaisa >= 75000 && lifted.groupTiers[0].floorPaisa < lifted.floorPaisa);
});

test("a gold customer's floor is not lifted for being new; a prober's five fresh SIMs all are", async () => {
  const g = phone();
  await db.query(`INSERT INTO customers (phone, badge) VALUES ($1, 'gold')`, [g]);
  await say(g, "BHAO ASB-NG-TAWA", 0);
  const st = (await db.query(`SELECT state FROM bhao_conversations WHERE phone = $1`, [g])).rows[0].state;
  assert.equal(st.floorLift.newNumber, 0);
});

test("probe guard: several new numbers on one item within hours lift new numbers' floors for a day", async () => {
  const at0 = 30 * 86400; // a fresh day, away from other tests
  const sims = Array.from({ length: 5 }, () => phone());
  for (const [i, p] of sims.entries()) await say(p, "BHAO ASB-NG-JUG", at0 + i * 600);
  const lifts = [];
  for (const p of sims) lifts.push((await db.query(`SELECT state FROM bhao_conversations WHERE phone = $1 AND item_id = 'ASB-NG-JUG'`, [p])).rows[0].state.floorLift);
  assert.equal(lifts[3].probe, 0, "4th: only 3 others so far");
  assert.equal(lifts[4].probe, P.PROTECT.probe.liftPct, "5th: 4 other new numbers in 6 h");
  const later = phone();
  await say(later, "BHAO ASB-NG-JUG", at0 + 12 * 3600);
  assert.equal((await db.query(`SELECT state FROM bhao_conversations WHERE phone = $1`, [later])).rows[0].state.floorLift.probe,
    P.PROTECT.probe.liftPct, "held for a day");
  const g = phone();
  await db.query(`INSERT INTO customers (phone, badge) VALUES ($1, 'regular')`, [g]);
  await say(g, "BHAO ASB-NG-JUG", at0 + 13 * 3600);
  assert.equal((await db.query(`SELECT state FROM bhao_conversations WHERE phone = $1`, [g])).rows[0].state.floorLift.probe, 0,
    "real customers are never caught by the guard");
});
