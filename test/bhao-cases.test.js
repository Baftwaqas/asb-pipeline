// "Seth Ji ke Case" - the 90-second role-play game and its society
// leaderboard (bhao/cases.js, migration 028). Founder, 15 Nov.
// Needs a scratch Postgres (TEST_PG_URL).
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { Client } = require("pg");
const H = require("./support/harness");
const BW = require("../bhao/whatsapp");
const C = require("../bhao/cases");
const RT = require("../bhao/runtime");

let db, n = 0, gulshan, rufi;
const T0 = new Date("2026-11-16T04:00:00Z"); // a Monday morning in Karachi
const at = (sec) => new Date(T0.getTime() + sec * 1000);
const phone = () => "92334" + String(1000000 + ++n);
const wamid = () => "wamid.C" + ++n;
const speak = async () => ({ text: "Ji.", source: "template", rejected: [] });
const ON = { BHAO_CASE_DRAFTS: "on", BHAO_STUBBORN: "off", BHAO_FLOOR_PROTECT: "off" };
const say = (p, text, sec, extra = {}) => BW.onInbound(db, { phone: p, text, wamid: wamid(), now: at(sec), env: ON, speak, ...extra });
const tap = (p, id, sec) => { const t = BW.fromButton(id); assert.ok(t, id); return say(p, t.text, sec, { intent: t.intent }); };
const play = async (p) => (await db.query(`SELECT * FROM bhao_case_plays WHERE phone = $1 ORDER BY id DESC LIMIT 1`, [p])).rows[0];
const conv = async (p) => (await db.query(`SELECT * FROM bhao_conversations WHERE phone = $1 ORDER BY id DESC LIMIT 1`, [p])).rows[0];
const rowsOf = (m) => m.sections.flatMap((s) => s.rows);
/** Tap the right (or a wrong) verdict of her running case. */
async function verdict(p, right, sec) {
  const pl = await play(p);
  const c = C.CASE[pl.case_id];
  const i = right ? pl.options.indexOf(c.answer) : pl.options.findIndex((o) => o !== c.answer);
  return tap(p, `bhao:case:${pl.id}:v${i}`, sec);
}
/** A player whose society is already settled, so CASE goes straight to the roles. */
async function settled(p, { society = null, verified = false } = {}) {
  await db.query(`INSERT INTO bhao_players (phone, society_id, society_text, society_verified, awaiting_at) VALUES ($1, $2, $3, $4, $5)`,
    [p, society, society ? "x" : null, verified, at(-100)]);
  if (verified) await db.query(`INSERT INTO customers (phone, society_id) VALUES ($1, $2)`, [p, society]);
}

before(async () => {
  const url = await H.createDatabase("asb_test_cases", path.join(__dirname, ".."), { grocery: false });
  db = new Client({ connectionString: url });
  await db.connect();
  await db.query(
    `INSERT INTO bhao_items (item_id, variant_gid, name, anchor_paisa, floor_paisa, cost_paisa, group_tiers, max_qty, facts, approved_by)
     VALUES ('KARAHI', 'gid://shopify/ProductVariant/900001', 'Steel ki Karahi', 250000, 150000, 60000, '[]', 20, '[]', 'test')`);
  gulshan = (await db.query(`INSERT INTO societies (code, name) VALUES ('GH', 'Gulshan Heights') RETURNING id`)).rows[0].id;
  rufi = (await db.query(`INSERT INTO societies (code, name) VALUES ('RLD', 'Rufi Lake Drive') RETURNING id`)).rows[0].id;
});
after(async () => { if (db) await db.end(); });

