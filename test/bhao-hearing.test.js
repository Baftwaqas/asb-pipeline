// Seth Ji HEARS before he speaks (bhao/understand.js) - every case from the
// founder's live test of 10 Nov. Needs a scratch Postgres (TEST_PG_URL).
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { Client } = require("pg");
const H = require("./support/harness");
const BW = require("../bhao/whatsapp");
const U = require("../bhao/understand");
const V = require("../bhao/voice");

let db, n = 0;
const T0 = new Date("2026-11-10T03:00:00Z");
const at = (sec) => new Date(T0.getTime() + sec * 1000);
const phone = () => "92332" + String(1000000 + ++n);
const wamid = () => "wamid.H" + ++n;
const spoken = [];
const speak = async (a) => { spoken.push(a); return { text: "Ji baji.", source: "template", rejected: [] }; };
const GROQ = { BHAO_VOICE_PROVIDER: "groq", GROQ_API_KEY: "test-key", GROQ_MODEL: "test-model" };
/** A model that reads every message as `reading` (JSON). */
const model = (reading) => async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: JSON.stringify(reading) } }] }) });
const say = (p, text, sec, extra = {}) => BW.onInbound(db, { phone: p, text, wamid: wamid(), now: at(sec), env: {}, speak, ...extra });
const hear = (p, text, sec, reading, extra = {}) => say(p, text, sec, { env: GROQ, fetchImpl: model(reading), ...extra });
const outbox = async (p) => (await db.query(
  `SELECT m.* FROM bhao_messages m JOIN bhao_conversations c ON c.id = m.conversation_id WHERE c.phone = $1 AND m.direction = 'out' ORDER BY m.id`, [p])).rows;
const conv = async (p) => (await db.query(`SELECT * FROM bhao_conversations WHERE phone = $1 ORDER BY id DESC LIMIT 1`, [p])).rows[0];
const R = (o) => ({ kind: "chat", offer: null, qty: null, accept: false, advance: null, claim_price: null, claim_where: null, address: null, note: "", ...o });

before(async () => {
  const url = await H.createDatabase("asb_test_hearing", path.join(__dirname, ".."), { grocery: false });
  db = new Client({ connectionString: url });
  await db.connect();
  for (const [id, name, anchor, floor] of [["DEGCHI", "Steel ki Degchi 5 litre", 180000, 85000], ["KARAHI", "Steel ki Karahi", 250000, 150000]])
    await db.query(
      `INSERT INTO bhao_items (item_id, variant_gid, name, anchor_paisa, floor_paisa, cost_paisa, group_tiers, max_qty, facts, approved_by)
       VALUES ($1, 'gid://shopify/ProductVariant/900001', $2, $3, $4, 60000, '[{"minQty":3,"floorPaisa":140000}]', 20, '[]', 'test')`, [id, name, anchor, floor]);
});
after(async () => { if (db) await db.end(); });

test("'Sirf 70 rupay ka discount?' is a complaint, not an offer of Rs 70 - no 'nuqsan ho jayega'", async () => {
  const p = phone();
  await say(p, "BHAO KARAHI", 0);
  const r = await hear(p, "Sirf 70 rupay ka discount?bhai kia tu buhut hi bura hae", 100,
    R({ kind: "complaint", note: "complains the advance discount is only Rs 70" }));
  assert.equal(r.kind, "talk", "no bargaining move at all");
  assert.equal(spoken.at(-1).understood.note, "complains the advance discount is only Rs 70", "the voice is told what to answer");
  assert.equal((await conv(p)).state.round, 0, "the engine never saw a Rs 70 offer");
});

test("the rules alone would have read Rs 70 as her offer - which is why the model reads first", async () => {
  assert.equal(BW.readOffer("Sirf 70 rupay ka discount?"), 7000);
});

test("what the model says is checked against her words: an offer she never wrote is ignored", async () => {
  const p = phone();
  await say(p, "BHAO KARAHI", 0);
  const r = await hear(p, "Bhai kam karo na", 100, R({ kind: "offer", offer: 500 }));
  assert.equal(r.kind, "talk");
  const h = await U.understand({ latest: "Bhai kam karo na", readOffer: BW.readOffer, readQty: BW.readQty, env: GROQ, fetchImpl: model(R({ offer: 500 })) });
  assert.equal(h.offerPaisa, null);
  assert.deepEqual(h.dropped, ["offer 500"]);
});

