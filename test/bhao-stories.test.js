// "Asli Kahaniyan" - real history played blind (bhao/stories.js, migration 029). Founder, 16 Nov.
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { Client } = require("pg");
const H = require("./support/harness");
const BW = require("../bhao/whatsapp");
const ST = require("../bhao/stories");
const C = require("../bhao/cases");
const RT = require("../bhao/runtime");

let db, n = 0;
const T0 = new Date("2026-11-16T04:00:00Z");
const at = (sec) => new Date(T0.getTime() + sec * 1000);
const phone = () => "92335" + String(1000000 + ++n);
const wamid = () => "wamid.S" + ++n;
const ON = { BHAO_STORY_DRAFTS: "on", BHAO_CASE_DRAFTS: "on" };
const speak = async () => ({ text: "Ji.", source: "template", rejected: [] });
const say = (p, text, sec, extra = {}) => BW.onInbound(db, { phone: p, text, wamid: wamid(), now: at(sec), env: ON, speak, ...extra });
const tap = (p, id, sec) => { const t = BW.fromButton(id); assert.ok(t, id); return say(p, t.text, sec, { intent: t.intent }); };
const play = async (p) => (await db.query(`SELECT * FROM bhao_story_plays WHERE phone = $1 ORDER BY id DESC LIMIT 1`, [p])).rows[0];

before(async () => {
  const url = await H.createDatabase("asb_test_stories", path.join(__dirname, ".."), { grocery: false });
  db = new Client({ connectionString: url });
  await db.connect();
});
after(async () => { if (db) await db.end(); });

test("the story bank: 4 scenes of 3 choices, a consequence for every choice, exactly one real choice per scene, endings from best to worst, sources for the reveal; none live until approved", () => {
  assert.equal(ST.playable({}).length, 0);
  for (const s of ST.BANK.stories) {
    assert.equal(s.scenes.length, 4, s.id);
    assert.equal(s.meters.length, 3, s.id);
    for (const sc of s.scenes) {
      assert.equal(sc.choices.length, 3, s.id);
      assert.equal(sc.choices.filter((c) => c.real).length, 1, s.id + ": one real choice");
      for (const c of sc.choices) { assert.ok(c.then && c.then.length > 60, s.id); assert.equal(c.fx.length, 3); }
      for (const f of Object.keys(sc.variants || {})) assert.ok(s.scenes.some((x) => x.choices.some((c) => c.flag === f)), s.id + " flag " + f);
    }
    assert.ok(s.endings[0].min > s.endings[1].min && s.endings[1].min > s.endings[2].min);
    assert.ok(s.sources.length >= 2 && s.reveal.length > 200);
    // the whole scene with all its choices fits one WhatsApp message
    for (let i = 0; i < 4; i++) {
      const longest = Math.max(...Object.values(s.scenes[i].variants || { x: "" }).map((v) => v.length));
      const m = ST.sceneMsg({ id: 1, story_id: s.id, step: i, flags: [] }, T0);
      assert.ok(m.body.length + longest <= 1024, `${s.id} scene ${i + 1}: ${m.body.length + longest}`);
    }
  }
});

test("the name is never given away before the reveal", () => {
  const giveaways = { "ghost-ship": /Mary Celeste|Dei Gratia|Briggs|Gibraltar/i, "50-million": /Blockbuster|Netflix|Antioco|Hastings/i, cave: /Tham Luang|Thailand|Thai|Saman/i };
  for (const s of ST.BANK.stories) {
    const journey = JSON.stringify([s.title, s.scenes, s.endings]);
    assert.doesNotMatch(journey, giveaways[s.id], s.id);
    assert.match(s.reveal, giveaways[s.id], s.id + ": the reveal names it");
  }
});

test("KAHANI shows the stories; a story plays scene by scene: each choice plays out, then the next scene with its picture and A/B/C buttons", async () => {
  const p = phone();
  const m = await say(p, "kahani", 0);
  assert.equal(m.kind, "story_menu");
  assert.equal(m.out[0].sections[0].rows.length, 3);
  const b = await tap(p, "bhao:tale:ghost-ship", 5);
  assert.equal(b.kind, "story_begin");
  assert.match(b.out[0].body, /Aap hain: Kaptaan[\s\S]*Faisla 1\/4[\s\S]*\*A\.\*[\s\S]*60 second/);
  assert.deepEqual(b.out[0].image, { kind: "story", storyId: "ghost-ship", step: 0 });
  const pl = await play(p);
  const s1 = await tap(p, `bhao:story:${pl.id}:0:1`, 20); // rush aboard -> flag "rushed"
  assert.equal(s1.kind, "story_step");
  assert.match(s1.out[0].body, /takhti toot/);
  assert.match(s1.out[1].body, /Faisla 2\/4[\s\S]*Zakhmi mallah/, "the next scene remembers what she did");
});