test("the case bank: 10 roles, 2 cases each, four answers and a clue for each (founder, 15 Nov), all fitting one WhatsApp message; nothing is live until approved", () => {
  assert.equal(C.BANK.roles.length, 10);
  for (const r of C.BANK.roles) {
    assert.ok(`${r.emoji} ${r.name}`.length <= 24 && r.desc.length <= 72, r.key);
    assert.ok(C.BANK.cases.filter((c) => c.role === r.key).length >= 2, r.key);
  }
  for (const c of C.BANK.cases) {
    assert.equal(c.options.length, 4, c.id);
    assert.equal(c.clues.length, 4, c.id + ": one clue per answer - the right one too");
    assert.ok(c.options.includes(c.answer) && new Set(c.options).size === 4, c.id);
    assert.ok(c.clues.every((k) => k.label.length <= 24), c.id);
    // the whole case - story, question, all four answers - fits one list message (1,024 characters)
    const r = C.ROLE[c.role];
    const body = `${r.emoji} *Aap hain: ${r.you}*\n📁 Case: *${c.title}*\n\n${c.brief}\n\n❓ *${c.question}*\n` +
      c.options.map((o) => `*A.* ${o}`).join("\n") + "\n\n⏱️ Baqi: 90 second";
    assert.ok(body.length <= 1024, c.id + " " + body.length);
    for (const k of c.clues) assert.ok(`🔍 *${k.label}*\n${k.text}`.length + body.length - c.brief.length - 60 <= 1024, c.id + " clue");
  }
  assert.equal(C.playable({}).length, C.BANK.cases.filter((c) => c.approved).length);
  assert.equal(C.playable({ BHAO_CASE_DRAFTS: "on" }).length, 20);
});