test("a real bid inside a sentence is read: '2400 mein de do' bargains at Rs 2,400", async () => {
  const p = phone();
  await say(p, "BHAO KARAHI", 0);
  const r = await hear(p, "Achha chalo 2400 mein de do", 100, R({ kind: "offer", offer: 2400 }));
  assert.notEqual(r.kind, "talk");
  assert.equal((await conv(p)).state.round, 1);
});

test("'theek hai, bhej do' agrees to his CURRENT price; 'accept' without words of agreement is ignored", async () => {
  const p = phone();
  await say(p, "BHAO DEGCHI", 0);
  const no = await hear(p, "Hmm sochti hoon", 100, R({ accept: true }));
  assert.equal(no.kind, "talk");
  const yes = await hear(p, "Theek hai bhej do", 200, R({ kind: "accept", accept: true }));
  assert.equal(yes.kind, "accept");
  assert.equal((await conv(p)).accepted_offer.unitPaisa, 180000);
});

test("founder 10 Nov: never assume 'baji' - the greeting asks, a tap on 'Bhai' is remembered, and every later line follows it", async () => {
  const p = phone();
  await say(p, "BHAO KARAHI", 0);
  const [greet, card] = await outbox(p);
  assert.equal(greet.decision.askAddress, true);
  assert.deepEqual(greet.ui.buttons.map((b) => b.title), ["Baji", "Bhai", "Kuch aur"]);
  assert.doesNotMatch(card.ui.text, /\bbaji\b/i);
  const id = greet.ui.buttons[1].id;
  const tap = BW.fromButton(id);
  assert.equal(tap.intent, "address:bhai");
  const r = await say(p, tap.text, 30, { intent: tap.intent });
  assert.equal(r.kind, "talk");
  assert.equal((await conv(p)).state.address, "bhai");
  assert.equal((await outbox(p)).at(-1).body, "Ji bhai.", "the stock 'Ji baji.' became 'Ji bhai.'");
  await say(p, "2000", 60);
  assert.deepEqual(spoken.at(-1).address, { word: "bhai", gender: "m", known: true });
  // a new bargain later: not asked again
  await say(p, "BHAO DEGCHI", 3600);
  const lastOpen = (await outbox(p)).filter((o) => o.decision.kind === "open").at(-1);
  assert.equal(lastOpen.decision.askAddress, undefined, "asked once, remembered");
});

test("typed answers work too: 'Kuch aur' asks what to call them, and 'Ahmed sahab' is then used", async () => {
  const p = phone();
  await say(p, "BHAO KARAHI", 0);
  const other = BW.fromButton("bhao:addr:1:other");
  await say(p, other.text, 20, { intent: other.intent });
  assert.equal(spoken.at(-1).decision.addressOther, true);
  await hear(p, "Ahmed sahab", 40, R({ kind: "address", address: "Ahmed sahab" }));
  assert.equal((await conv(p)).state.address, "Ahmed sahab");
  assert.equal(U.addressify("Ji baji, aap kitne mein lengi?", U.addressInfo("Ahmed sahab")), "Ji Ahmed sahab, aap kitne mein lenge?");
});

test("without the model, a plain 'bhai' answer is still understood", async () => {
  const p = phone();
  await say(p, "BHAO KARAHI", 0);
  await say(p, "bhai", 20);
  assert.equal((await conv(p)).state.address, "bhai");
});

test("addressing: unknown -> no address word and plural verbs; 'baji' -> as before", () => {
  assert.equal(U.addressify("Kya baji, mazaaq kar rahi hain? 😐", { known: false }), "Kya mazaaq kar rahe hain? 😐");
  assert.equal(U.addressify("Ji baji, aap kitne mein lengi?", U.addressInfo("baji")), "Ji baji, aap kitne mein lengi?");
  const c = (t, address) => V.checkReply(t, { decision: { kind: "talk" }, qty: 1, address }).why.join();
  assert.match(c("Ji baji, boliye.", { known: false }), /address not known/);
  assert.match(c("Ji baji, boliye.", U.addressInfo("bhai")), /call them "bhai"/);
  assert.equal(c("Ji bhai, boliye.", U.addressInfo("bhai")), "");
});

