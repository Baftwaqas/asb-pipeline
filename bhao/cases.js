// ============================================================================
// ASB PIPELINE — bhao/cases.js
// "SETH JI KE CASE" - the role-play game (founder, 15 Nov).
//
// The customer becomes a detective, a doctor, a pilot... (10 roles) and has
// 90 seconds to solve one case: read the story, open clues if she wants
// (each costs points), give her verdict. All on WhatsApp, in one list.
//
//   * In a bargain: when she is locked on a price Seth Ji can give, he offers
//     a case. Solve it in time and that price is hers (engine.winGame - never
//     below this bargain's line). Fail: no penalty, the bargain goes on.
//   * Any time: "CASE" starts a case for points (a few a day).
//   * Points count for her SOCIETY on a weekly leaderboard - once the society
//     she names is verified against the delivery address ASB has on record
//     (customers.society_id). Until then her points are kept, not counted.
//
// Fair and unarguable: cases come from a founder-approved bank
// (cases-bank.json); the verdict is checked against its key, never by the
// AI; answers are shuffled per play; each case is played once per phone; the
// clock runs from the moment the case is handed over.
//
// Everything here needs migration 028; without it the game simply is not
// offered.
// ============================================================================
"use strict";

const BANK = require("./cases-bank.json");

// DRAFT numbers - the founder reviews them with the rest.
const GAME = Object.freeze({
  seconds: 90, graceSeconds: 4,          // the clock; a little grace for the network
  base: 100, perClue: 20, minWin: 40,    // points: 100 + seconds left - 20 per clue, at least 40
  freePerDay: 3,                         // cases for points per phone per day
  perItemDays: 7,                        // one bargain game per item per week
  societyAwaitMinutes: 15,
});
const RANKS = Object.freeze([
  { min: 2500, label: "Society ka Sitara 🌟" },
  { min: 1000, label: "Ustad Dimagh 🧠" },
  { min: 300, label: "Tez Dimagh ⚡" },
  { min: 0, label: "Naya Khiladi 🎯" },
]);

const ROLE = Object.fromEntries(BANK.roles.map((r) => [r.key, r]));
const CASE = Object.fromEntries(BANK.cases.map((c) => [c.id, c]));

/** Cases that may be played: approved ones (drafts too when BHAO_CASE_DRAFTS=on - the test service). */
function playable(env = process.env) {
  const drafts = String(env.BHAO_CASE_DRAFTS || "").toLowerCase() === "on";
  return BANK.cases.filter((c) => c.approved === true || drafts);
}

let readyCache = false;
async function ready(db) {
  if (readyCache) return true;
  readyCache = (await db.query(`SELECT to_regprocedure('asb028_cases_ready()') IS NOT NULL AS ok`)).rows[0].ok;
  return readyCache;
}

function karachiDayStart(now) {
  const d = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return new Date(d + "T00:00:00+05:00");
}
/** Monday 00:00 Karachi time of this week. */
function weekStart(now) {
  const day = karachiDayStart(now);
  const dow = new Date(day.getTime() + 5 * 3600e3).getUTCDay(); // 0 = Sunday
  return new Date(day.getTime() - ((dow + 6) % 7) * 864e5);
}

async function unplayed(db, phone, env) {
  const done = new Set((await db.query(`SELECT case_id FROM bhao_case_plays WHERE phone = $1`, [phone])).rows.map((r) => r.case_id));
  return playable(env).filter((c) => !done.has(c.id));
}

async function playerOf(db, phone) {
  return (await db.query(
    `SELECT pl.*, s.name AS society_name FROM bhao_players pl LEFT JOIN societies s ON s.id = pl.society_id WHERE pl.phone = $1`, [phone])).rows[0] || null;
}
async function ensurePlayer(db, phone) {
  await db.query(`INSERT INTO bhao_players (phone) VALUES ($1) ON CONFLICT (phone) DO NOTHING`, [phone]);
  return playerOf(db, phone);
}
/** Her delivery society on ASB's record, if any. */
async function recordSociety(db, phone) {
  return (await db.query(
    `SELECT s.id, s.name FROM customers c JOIN societies s ON s.id = c.society_id WHERE c.phone = $1`, [phone])).rows[0] || null;
}
/** A society she named earlier becomes verified once ASB delivers to her there. */
async function refreshVerified(db, phone) {
  await db.query(
    `UPDATE bhao_players pl SET society_verified = TRUE, updated_at = now() FROM customers c
      WHERE pl.phone = $1 AND c.phone = pl.phone AND c.society_id IS NOT NULL AND c.society_id = pl.society_id
        AND NOT pl.society_verified`, [phone]);
}

