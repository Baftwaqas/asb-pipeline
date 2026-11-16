// ============================================================================
// ASB PIPELINE — bhao/stories.js
// "ASLI KAHANIYAN" - real moments from history, played blind (founder, 16 Nov).
//
// The customer becomes the kaptaan who finds a ghost ship, the sarbarah who
// is offered a small internet company, the chief of a cave rescue... without
// knowing who or what it is. 4 decisions, 60 seconds each. Every choice plays
// out at once in a short scene; later scenes open differently because of
// earlier choices; three hidden meters decide one of three endings. Only then
// the reveal: what really happened, and which of her choices matched what the
// real people did.
//
//   * Out of time? Seth Ji does not wait: hesitation counts as the worst
//     choice of that scene ("aap sochte reh gaye...").
//   * Each story is played once per phone. Points join the same weekly society
//     leaderboard as Seth Ji ke Case.
//   * Stories come from a founder-approved bank (stories-bank.json); drafts are
//     playable only where BHAO_STORY_DRAFTS=on (the test service).
//   * Needs migration 029 (and 028 for the leaderboard); without it, silent.
// ============================================================================
"use strict";

const BANK = require("./stories-bank.json");

// DRAFT numbers - the founder reviews them with the rest.
const STORY = Object.freeze({ seconds: 60, graceSeconds: 4, perMeterPoint: 15, perRealMatch: 25, base: 50, perDay: 2 });
const STORIES = Object.fromEntries(BANK.stories.map((s) => [s.id, s]));
const LETTERS = ["A", "B", "C"];

function playable(env = process.env) {
  const drafts = String(env.BHAO_STORY_DRAFTS || "").toLowerCase() === "on";
  return BANK.stories.filter((s) => s.approved === true || drafts);
}

let readyCache = false;
async function ready(db) {
  if (readyCache) return true;
  readyCache = (await db.query(`SELECT to_regprocedure('asb029_stories_ready()') IS NOT NULL AS ok`)).rows[0].ok;
  return readyCache;
}
function karachiDayStart(now) {
  const d = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return new Date(d + "T00:00:00+05:00");
}

/** The scene message: the opening (changed by earlier choices), the three choices, the clock, A/B/C buttons, and its picture. */
function sceneMsg(play, now) {
  const s = STORIES[play.story_id];
  const sc = s.scenes[play.step];
  const flags = play.flags || [];
  const lead = Object.entries(sc.variants || {}).filter(([f]) => flags.includes(f)).map(([, t]) => t).join("");
  const choices = sc.choices.map((c, i) => `*${LETTERS[i]}.* ${c.t}`).join("\n");
  const head = play.step === 0 ? `${s.genre}\n🎭 *Aap hain: ${s.role}*\n\n` : "";
  return {
    type: "buttons",
    body: `${head}*Faisla ${play.step + 1}/${s.scenes.length}*\n${lead}${sc.text}\n\n${choices}\n\n⏱️ ${STORY.seconds} second - sochiye mat, faisla kijiye!`,
    buttons: sc.choices.map((_, i) => ({ id: `bhao:story:${play.id}:${play.step}:${i}`, title: `${LETTERS[i]} chunein` })),
    image: { kind: "story", storyId: s.id, step: play.step },
  };
}

function menuMsg(left) {
  return { type: "list",
    body: "📜 *Asli Kahaniyan*\nYeh sab sach mein hua tha. Aap us insaan ki jagah honge - lekin aap ko nahi bataya jayega ke woh kaun tha. 4 faisle, har faisle ke liye 60 second.\n\nAakhir mein raaz khulega: asal mein kya hua tha - aur kya aap ne wohi kiya jo unhon ne kiya?",
    buttonText: "Kahani chunein",
    sections: [{ title: "Kahaniyan", rows: left.map((s) => ({ id: `bhao:tale:${s.id}`, title: s.title.slice(0, 24), description: `${s.genre} · aap: ${s.role}`.slice(0, 72) })) }] };
}

async function unplayed(db, phone, env) {
  const done = new Set((await db.query(`SELECT story_id FROM bhao_story_plays WHERE phone = $1`, [phone])).rows.map((r) => r.story_id));
  return playable(env).filter((s) => !done.has(s.id));
}