test("live test 10 Nov: after 'sauda ho chuka', 'Mera tu koi sauda nhi hua' is answered, not met with silence", async () => {
  const p = phone();
  await say(p, "BHAO DEGCHI", 0);
  await say(p, "Rs 1,800", 60);
  assert.equal((await conv(p)).status, "accepted");
  const g = await say(p, "BHAO DEGCHI", 7200);
  assert.equal(g.guarded, "deal_cooldown");
  const r = await say(p, "Mera tu koi sauda nhi hua, bhai", 7300);
  assert.equal(r.kind, "guarded");
  assert.equal((await outbox(p)).at(-1).decision.kind, "guarded", "a reply is queued");
  const line = V.template({ kind: "guarded", reason: "deal_cooldown" }, {});
  assert.match(line, /hafte mein ek sauda/, "the rule, plainly");
  assert.doesNotMatch(line, /check|theek kar/, "founder 12 Nov: no false 'team will check' promise");
  const again = await say(p, "?", 9000);
  assert.equal(again.kind, "guarded", "and again");
});

test("tapping an item that is refused does not end the bargain she is in the middle of", async () => {
  const p = phone();
  await say(p, "BHAO DEGCHI", 0);
  await say(p, "Rs 1,800", 60);
  await say(p, "BHAO KARAHI", 600);
  await say(p, "2000", 700);
  await say(p, "BHAO DEGCHI", 900); // refused: deal done this week
  const karahi = (await db.query(`SELECT status FROM bhao_conversations WHERE phone = $1 AND item_id = 'KARAHI'`, [p])).rows[0];
  assert.equal(karahi.status, "open");
});

test("the menu leaves out items she already bought this week", async () => {
  const p = phone();
  await say(p, "BHAO DEGCHI", 0);
  await say(p, "Rs 1,800", 60);
  const r = await say(p, "bhao", 600);
  assert.deepEqual(r.menu.map((m) => m.id), ["bhao:item:KARAHI"]);
  assert.doesNotMatch(r.menuText, /baji/);
});

test("joke-low again and again: the second time he reminds her of the real price instead of 'nuqsan' once more", async () => {
  const p = phone();
  await say(p, "BHAO KARAHI", 0);
  await say(p, "300", 100);
  assert.equal(spoken.at(-1).decision.kind, "lowball_check");
  assert.equal(spoken.at(-1).decision.lowballCount, 1);
  await say(p, "300", 300);
  const d = spoken.at(-1).decision;
  assert.equal(d.lowballCount, 2);
  assert.equal(V.priceOf(d), 250000, "he may remind her: Rs 2,500");
  assert.match(V.template(d, {}), /Rs 2,500/);
});

test("the same excuse twice is a repeat however it is spelt; a true difference (advance: Rs 70 less) may be said", () => {
  const talk = { kind: "talk", askPaisa: 250000, perkQuotes: [{ key: "advance", label: "advance", askPaisa: 243000 }] };
  assert.match(V.checkReply("Arre, itni kam keemat se mera nuksan ho jayega.", { decision: { kind: "lowball_check" }, qty: 1, lastSaid: ["Itni kam daam par to mera nuqsan ho jayega."] }).why.join(), /nuqsan/);
  assert.equal(V.checkReply("Ji, advance pe Rs 70 kam - Rs 2,430. Warna COD pe Rs 2,500.", { decision: talk, qty: 1 }).why.join(), "");
  assert.match(V.checkReply("Chalo 300 mein de dunga.", { decision: { kind: "talk", askPaisa: 250000 }, qty: 1, herNumbers: [300] }).why.join(), /never agree to her number/);
  assert.match(V.checkReply("Haath kaam ho jayega.", { decision: { kind: "refuse" }, qty: 1 }).why.join(), /idiom/);
});