// ---- society: ask, match, verify ------------------------------------------
const GENERIC = new Set(["society", "apartment", "apartments", "residency", "the", "co", "operative", "cooperative", "housing", "chs", "karachi"]);
const tokens = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9؀-ۿ]+/g, " ").trim().split(" ").filter((t) => t && !GENERIC.has(t));
/** The ASB society her words name, or null when none (or more than one) fits. */
async function matchSociety(db, text) {
  const mine = new Set(tokens(text));
  if (!mine.size) return null;
  const all = (await db.query(`SELECT id, code, name, name_ur FROM societies WHERE is_active`)).rows;
  let best = null, bestScore = 0, tie = false;
  for (const s of all) {
    const names = [s.name, s.name_ur].filter(Boolean).map(tokens).filter((t) => t.length);
    let score = mine.has(String(s.code).toLowerCase()) ? 1 : 0;
    for (const t of names) score = Math.max(score, t.filter((x) => mine.has(x)).length / t.length);
    if (score > bestScore) { best = s; bestScore = score; tie = false; } else if (score === bestScore && score > 0) tie = true;
  }
  return bestScore >= 0.6 && !tie ? best : null;
}

async function askSociety(db, phone, now) {
  await ensurePlayer(db, phone);
  const rec = await recordSociety(db, phone);
  if (rec) {
    await db.query(`UPDATE bhao_players SET awaiting = NULL, awaiting_at = $2, updated_at = now() WHERE phone = $1`, [phone, now]);
    return [{ type: "buttons",
      body: `🏘️ Leaderboard societies ke beech hai! Hamare record mein aap ki delivery *${rec.name}* pe hoti hai. Aap isi society ke liye khelenge?`,
      buttons: [{ id: `bhao:soc:yes:${rec.id}`, title: "Haan, yehi" }, { id: "bhao:soc:no:0", title: "Nahi, doosri hai" }] }];
  }
  await db.query(`UPDATE bhao_players SET awaiting = 'society', awaiting_at = $2, updated_at = now() WHERE phone = $1`, [phone, now]);
  return [{ type: "text", body: "🏘️ Leaderboard societies ke beech hai - aap ke points aap ki society ke khate mein jayenge!\n\nApni society ya apartments ka naam likh dein. (Abhi nahi batana? Dobara CASE likh dein.)" }];
}

async function setSociety(db, phone, text) {
  const rec = await recordSociety(db, phone);
  const m = await matchSociety(db, text);
  const verified = !!(m && rec && Number(rec.id) === Number(m.id));
  await db.query(
    `UPDATE bhao_players SET society_id = $2, society_text = $3, society_verified = $4, awaiting = NULL, updated_at = now() WHERE phone = $1`,
    [phone, m ? m.id : null, String(text).slice(0, 80), verified]);
  if (verified) return `✅ *${m.name}* - tasdeeq ho gayi, yehi aap ka delivery address hai. Aap ke points isi ke khate mein jayenge!`;
  console.log(`[bhao] TEAM CHECK: ${phone} plays for society ${JSON.stringify(String(text).slice(0, 80))}` +
    (m ? ` (matched ${m.name}; delivery record: ${rec ? rec.name : "none"})` : " (not in ASB's society list)"));
  const name = m ? m.name : String(text).slice(0, 60);
  return `📝 *${name}* likh liya. Tasdeeq tab hogi jab ASB ki delivery aap ke isi pate pe hogi - tab tak aap ke points mehfooz hain, aur tasdeeq hote hi society ke khate mein jurh jayenge.`;
}