async function begin(db, { phone, storyId, now, env }) {
  const s = STORIES[storyId];
  if (!s || !playable(env).some((x) => x.id === storyId)) return { kind: "story_menu", out: [menuMsg(await unplayed(db, phone, env))] };
  const today = (await db.query(`SELECT count(*)::int AS n FROM bhao_story_plays WHERE phone = $1 AND started_at >= $2`, [phone, karachiDayStart(now)])).rows[0].n;
  if (today >= STORY.perDay)
    return { kind: "story_limit", out: [{ type: "text", body: `Aaj ki ${STORY.perDay} kahaniyan ho gayin - dil ko thora aaram dein! Kal nayi kahani. Ranking dekhni ho toh LEADERBOARD likhein.` }] };
  const ins = await db.query(
    `INSERT INTO bhao_story_plays (phone, story_id, status, step_at, started_at) VALUES ($1, $2, 'playing', $3, $3)
     ON CONFLICT DO NOTHING RETURNING *`, [phone, storyId, now]);
  if (!ins.rowCount) return { kind: "story_menu", out: [menuMsg(await unplayed(db, phone, env))] };
  console.log(`[bhao] STORY start ${phone} ${storyId}`);
  return { kind: "story_begin", out: [sceneMsg(ins.rows[0], now)] };
}

/** Her choice (or her silence) for the scene she is on. */
async function choose(db, play, { choice, now }) {
  const s = STORIES[play.story_id];
  const sc = s.scenes[play.step];
  const late = now - new Date(play.step_at) > (STORY.seconds + STORY.graceSeconds) * 1000;
  // too slow: hesitation is a choice too - the worst one
  const sum = (c) => c.fx.reduce((a, b) => a + b, 0);
  const pick = late ? sc.choices.reduce((w, c, i) => (sum(c) < sum(sc.choices[w]) ? i : w), 0) : choice;
  const c = sc.choices[pick];
  const meters = (play.meters || [0, 0, 0]).map((m, i) => m + (c.fx[i] || 0));
  const flags = c.flag ? [...(play.flags || []), c.flag] : (play.flags || []);
  const picks = [...(play.picks || []), { choice: pick, late }];
  const next = play.step + 1;
  const lead = late ? `⏰ *Waqt khatam!* Aap sochte reh gaye... aur waqt ne faisla kar diya: *${c.t}*\n\n` : "";
  const then = `${lead}➜ ${c.then}`;
  if (next < s.scenes.length) {
    const up = await db.query(
      `UPDATE bhao_story_plays SET step = $2, flags = $3, meters = $4, picks = $5, step_at = $6 WHERE id = $1 AND status = 'playing' AND step = $7 RETURNING *`,
      [play.id, next, JSON.stringify(flags), JSON.stringify(meters), JSON.stringify(picks), now, play.step]);
    if (!up.rowCount) return { kind: "story_stale", out: [] };
    return { kind: "story_step", out: [{ type: "text", body: then }, sceneMsg(up.rows[0], now)] };
  }
  return finish(db, play, { then, meters, picks, flags, now });
}