test("the cases are written the way Pakistanis type Roman Urdu - no bookish words (founder, 15 Nov)", () => {
  const all = JSON.stringify(C.BANK).toLowerCase() ;
  for (const w of ["suraagh", "mushahid", "nazariy", "nateej", "haqaiq", "qiyas", "tasdeeq", "wazahat", "daleel", "tarbiyat", "bulandi", "imkaan", "bandargah", "marammat", "mukhalif", "kaghzaat"])
    assert.ok(!all.replace(/"note":"[^"]*"/, "").includes(w), w);
});

test("the necklace case is airtight: only one suspect leaves exactly one true statement", () => {
  const says = { Shabana: (t) => t === "Bilal", Bilal: (t) => t !== "Bilal", Hina: (t) => t !== "Hina" };
  const fits = ["Shabana", "Bilal", "Hina"].filter((thief) => Object.values(says).filter((f) => f(thief)).length === 1);
  assert.deepEqual(fits, ["Hina"]);
  assert.equal(C.CASE.j2v3.answer, "Hina ne");
});

test("CASE the first time asks her society; a typed name is matched, kept as 'tasdeeq baqi', and the role menu follows", async () => {
  const p = phone();
  const a = await say(p, "case", 0);
  assert.equal(a.kind, "case_society");
  assert.match(a.out[0].body, /society ya apartments ka naam/);
  const b = await say(p, "gulshan heights apartments", 20);
  assert.match(b.out[0].body, /Gulshan Heights.*likh liya[\s\S]*Confirm tab hogi/);
  assert.equal(b.out[1].type, "list");
  assert.equal(rowsOf(b.out[1]).length, 10, "ten roles");
  const pl = (await db.query(`SELECT * FROM bhao_players WHERE phone = $1`, [p])).rows[0];
  assert.equal(Number(pl.society_id), Number(gulshan));
  assert.equal(pl.society_verified, false);
});

test("her delivery address on record: 'Haan, yehi' verifies at once", async () => {
  const p = phone();
  await db.query(`INSERT INTO customers (phone, society_id) VALUES ($1, $2)`, [p, rufi]);
  const a = await say(p, "CASE", 0);
  assert.match(a.out[0].body, /delivery \*Rufi Lake Drive\* pe hoti hai/);
  const b = await tap(p, a.out[0].buttons[0].id, 10);
  assert.match(b.out[0].body, /Rufi Lake Drive/);
  assert.equal(b.out[1].type, "list");
  assert.equal((await db.query(`SELECT society_verified FROM bhao_players WHERE phone = $1`, [p])).rows[0].society_verified, true);
  // someone else cannot claim that society by tapping a made-up button
  const q = phone();
  await say(q, "CASE", 0);
  await tap(q, `bhao:soc:yes:${rufi}`, 5);
  assert.equal((await db.query(`SELECT society_verified, society_id FROM bhao_players WHERE phone = $1`, [q])).rows[0].society_verified, false);
});

test("a case: story with clues and verdicts in one list; a clue costs 20; a right verdict in time scores 100 + seconds left - clues", async () => {
  const p = phone();
  await settled(p, { society: gulshan, verified: true });
  const menu = await say(p, "CASE", 0);
  assert.equal(menu.kind, "case_roles");
  const b = await tap(p, rowsOf(menu.out[0]).find((r) => r.id.includes(":jasoos:")).id, 10);
  assert.equal(b.kind, "case_begin");
  const pl = await play(p);
  assert.equal(pl.role, "jasoos");
  assert.match(b.out[0].body, /Aap hain: Inspector[\s\S]*Baqi: 90 second/);
  assert.deepEqual(b.out[0].sections.map((s) => s.rows.length), [4, 4]);
  assert.match(b.out[0].body, /\*A\.\* [\s\S]*\*D\.\* /, "all four answers written out");
  assert.deepEqual(b.out[0].sections[1].rows.map((x) => x.title), ["Jawab A", "Jawab B", "Jawab C", "Jawab D"]);
  assert.doesNotMatch(JSON.stringify(b.out), /"answer"|explain/, "the key never leaves the server");
  const clue = await tap(p, `bhao:case:${pl.id}:c1`, 30);
  assert.equal(clue.kind, "case_clue");
  assert.match(clue.out[0].body, /Baqi: 70 second/);
  assert.deepEqual(clue.out[0].sections.map((s) => s.rows.length), [3, 4], "an opened clue leaves the list");
  const w = await verdict(p, true, 50);
  assert.equal(w.kind, "case_won");
  assert.match(w.out[0].body, /\+130 points/, "100 + 50 left - 20");
  assert.match(w.out[0].body, /Gulshan Heights\* ke account mein/);
  assert.equal((await play(p)).points, 130);
  assert.deepEqual(w.out[0].buttons.map((x) => x.id), ["bhao:play:more:0", "bhao:play:board:0"]);
});

test("the clock: a verdict after 90 seconds is 'waqt khatam' with no points; a wrong verdict shows the answer; each case once", async () => {
  const p = phone();
  await settled(p);
  const menu = await say(p, "CASE", 0);
  await tap(p, rowsOf(menu.out[0])[0].id, 5);
  const late = await verdict(p, true, 5 + 96);
  assert.equal(late.kind, "case_lost");
  assert.match(late.out[0].body, /Time khatam[\s\S]*Sahi jawab/);
  assert.equal((await play(p)).status, "timeout");
  const first = (await play(p)).case_id;
  await tap(p, "bhao:play:more:0", 200);
  await tap(p, `bhao:role:${C.CASE[first].role}:0`, 205);
  assert.notEqual((await play(p)).case_id, first);
  const wrong = await verdict(p, false, 220);
  assert.match(wrong.out[0].body, /sab se sahi jawab nahi tha[\s\S]*Sahi jawab: \*[A-D]\.\*/);
  assert.equal((await play(p)).points, 0);
  const stale = await tap(p, `bhao:case:${(await play(p)).id}:v0`, 230);
  assert.equal(stale.kind, "case_stale");
});

test("three cases a day for points, then 'kal naye case'", async () => {
  const p = phone();
  await settled(p);
  for (let i = 0; i < 3; i++) {
    const m = await say(p, "CASE", i * 100);
    await tap(p, rowsOf(m.out[0])[i].id, i * 100 + 5);
    await verdict(p, true, i * 100 + 20);
  }
  assert.equal((await say(p, "CASE", 400)).kind, "case_limit");
  assert.equal((await say(p, "CASE", 400 + 86400)).kind, "case_roles", "a new day");
});

test("the leaderboard counts only verified societies; kept points join the board once ASB delivers to her there", async () => {
  const a = phone(), b = phone();
  await settled(a, { society: rufi, verified: true });
  await settled(b, { society: rufi, verified: false });
  for (const p of [a, b]) {
    const m = await say(p, "CASE", 1000);
    await tap(p, rowsOf(m.out[0])[2].id, 1005);
    await verdict(p, true, 1025);
  }
  const before = await C.leaderboard(db, { phone: b, now: at(1100) });
  const rufiBefore = before.rows.find((r) => Number(r.id) === Number(rufi));
  assert.equal(rufiBefore.pts, 170, "only the verified player's 100 + 70");
  assert.match(before.text, /confirm hona baqi/);
  await db.query(`INSERT INTO customers (phone, society_id) VALUES ($1, $2)`, [b, rufi]); // ASB now delivers to her there
  const after = await say(b, "leaderboard", 1200);
  assert.equal(after.kind, "case_board");
  assert.match(after.out[0].body, /Rufi Lake Drive - 340 points \(2 khiladi\)/);
  const next = await C.leaderboard(db, { phone: b, now: at(1200 + 8 * 86400) });
  assert.equal(next.rows.length, 0, "a new week starts from zero");
});

async function lockedAt(p, price) {
  await say(p, "BHAO KARAHI", 0);
  let r;
  for (const [i, b] of [price - 200, price - 100, price, price].entries()) r = await say(p, String(b), 100 + i * 100);
  return r;
}

test("stuck on a price in a bargain: Seth Ji offers a case; solved in time, that price is hers", async () => {
  const p = phone();
  const r = await lockedAt(p, 2200);
  assert.equal(r.kind, "game_offer");
  const c0 = await conv(p);
  const offer = (await db.query(`SELECT * FROM bhao_messages WHERE conversation_id = $1 ORDER BY id DESC LIMIT 1`, [c0.id])).rows[0];
  assert.match(offer.body, /90 second mein case solve kar liya toh Rs 2,200 aap ka/);
  assert.deepEqual(offer.ui.buttons.map((b) => b.id.split(":").pop()), ["yes", "no"]);
  const yes = await tap(p, offer.ui.buttons[0].id, 600);
  assert.equal(yes.kind, "game_started");
  assert.equal(yes.instant, true);
  const roleRow = rowsOf(yes.out[0]).find((x) => x.id.includes(":pilot:"));
  assert.ok(roleRow.id.endsWith(":" + c0.id), "the role menu belongs to this bargain");
  assert.equal((await tap(p, roleRow.id, 610)).kind, "case_begin");
  assert.equal((await play(p)).mode, "bargain");
  const w = await verdict(p, true, 640);
  assert.equal(w.kind, "accept");
  assert.match(w.out[0].body, /Sahi jawab, Captain/);
  const c = await conv(p);
  assert.equal(c.status, "accepted");
  assert.equal(c.accepted_offer.unitPaisa, 220000);
  assert.equal(c.accepted_offer.why, "game_won");
  const out = (await db.query(`SELECT body, decision FROM bhao_messages WHERE conversation_id = $1 AND direction = 'out' ORDER BY id`, [c.id])).rows;
  assert.ok(out.some((o) => /Case solve! Seth Ji haar gaye.*Rs 2,200/.test(o.body)));
  assert.match(out.find((o) => o.decision.kind === "victory").body, /Case solve, bhao jeeta/);
});

test("a case lost in a bargain: no penalty, the bargain goes on, and no second case on that item this week; 'Nahi' just bargains", async () => {
  const p = phone();
  await lockedAt(p, 2200);
  const c0 = await conv(p);
  const yes = await tap(p, `bhao:game:${c0.id}:yes`, 600);
  await tap(p, rowsOf(yes.out[0])[0].id, 605);
  const l = await verdict(p, false, 630);
  assert.equal(l.kind, "game_lost");
  assert.match(l.out[0].body, /sab se sahi jawab nahi tha/);
  const c = await conv(p);
  assert.equal(c.status, "open");
  assert.equal(c.state.game.status, "lost");
  assert.equal(await C.mayOffer(db, { phone: p, itemId: "KARAHI", state: {}, now: at(700), env: ON }), false);
  const q = phone();
  await lockedAt(q, 2200);
  const d0 = await conv(q);
  assert.equal((await tap(q, `bhao:game:${d0.id}:no`, 600)).kind, "game_declined");
});

test("game messages go out at once: a list with its parts, falling back to plain words", async () => {
  const calls = [];
  const send = {
    sendList: async (to, m) => { calls.push(["list", m.sections.length]); return { ok: false }; },
    sendButtons: async (to, m) => { calls.push(["buttons", m.buttons.length]); return { ok: true, wamid: "b" }; },
    sendText: async (to, body) => { calls.push(["text", body.slice(0, 5)]); return { ok: true, wamid: "t" }; },
  };
  await RT.sendOut(send, "92300", { type: "list", body: "Hello", buttonText: "x", sections: [{ title: "a", rows: [] }, { title: "b", rows: [] }] });
  await RT.sendOut(send, "92300", { type: "buttons", body: "Hi", buttons: [{ id: "a", title: "A" }] });
  assert.deepEqual(calls, [["list", 2], ["text", "Hello"], ["buttons", 1]]);
});

test("a typed letter is a verdict too: 'B' or 'jawab b'", async () => {
  const p = phone();
  await settled(p);
  const m = await say(p, "CASE", 0);
  await tap(p, rowsOf(m.out[0])[5].id, 5);
  const pl = await play(p);
  const letter = ["A", "B", "C", "D"][pl.options.indexOf(C.CASE[pl.case_id].answer)];
  const w = await say(p, "jawab " + letter.toLowerCase(), 40);
  assert.equal(w.kind, "case_won");
});