// ---- the game --------------------------------------------------------------
const secondsLeft = (play, now) => Math.max(0, GAME.seconds - Math.floor((now - new Date(play.started_at)) / 1000));
const isLate = (play, now) => now - new Date(play.started_at) > (GAME.seconds + GAME.graceSeconds) * 1000;

/** The list under every step: the clues not opened yet, and the verdicts. */
function stepMsg(play, now, lead) {
  const c = CASE[play.case_id];
  const used = new Set(play.clues_used || []);
  const clueRows = c.clues.map((k, i) => ({ id: `bhao:case:${play.id}:c${i}`, title: k.label, description: `Suraagh kholein (-${GAME.perClue} point)` }))
    .filter((_, i) => !used.has(i));
  const sections = [
    ...(clueRows.length ? [{ title: "🔍 Suraagh", rows: clueRows }] : []),
    { title: "⚖️ Aap ka faisla", rows: play.options.map((o, i) => ({ id: `bhao:case:${play.id}:v${i}`, title: o })) },
  ];
  return { type: "list", body: `${lead}\n\n❓ *${c.question}*\n⏱️ Baqi: ${secondsLeft(play, now)} second`, buttonText: "Suraagh ya Faisla", sections };
}

async function roleMenu(db, { phone, convId = 0, env }) {
  const left = await unplayed(db, phone, env);
  if (!left.length) return [{ type: "text", body: "👏 Aap sab case hal kar chuke! Naye case jald aa rahe hain - Seth Ji likh rahe hain." }];
  const keys = new Set(left.map((c) => c.role));
  return [{ type: "list",
    body: `🎭 *Seth Ji ke Case*\nAaj kaun banenge? Role chunein - case milte hi *${GAME.seconds} second* ki ghari shuru!\n\nJitna tez hal karein, utne zyada points. Har suraagh kholne pe -${GAME.perClue} point.`,
    buttonText: "Role chunein",
    sections: [{ title: "Role", rows: BANK.roles.filter((r) => keys.has(r.key))
      .map((r) => ({ id: `bhao:role:${r.key}:${convId || 0}`, title: `${r.emoji} ${r.name}`, description: r.desc })) }] }];
}

async function freeToday(db, phone, now) {
  return (await db.query(
    `SELECT count(*)::int AS n FROM bhao_case_plays WHERE phone = $1 AND mode = 'free' AND started_at >= $2`, [phone, karachiDayStart(now)])).rows[0].n;
}

/** Hand her a case in this role and start the clock. */
async function begin(db, { phone, roleKey, convId = null, now, env }) {
  const left = await unplayed(db, phone, env);
  const mine = left.filter((c) => c.role === roleKey);
  const pool = mine.length ? mine : left;
  if (!pool.length) return roleMenu(db, { phone, env });
  const c = pool[Math.floor(Math.random() * pool.length)];
  const options = [...c.options].sort(() => Math.random() - 0.5);
  const play = (await db.query(
    `INSERT INTO bhao_case_plays (phone, case_id, role, mode, conversation_id, status, options, started_at)
     VALUES ($1, $2, $3, $4, $5, 'playing', $6, $7) RETURNING *`,
    [phone, c.id, c.role, convId ? "bargain" : "free", convId, JSON.stringify(options), now])).rows[0];
  const r = ROLE[c.role];
  console.log(`[bhao] CASE start ${phone} ${c.id} (${play.mode})`);
  return [stepMsg(play, now, `${r.emoji} *Aap hain: ${r.you}*\n📁 Case: *${c.title}*\n\n${c.brief}`)];
}

function pointsFor(play, now) {
  const used = Math.min(GAME.seconds, Math.round((now - new Date(play.started_at)) / 1000));
  return { seconds: used, points: Math.max(GAME.minWin, GAME.base + (GAME.seconds - used) - GAME.perClue * (play.clues_used || []).length) };
}