test("too slow: the clock decides - hesitation counts as the worst choice", async () => {
  const p = phone();
  await say(p, "KAHANI", 0);
  await tap(p, "bhao:tale:cave", 5);
  const pl = await play(p);
  const r = await tap(p, `bhao:story:${pl.id}:0:0`, 5 + 70);
  assert.match(r.out[0].body, /Waqt khatam[\s\S]*Sab chhor ke pahar|Waqt khatam[\s\S]*Khana bhejte/);
  assert.equal((await play(p)).picks[0].late, true);
});

test("the end: a dramatic ending, the hidden meters, the reveal, her choices against the real ones, and points on the society board", async () => {
  const p = phone();
  const gulshan = (await db.query(`INSERT INTO societies (code, name) VALUES ('GH2', 'Gulshan Towers') RETURNING id`)).rows[0].id;
  await db.query(`INSERT INTO customers (phone, society_id) VALUES ($1, $2)`, [p, gulshan]);
  await db.query(`INSERT INTO bhao_players (phone, society_id, society_text, society_verified) VALUES ($1, $2, 'x', TRUE)`, [p, gulshan]);
  await say(p, "KAHANI", 0);
  await tap(p, "bhao:tale:50-million", 5);
  let r;
  for (let i = 0; i < 4; i++) {
    const pl = await play(p);
    const realIdx = ST.STORIES["50-million"].scenes[i].choices.findIndex((c) => c.real);
    r = await tap(p, `bhao:story:${pl.id}:${i}:${realIdx}`, 10 + i * 20);
  }
  assert.equal(r.kind, "story_done");
  assert.match(r.out[1].body, /Anjaam[\s\S]*chhupe hue meter/);
  assert.match(r.out[2].body, /Raaz khulta hai[\s\S]*Blockbuster[\s\S]*har faisla bilkul wohi kiya/);
  const done = await play(p);
  assert.equal(done.status, "done");
  assert.ok(done.points > 0);
  const board = await C.leaderboard(db, { phone: p, now: at(200) });
  assert.equal(board.rows.find((x) => Number(x.id) === Number(gulshan)).pts, done.points);
  assert.equal((await say(p, "kahani", 300)).out[0].sections[0].rows.some((x) => x.id === "bhao:tale:50-million"), false, "each story once");
});

test("typed A/B/C works; an old button does nothing; two stories a day", async () => {
  const p = phone();
  await say(p, "KAHANI", 0);
  await tap(p, "bhao:tale:cave", 5);
  const pl = await play(p);
  assert.equal((await say(p, "b", 15)).kind, "story_step");
  assert.equal((await tap(p, `bhao:story:${pl.id}:0:2`, 20)).kind, "story_stale");
  for (let i = 1; i < 4; i++) await say(p, "a", 30 + i * 10);
  await tap(p, "bhao:tale:ghost-ship", 100);
  for (let i = 0; i < 4; i++) await say(p, "a", 110 + i * 10);
  const third = await tap(p, "bhao:tale:50-million", 200);
  assert.equal(third.kind, "story_limit");
});

test("a scene's picture goes on top of its buttons; without a picture, the words still go", async () => {
  const calls = [];
  const send = {
    uploadMedia: async () => ({ ok: true, id: "media-1" }),
    sendButtons: async (to, m) => { calls.push(m.headerImageId); return { ok: true, wamid: "w" }; },
    sendText: async () => ({ ok: true }),
  };
  await RT.sendOut(send, "92300", { type: "buttons", body: "x", buttons: [], image: { kind: "story", storyId: "ghost-ship", step: 1 } }, { render: async () => Buffer.from("jpg") });
  await RT.sendOut(send, "92300", { type: "buttons", body: "x", buttons: [], image: { kind: "story", storyId: "nope", step: 0 } }, { render: async () => null });
  assert.deepEqual(calls, ["media-1", null]);
});