test("'Advance pe kitna?' tapped, then 'Is pe kitna ho jayega' typed: he answers with the real advance price", async () => {
  const p = phone();
  await say(p, "BHAO KARAHI", 0);
  const adv = BW.fromButton("bhao:adv:1");
  await say(p, adv.text, 20, { intent: adv.intent });
  await hear(p, "Is pr kitna hu gae ga", 25, R({ kind: "question", advance: "ask" }));
  const d = spoken.at(-1).decision;
  assert.equal(d.perkQuotes[0].key, "advance");
  assert.ok(d.perkQuotes[0].askPaisa < 250000);
  assert.doesNotMatch(V.template(d, {}), /COD bilkul chalega/);
  assert.match(V.template(d, {}), /cash on delivery pe Rs 2,500/);
});

test("a competitor claim from elsewhere ('Joria bazaar') is passed to the voice as such, never checked as OUR sale", async () => {
  const p = phone();
  await say(p, "BHAO KARAHI", 0);
  await hear(p, "Nhi bhai yeh tu 300 ka hi hae, joria bazaar sae meri sali laei hae", 50,
    R({ kind: "claim", claim_price: 300, claim_where: "elsewhere", note: "says sister-in-law bought it for 300 at Joria bazaar" }));
  const a = spoken.at(-1);
  assert.equal(a.claim, null);
  assert.equal(a.understood.claimWhere, "elsewhere");
  assert.match(V.buildPrompt({ decision: a.decision, itemName: "Steel ki Karahi", qty: 1, customerText: "x", understood: a.understood }).user, /somewhere else/);
});

test("live test 10 Nov: 'Tum kia bot hu?' is answered honestly - never a claim to be human", async () => {
  const msgs = ["Tum kia bot hu?"];
  const f = (text) => async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: text } }] }) });
  const base = { decision: { kind: "talk", askPaisa: 180000 }, itemName: "Degchi", customerMessages: msgs, env: GROQ };
  const lie = await V.speak({ ...base, fetchImpl: f("Nahi nahi, main toh asli insaan hoon! Boliye kitne mein lenge?") });
  assert.equal(lie.source, "template", "a denial is never sent");
  assert.match(lie.rejected[0], /never claim to be human/);
  assert.match(lie.text, /AI bhao assistant/);
  const honest = await V.speak({ ...base, fetchImpl: f("Ji, main Apna Sasta Bazaar ka AI bhao assistant hoon - daam ASB tay karta hai. Aap boliye, kitne mein lenge?") });
  assert.equal(honest.source, "ai");
  const plain = await V.speak({ ...base, customerMessages: ["kitne ki hai?"], fetchImpl: f("Rs 1,800 ki hai, mota steel. Aap boliye?") });
  assert.equal(plain.source, "ai", "no AI talk when nobody asked");
});

test("live test 10 Nov: the greeting goes out within seconds, and asking again does not cancel it", async () => {
  const p = phone();
  await say(p, "BHAO KARAHI", 0);
  const greet = (await outbox(p)).find((o) => o.decision.kind === "open");
  assert.ok(new Date(greet.send_after) - at(0) <= 3000);
  await say(p, "BHAO KARAHI", 5);
  const again = (await db.query(`SELECT send_status FROM bhao_messages WHERE id = $1`, [greet.id])).rows[0];
  assert.equal(again.send_status, "pending", "still going out");
});

test("founder 12 Nov: repeating the same number never wins - he holds his price until she moves up", () => {
  const B = require("../bhao/engine");
  const item = { itemId: "KARAHI", variantGid: "gid://shopify/ProductVariant/1", bhaoTaoEnabled: true, isGrocery: false,
                 anchorPaisa: 250000, floorPaisa: 150000, costPaisa: 60000, maxQty: 20, approvedBy: "test", groupTiers: [] };
  const NOW = new Date("2026-11-12T06:00:00Z");
  let { state } = B.open({ conversationId: "S1", item, qty: 1, policy: BW.POLICY, seed: "stubborn" });
  const go = (p) => { const r = B.offer(state, { item, policy: BW.POLICY, pricePaisa: p, now: NOW }); state = r.state; return r.action; };
  go(150000); go(180000); go(187000);           // her live-test sequence
  const firstCounter = state.askPaisa;
  const asks = [];
  for (let i = 0; i < 4; i++) { const a = go(187000); asks.push(a.kind + ":" + (a.askPaisa || "")); if (state.status !== "open") break; }
  assert.ok(asks.every((x) => x === `counter:${firstCounter}`), "held at " + firstCounter + ": " + asks.join(", "));
  assert.equal(state.status, "open", "no deal for standing still");
  const moved = go(195000);
  assert.ok(["counter", "accept", "final_offer"].includes(moved.kind), "moving up gets him moving again");
});