async function finish(db, play, { result, now }) {
  const c = CASE[play.case_id], r = ROLE[c.role];
  const p = pointsFor(play, now);
  const points = result === "won" ? p.points : 0;
  const done = await db.query(
    `UPDATE bhao_case_plays SET status = $2, ended_at = $3, seconds_used = $4, points = $5 WHERE id = $1 AND status = 'playing' RETURNING id`,
    [play.id, result, now, p.seconds, points]);
  if (!done.rowCount) return { kind: "case_stale", out: [] };
  await ensurePlayer(db, play.phone);
  await refreshVerified(db, play.phone);
  const pl = await playerOf(db, play.phone);
  const clues = (play.clues_used || []).length;
  const head = result === "won"
    ? `✅ *Sahi jawab, ${r.you}!* ${c.explain}\n\n⏱️ ${p.seconds} second, ${clues} suraagh → *+${points} points* 🎉`
    : `${result === "timeout" ? "⏰ *Waqt khatam!*" : "❌ *Ghalat!*"} Sahi jawab: *${c.answer}*.\n${c.explain}`;
  const soc = result !== "won" ? ""
    : pl.society_verified && pl.society_name ? `\n🏘️ Points *${pl.society_name}* ke khate mein jurh gaye.`
    : pl.society_text ? `\n🏘️ Points mehfooz hain - *${pl.society_name || pl.society_text}* ki tasdeeq hote hi society ke khate mein jurh jayenge.`
    : "\n🏘️ Apni society ke liye khelna hai? *SOCIETY* likh dein.";
  console.log(`[bhao] CASE ${result.toUpperCase()} ${play.phone} ${c.id} role=${c.role} mode=${play.mode} seconds=${p.seconds} clues=${clues} points=${points}`);
  const bargain = play.mode === "bargain";
  const out = [bargain ? { type: "text", body: head + soc }
    : { type: "buttons", body: head + soc, buttons: [{ id: "bhao:play:more:0", title: "🎯 Ek aur case" }, { id: "bhao:play:board:0", title: "🏆 Leaderboard" }] }];
  return { kind: result === "won" ? "case_won" : "case_lost", out, final: { won: result === "won", bargain, playId: play.id, points } };
}

// ---- leaderboard -----------------------------------------------------------
async function leaderboard(db, { phone, now }) {
  await refreshVerified(db, phone);
  const rows = (await db.query(
    `SELECT s.id, s.name, sum(p.points)::int AS pts, count(DISTINCT p.phone)::int AS players
       FROM bhao_case_plays p
       JOIN bhao_players pl ON pl.phone = p.phone AND pl.society_verified AND pl.society_id IS NOT NULL
       JOIN societies s ON s.id = pl.society_id
      WHERE p.ended_at >= $1 AND p.points > 0
      GROUP BY s.id, s.name ORDER BY pts DESC, s.name`, [weekStart(now)])).rows;
  const me = (await db.query(
    `SELECT COALESCE(sum(points), 0)::int AS total, COALESCE(sum(points) FILTER (WHERE ended_at >= $2), 0)::int AS week,
            count(*) FILTER (WHERE status = 'won')::int AS solved
       FROM bhao_case_plays WHERE phone = $1`, [phone, weekStart(now)])).rows[0];
  const pl = await playerOf(db, phone);
  const rank = RANKS.find((r) => me.total >= r.min).label;
  const medal = ["🥇", "🥈", "🥉"];
  const lines = ["🏆 *Is hafte ka Leaderboard*"];
  if (!rows.length) lines.push("Abhi koi society board pe nahi - pehla number aap ki society ka ho sakta hai!");
  rows.slice(0, 5).forEach((r, i) => lines.push(`${medal[i] || `${i + 1}.`} ${r.name} - ${r.pts.toLocaleString("en-US")} points (${r.players} khiladi)`));
  const mine = pl && pl.society_verified ? rows.findIndex((r) => Number(r.id) === Number(pl.society_id)) : -1;
  if (mine >= 5) lines.push(`…\n${mine + 1}. ${rows[mine].name} - ${rows[mine].pts.toLocaleString("en-US")} points`);
  lines.push("", `👤 *Aap*: ${rank}`, `Is hafte ${me.week} points · kul ${me.total} points · ${me.solved} case hal`);
  if (!pl || (!pl.society_id && !pl.society_text)) lines.push("🏘️ Apni society ke liye khelna hai? *SOCIETY* likh dein.");
  else if (!pl.society_verified) lines.push(`🏘️ ${pl.society_name || pl.society_text}: tasdeeq baqi - ASB ki delivery is pate pe hote hi aap ke points board pe aa jayenge.`);
  return { rows, me, rank, text: lines.join("\n") };
}