async function finish(db, play, { then, meters, picks, flags, now }) {
  const s = STORIES[play.story_id];
  const total = meters.reduce((a, b) => a + b, 0);
  const ending = s.endings.find((e) => total >= e.min) || s.endings[s.endings.length - 1];
  const real = picks.map((p, i) => s.scenes[i].choices[p.choice].real === true && !p.late);
  const matches = real.filter(Boolean).length;
  const points = Math.max(0, STORY.base + total * STORY.perMeterPoint + matches * STORY.perRealMatch);
  const up = await db.query(
    `UPDATE bhao_story_plays SET status = 'done', ended_at = $2, meters = $3, picks = $4, flags = $5, points = $6, step = $7
      WHERE id = $1 AND status = 'playing' RETURNING id`,
    [play.id, now, JSON.stringify(meters), JSON.stringify(picks), JSON.stringify(flags), points, s.scenes.length]);
  if (!up.rowCount) return { kind: "story_stale", out: [] };
  const bar = (v) => (v > 0 ? "▲" : v < 0 ? "▼" : "•") + " " + (v > 0 ? "+" : "") + v;
  const meterLine = s.meters.map((m, i) => `${m}: ${bar(meters[i])}`).join("\n");
  const compare = s.scenes.map((sc, i) => {
    const mine = picks[i];
    const realIdx = sc.choices.findIndex((c) => c.real);
    return `${i + 1}. ${real[i] ? "✅ Bilkul wohi jo unhon ne kiya" : `❌ Aap: ${LETTERS[mine.choice]}${mine.late ? " (waqt khatam)" : ""} · Asal: ${LETTERS[realIdx]} - ${sc.choices[realIdx].t}`}`;
  }).join("\n");
  const verdict = matches === s.scenes.length ? "Aap ne har faisla bilkul wohi kiya jo tareekh mein hua! 🤯"
    : matches === 0 ? "Aap ne apni alag hi raah chuni - tareekh ka koi faisla aap se match nahi hua."
    : `${s.scenes.length} mein se ${matches} faisle tareekh se match hue.`;
  console.log(`[bhao] STORY DONE ${play.phone} ${s.id} total=${total} matches=${matches} points=${points} picks=${picks.map((p) => LETTERS[p.choice] + (p.late ? "*" : "")).join("")}`);
  return { kind: "story_done", out: [
    { type: "text", body: then },
    { type: "text", body: `🎬 *Anjaam*\n\n${ending.text}\n\n📊 *Aap ke chhupe hue meter*\n${meterLine}` },
    { type: "buttons", body: `🔓 *Raaz khulta hai...*\n\n${s.reveal}\n\n🧭 *Aap ke faisle vs asal faisle*\n${compare}\n${verdict}\n\n⭐ *+${points} points*`,
      buttons: [{ id: "bhao:tales:0", title: "📜 Agli kahani" }, { id: "bhao:play:board:0", title: "🏆 Leaderboard" }] },
  ], final: { points } };
}

const KEY = /^\s*(?:kahani|kahaniyan|kahaani|story|stories)\s*[.!?]*\s*$/i;

/**
 * Is this message part of a story? Null when not; else { kind, out }.
 * Called before the case router and the bargain flow.
 */
async function route(db, { phone, body, intent = null, now, env = process.env }) {
  if (!(await ready(db))) return null;
  const play = (await db.query(`SELECT * FROM bhao_story_plays WHERE phone = $1 AND status = 'playing'`, [phone])).rows[0];
  const m = /^story:(\d+):(\d+):(\d)$/.exec(intent || "");
  if (play) {
    let choice = null;
    if (m && Number(m[1]) === Number(play.id) && Number(m[2]) === play.step) choice = Number(m[3]);
    else if (!m) {
      const t = /^\s*([abc])\s*[.!]*\s*$/i.exec(String(body || ""));
      if (t) choice = LETTERS.indexOf(t[1].toUpperCase());
    }
    if (choice != null && choice >= 0 && choice < STORIES[play.story_id].scenes[play.step].choices.length) return choose(db, play, { choice, now });
    // anything else while the clock runs: if time is up, the silence decides
    if (now - new Date(play.step_at) > (STORY.seconds + STORY.graceSeconds) * 1000) return choose(db, play, { choice: 0, now });
    if (m) return { kind: "story_stale", out: [] }; // a tap on an old scene
    return { kind: "story_remind", out: [sceneMsg(play, now)] };
  }
  if (m) return { kind: "story_stale", out: [{ type: "text", body: "Yeh kahani khatam ho chuki hai. Nayi kahani ke liye KAHANI likh dein. 📜" }] };
  const pick = /^tale:([a-z0-9-]+)$/.exec(intent || "");
  if (pick) return begin(db, { phone, storyId: pick[1], now, env });
  if (KEY.test(String(body || "")) || intent === "tales") {
    const left = await unplayed(db, phone, env);
    if (!left.length) return { kind: "story_menu", out: [{ type: "text", body: "👏 Aap saari kahaniyan khel chuke! Nayi kahaniyan jald aa rahi hain." }] };
    return { kind: "story_menu", out: [menuMsg(left)] };
  }
  return null;
}

module.exports = { STORY, BANK, STORIES, playable, ready, route, sceneMsg, choose, begin, unplayed };