test("founder 12 Nov: style rules are advice - after one rewrite the AI's own words go out; hard rules never bend", async () => {
  const f = (texts) => { let i = 0; return async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { content: texts[Math.min(i++, texts.length - 1)] } }] }) }); };
  const history = [{ from: "seth", text: "Arre, itni kam keemat pe mera nuqsan ho jayega." }];
  const base = { decision: { kind: "refuse", angle: "running_costs" }, itemName: "Karahi", customerMessages: ["1800"], history, env: GROQ };
  const soft = await V.speak({ ...base, fetchImpl: f(["Nuqsan ho jayega ji, thoda barhaiye.", "Is daam pe toh nuqsan hai ji, thoda aur barhaiye."]) });
  assert.equal(soft.source, "ai", "a style slip is not worth a stock line");
  assert.equal(soft.attempts, 2);
  const hard = await V.speak({ ...base, fetchImpl: f(["Chalo Rs 1,500 mein le lo.", "Rs 1,400 bas.", "Rs 1,300."]) });
  assert.equal(hard.source, "template", "a made-up price never goes out");
});

test("a stock line never goes out twice in a row", async () => {
  const d = { kind: "guarded", reason: "deal_cooldown", itemName: "Degchi" };
  const first = V.template(d, {});
  const r = await V.speak({ decision: d, itemName: "Degchi", customerMessages: ["kyun?"], history: [{ from: "seth", text: first }], env: {} });
  assert.notEqual(r.text, first);
});

test("the rule is told honestly: a daily-limit or abuse pause covers every item, so no 'try another item'; the first cancel warns, the second says advance", () => {
  const all = V.template({ kind: "guarded", reason: "daily_limit", everything: true, until: "2026-11-13T19:00:00Z" }, {});
  assert.doesNotMatch(all, /baqi cheez|koi aur cheez/i);
  assert.match(all, /14 Nov/);
  assert.match(V.buildPrompt({ decision: { kind: "guarded", reason: "daily_limit", everything: true }, itemName: "x", qty: 1, customerText: "why" }).user, /do NOT suggest another item/);
  assert.match(V.template({ kind: "cancel", cancelCount: 1 }, {}), /ek aur sauda cancel/);
  assert.match(V.template({ kind: "cancel", cancelCount: 2 }, {}), /advance payment ke saath/);
});

test("founder 12 Nov: about 3 in 10 bargains are stubborn - regulars too - decided privately as she walks in", () => {
  const B = require("../bhao/engine");
  const item = { itemId: "KARAHI", variantGid: "gid://shopify/ProductVariant/1", bhaoTaoEnabled: true, isGrocery: false,
                 anchorPaisa: 250000, floorPaisa: 150000, costPaisa: 60000, maxQty: 20, approvedBy: "test", groupTiers: [] };
  let n = 0;
  for (let i = 0; i < 1000; i++) if (B.open({ conversationId: "c" + i, item, qty: 1, policy: BW.POLICY, seed: "s" + i }).state.stubbornRatio) n++;
  assert.ok(n > 250 && n < 350, "about 30%: " + n);
  assert.equal(BW.POLICY.settleAtLastRound, false, "closing is not a must");
});

test("a stubborn Seth Ji stops half-way, holds, and lets her walk - no deal at the last round", () => {
  const B = require("../bhao/engine");
  const item = { itemId: "KARAHI", variantGid: "gid://shopify/ProductVariant/1", bhaoTaoEnabled: true, isGrocery: false,
                 anchorPaisa: 250000, floorPaisa: 150000, costPaisa: 60000, maxQty: 20, approvedBy: "test", groupTiers: [] };
  let seed = 0, o;
  do o = B.open({ conversationId: "st", item, qty: 1, policy: BW.POLICY, seed: "st" + ++seed }); while (!o.state.stubbornRatio);
  let state = o.state, a;
  const NOW = new Date("2026-11-12T06:00:00Z");
  for (let i = 0; i < 12 && state.status === "open"; i++) {
    const r = B.offer(state, { item, policy: BW.POLICY, pricePaisa: 160000 + i * 2000, now: NOW });
    state = r.state; a = r.action;
  }
  assert.notEqual(state.status, "accepted", "she climbed to Rs 1,820 - still below his half-way line");
  assert.ok(state.askPaisa >= 200000, "never below half-way (Rs 2,000): " + state.askPaisa);
  assert.equal(a.kind, "closed");
  assert.match(V.buildPrompt({ decision: a, itemName: "Karahi", qty: 1, customerText: "1820" }).user, /without giving in/);
});