// ---- bargain mode ----------------------------------------------------------
/** May Seth Ji offer a case in this bargain? Once per bargain, once per item per week, and only with a case left. */
async function mayOffer(db, { phone, itemId, state, now, env }) {
  if (state.game || !(await ready(db))) return false;
  const played = (await db.query(
    `SELECT 1 FROM bhao_conversations WHERE phone = $1 AND item_id = $2 AND started_at > $3
        AND state->'game'->>'status' IN ('won', 'lost') LIMIT 1`,
    [phone, itemId, new Date(now.getTime() - GAME.perItemDays * 864e5)])).rowCount;
  if (played) return false;
  if ((await db.query(`SELECT 1 FROM bhao_case_plays WHERE phone = $1 AND status = 'playing'`, [phone])).rowCount) return false;
  return (await unplayed(db, phone, env)).length > 0;
}

// ---- the router: every inbound message passes here first -------------------
const KEY_PLAY = /^\s*(?:case|cases|khel|game|khelo)\s*[.!?]*\s*$/i;
const KEY_BOARD = /^\s*(?:leaderboard|leader\s*board|ranking|rank|score|points)\s*[.!?]*\s*$/i;
const KEY_SOCIETY = /^\s*society\s*[.!?]*\s*$/i;
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");

async function startFree(db, { phone, now, env }) {
  const pl = await ensurePlayer(db, phone);
  // the first time: which society is she playing for? (asked once; she may skip)
  if (!pl.society_id && !pl.society_text && !pl.awaiting_at) return { kind: "case_society", out: await askSociety(db, phone, now) };
  if (pl.awaiting) await db.query(`UPDATE bhao_players SET awaiting = NULL WHERE phone = $1`, [phone]);
  if (await freeToday(db, phone, now) >= GAME.freePerDay)
    return { kind: "case_limit", out: [{ type: "text", body: `Aaj ke ${GAME.freePerDay} case ho gaye - dimagh ko aaram dein! 😄 Kal naye case. Ranking dekhni ho toh LEADERBOARD likhein.` }] };
  return { kind: "case_roles", out: await roleMenu(db, { phone, env }) };
}

/**
 * Is this message part of the game? Returns null when it is not (the bargain
 * flow reads it), else { kind, out: [messages to send now], final? }.
 * final = { won, bargain } when a case just ended; a bargain case then goes
 * on into the bargain flow (her price, or the bargain continues).
 */
async function route(db, { phone, body, intent = null, now, env = process.env }) {
  if (!(await ready(db))) return null;
  const text = String(body || "").trim();
  const play = (await db.query(`SELECT * FROM bhao_case_plays WHERE phone = $1 AND status = 'playing'`, [phone])).rows[0];

  // 1. a case is running: the clock decides first
  if (play) {
    if (isLate(play, now)) return finish(db, play, { result: "timeout", now });
    const c = CASE[play.case_id];
    const m = /^case:(\d+):([cv])(\d)$/.exec(intent || "");
    let kind = null, idx = null;
    if (m && Number(m[1]) === Number(play.id)) { kind = m[2]; idx = Number(m[3]); }
    else if (!m) { // typed verdict: the answer's own words
      const i = play.options.findIndex((o) => norm(o) === norm(text));
      if (i >= 0) { kind = "v"; idx = i; }
    }
    if (kind === "v" && idx < play.options.length)
      return finish(db, play, { result: play.options[idx] === c.answer ? "won" : "lost", now });
    if (kind === "c" && idx < c.clues.length) {
      const used = [...new Set([...(play.clues_used || []), idx])];
      await db.query(`UPDATE bhao_case_plays SET clues_used = $2 WHERE id = $1 AND status = 'playing'`, [play.id, JSON.stringify(used)]);
      play.clues_used = used;
      return { kind: "case_clue", out: [stepMsg(play, now, `🔍 *${c.clues[idx].label}*\n${c.clues[idx].text}`)] };
    }
    return { kind: "case_remind", out: [stepMsg(play, now, "⏳ Ghari chal rahi hai! Neeche se suraagh ya apna faisla chunein 👇")] };
  }
  if (/^case:/.test(intent || ""))
    return { kind: "case_stale", out: [{ type: "text", body: "Yeh case khatam ho chuka hai. Naya case chahiye toh CASE likh dein. 🎭" }] };

  // 2. she picked a role
  const role = /^role:([a-z]+):(\d+)$/.exec(intent || "");
  if (role && ROLE[role[1]]) {
    let convId = Number(role[2]) || null;
    if (convId) { // a bargain game: only while that bargain is waiting for her role
      const ok = (await db.query(
        `SELECT 1 FROM bhao_conversations WHERE id = $1 AND phone = $2 AND status = 'open' AND state->'game'->>'status' = 'choosing'`,
        [convId, phone])).rowCount;
      if (!ok) convId = null;
    }
    if (!convId && await freeToday(db, phone, now) >= GAME.freePerDay)
      return { kind: "case_limit", out: [{ type: "text", body: `Aaj ke ${GAME.freePerDay} case ho gaye - kal naye case! 😄` }] };
    const out = await begin(db, { phone, roleKey: role[1], convId, now, env });
    if (convId) await db.query(
      `UPDATE bhao_conversations SET state = jsonb_set(state, '{game,status}', '"playing"') WHERE id = $1`, [convId]);
    return { kind: "case_begin", out };
  }

  // 3. society
  const soc = /^soc:(yes|no)(?::(\d+))?$/.exec(intent || "");
  if (soc) {
    await ensurePlayer(db, phone);
    if (soc[1] === "yes") {
      const rec = await recordSociety(db, phone);
      if (rec && Number(rec.id) === Number(soc[2])) {
        await db.query(`UPDATE bhao_players SET society_id = $2, society_text = $3, society_verified = TRUE, awaiting = NULL, updated_at = now() WHERE phone = $1`,
          [phone, rec.id, rec.name]);
        const next = await startFree(db, { phone, now, env });
        return { kind: "case_society", out: [{ type: "text", body: `✅ *${rec.name}* - aap ke points isi ke khate mein jayenge!` }, ...next.out] };
      }
    }
    await db.query(`UPDATE bhao_players SET awaiting = 'society', awaiting_at = $2 WHERE phone = $1`, [phone, now]);
    return { kind: "case_society", out: [{ type: "text", body: "Theek hai - apni society ya apartments ka naam likh dein." }] };
  }
  if (KEY_SOCIETY.test(text)) {
    await ensurePlayer(db, phone);
    return { kind: "case_society", out: await askSociety(db, phone, now) };
  }

  // 4. play / leaderboard
  if (KEY_PLAY.test(text) || intent === "play:more") return startFree(db, { phone, now, env });
  if (KEY_BOARD.test(text) || intent === "play:board") {
    const b = await leaderboard(db, { phone, now });
    return { kind: "case_board", out: [{ type: "buttons", body: b.text, buttons: [{ id: "bhao:play:more:0", title: "🎯 Case khelein" }] }] };
  }

  // 5. she is typing her society's name (asked within the last few minutes)
  if (!intent && text.length >= 3 && text.length <= 60 && !/^\d+$/.test(text)) {
    const pl = await playerOf(db, phone);
    if (pl && pl.awaiting === "society" && pl.awaiting_at && now - new Date(pl.awaiting_at) < GAME.societyAwaitMinutes * 60000) {
      const said = await setSociety(db, phone, text);
      const next = await startFree(db, { phone, now, env });
      return { kind: "case_society", out: [{ type: "text", body: said }, ...next.out] };
    }
  }
  return null;
}

module.exports = { GAME, RANKS, BANK, ROLE, CASE, playable, ready, route, roleMenu, begin, finish, mayOffer, leaderboard,
                   matchSociety, setSociety, askSociety, weekStart, pointsFor, unplayed };