test("'nahi chahiye, rehne do' before any deal is a walk-away, not a cancel - no penalty, graceful goodbye", async () => {
  const p = phone();
  await say(p, "BHAO KARAHI", 0);
  await say(p, "1500", 60);
  const r = await hear(p, "Rehne do bhai, nahi chahiye", 200, R({ kind: "walk_away" }));
  assert.equal(r.kind, "closed");
  assert.equal(spoken.at(-1).decision.walkedAway, true);
  const c = await conv(p);
  assert.equal(c.status, "closed");
  assert.notEqual(c.status, "cancelled");
  assert.equal(await require("../bhao/guard").cancelsOf(db, p, at(300)), 0, "never counted as a cancel");
  assert.match(V.template({ kind: "closed", walkedAway: true }, {}), /jab dil kare/);
  const back = await hear(p, "Bhai 1000 mein do", 400, R({ kind: "offer", offer: 1000 }));
  assert.equal(back.handled, false, "the bargain is over until she writes BHAO again");
});

test("'itne mein nahi, 2000 mein do' is still bargaining, not a walk-away", async () => {
  const p = phone();
  await say(p, "BHAO KARAHI", 0);
  const r = await hear(p, "Itne mein nahi chahiye, 2000 mein do", 60, R({ kind: "offer", offer: 2000 }));
  assert.notEqual(r.kind, "closed");
});

test("live test 12 Nov: a restart never resumes an ask from an older policy, never below his line, and no fake 47% 'victory'", async () => {
  const p = phone();
  // an old-policy bargain that got down to Rs 950
  await db.query(`INSERT INTO bhao_conversations (phone, item_id, status, state, policy_version, started_at, last_inbound_at, ended_at)
                  VALUES ($1, 'DEGCHI', 'expired', '{"askPaisa": 95000}', 'BHAO-DRAFT-2', $2, $2, $2)`, [p, at(-86400)]);
  await say(p, "BHAO DEGCHI", 0);
  assert.equal((await conv(p)).state.askPaisa, 180000, "old policy's ask is not carried over");
  // same policy: resumes, but never below this bargain's own line, and the victory measures from the resumed ask
  const q = phone();
  await say(q, "BHAO DEGCHI", 0, { env: { BHAO_STUBBORN: "off" } });
  await db.query(`UPDATE bhao_conversations SET state = jsonb_set(state, '{askPaisa}', '95000'), status = 'expired' WHERE phone = $1`, [q]);
  await say(q, "BHAO DEGCHI", 600, { env: { BHAO_STUBBORN: "off" } });
  const c = await conv(q);
  assert.ok(c.state.askPaisa >= 95000 && c.state.askPaisa < 180000, "resumed - but never below this bargain's own line: " + c.state.askPaisa);
  assert.equal(c.state.events.find((e) => e.kind === "open").askPaisa, c.state.askPaisa);
  await say(q, String(c.state.askPaisa / 100), 700);
  assert.equal((await conv(q)).status, "accepted");
  assert.equal((await outbox(q)).find((o) => o.decision.kind === "victory"), undefined, "paying the price he opened at is no victory");
});

test("live test 12 Nov: never 'aapka advance already price mein shamil hai' - she must pay it", () => {
  const d = { kind: "accept", offer: { unitPaisa: 95000, why: "offer_meets_ask" }, askPaisa: 95000 };
  assert.match(V.checkReply("Rs 950 pe pakka - aapka advance already price mein shamil hai.", { decision: d, qty: 1 }).why.join(), /advance is not included/);
  assert.equal(V.checkReply("Rs 950 pe pakka! Yeh daam advance payment ke saath hai, payment delivery se pehle hogi.", { decision: d, qty: 1 }).why.join(), "");
});
