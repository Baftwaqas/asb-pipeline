// ============================================================================
// ASB PIPELINE — bhao/quiz.js
// "EARN YOUR BHAO" - Seth Ji's 3-question game (founder, 14 Nov).
//
// When she locks on a price and will not move, and that price is at or above
// the lowest he will go in this bargain (stubborn line included), he offers a
// game: 3 questions, tap answers, 30 seconds each. All three right: the deal
// is hers at her price. One wrong (or late): no penalty, he simply holds.
//
// Fair and unbeatable by argument:
//   * the questions come from a founder-approved bank (quiz-bank.json) and
//     the answers are checked against its key - never by the AI;
//   * the options are shuffled per game, so no "always the first button";
//   * 30 seconds from the moment the question was SENT - too short to search;
//   * one game per item per phone per week, offered once per bargain;
//   * a win can never go below the bargain's own line: the engine checks it.
// ============================================================================
"use strict";

const BANK = require("./quiz-bank.json");

// Founder, 14 Nov: the quiz felt like "just another questionnaire" - RETIRED.
// The code stays (tested) in case a new game reuses its parts; it never runs.
const QUIZ = Object.freeze({ enabled: false, questions: 3, answerSeconds: 30, perItemDays: 7, holdsBeforeGame: 1 });

/** The questions that may be played: approved ones (drafts too when BHAO_QUIZ_DRAFTS=on, test service only). */
function playable(env = process.env) {
  if (!QUIZ.enabled && String(env.BHAO_QUIZ_FORCE || "").toLowerCase() !== "on") return [];
  const drafts = String(env.BHAO_QUIZ_DRAFTS || "").toLowerCase() === "on";
  return BANK.questions.filter((q) => q.approved === true || drafts);
}

function hash32(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function rng(seed) {
  let x = hash32(seed) || 1;
  return () => { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; return (x >>> 0) / 4294967296; };
}

/**
 * Three questions for one game, from different kinds where possible (the
 * founder wants a mix, to see which kind people enjoy most), options shuffled.
 */
function pickGame(seed, env = process.env) {
  const pool = playable(env);
  if (pool.length < QUIZ.questions) return null;
  const r = rng(seed);
  const byCat = {};
  for (const q of pool) (byCat[q.cat] = byCat[q.cat] || []).push(q);
  const cats = Object.keys(byCat).sort(() => r() - 0.5);
  const chosen = [];
  for (let i = 0; chosen.length < QUIZ.questions && i < 50; i++) {
    const list = byCat[cats[i % cats.length]].filter((q) => !chosen.includes(q));
    if (list.length) chosen.push(list[Math.floor(r() * list.length)]);
  }
  return chosen.map((q) => ({ id: q.id, cat: q.cat, q: q.q, options: [...q.options].sort(() => r() - 0.5), answer: q.answer }));
}

/** May a game be offered now? Not twice in a bargain, not twice per item per week. */
async function mayOffer(db, { phone, itemId, state, now }) {
  if (state.game) return false;
  const played = (await db.query(
    `SELECT 1 FROM bhao_conversations WHERE phone = $1 AND item_id = $2 AND started_at > $3
        AND state->'game'->>'status' IN ('won', 'lost') LIMIT 1`,
    [phone, itemId, new Date(now.getTime() - QUIZ.perItemDays * 864e5)])).rowCount;
  return !played;
}

/** Her typed answer: the option's text, or 1/2/3, or a/b/c. Null if neither. */
function typedAnswer(text, options) {
  const t = String(text || "").trim().toLowerCase().replace(/[.!?]+$/, "");
  const n = { "1": 0, "2": 1, "3": 2, a: 0, b: 1, c: 2 }[t];
  if (n !== undefined) return n;
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const i = options.findIndex((o) => norm(o) === norm(t));
  return i >= 0 ? i : null;
}

/** Was her answer right, and in time? `askedAt` = when the question was sent. */
function judge(game, optionIndex, { askedAt, now }) {
  const q = game.questions[game.idx];
  const late = askedAt && now - new Date(askedAt) > (QUIZ.answerSeconds + 3) * 1000; // 3 s grace for the network
  const right = q.options[optionIndex] === q.answer;
  return { right: right && !late, late, correct: q.answer };
}

// ---- Seth Ji's lines for the game (fixed wording: the game is the rules) ---
const rs = (p) => "Rs " + Math.round(p / 100).toLocaleString("en-US");
const texts = {
  offer: (price) => `Achha baji, aap ${rs(price)} pe ruke hain aur main apni jagah. 😄 Chalein, ek khel khelte hain!\n\n` +
    `🎯 *Bhao ka Khel*: 3 sawal, har ek ke liye ${QUIZ.answerSeconds} second. Teeno sahi - toh ${rs(price)} aap ka! ` +
    `Ek bhi ghalat - koi baat nahi, bhao wahin se chalega. Khelenge?`,
  question: (game) => {
    const q = game.questions[game.idx];
    return `❓ *Sawal ${game.idx + 1}/${QUIZ.questions}* (${QUIZ.answerSeconds} second)\n\n${q.q}`;
  },
  right: (game) => ["Shabash! ✅", "Bilkul sahi! ✅", "Waah, kya baat hai! ✅"][game.idx - 1] || "Sahi! ✅",
  won: (price) => `🏆 Teeno sahi! Seth Ji haar gaye - waada waada hai: ${rs(price)} pe sauda pakka! 🤝`,
  lost: (j, ask) => `${j.late ? "⏰ Waqt khatam!" : "❌ Afsos, ghalat!"} Sahi jawab tha: *${j.correct}*.\n` +
    `Koi baat nahi baji - khel khatam, bhao jaari. Mera daam abhi ${rs(ask)} hai. Aap bataiye?`,
  declined: (ask) => `Theek hai baji, khel nahi toh bhao hi sahi! 😄 Mera daam ${rs(ask)}. Aap bataiye?`,
};

module.exports = { QUIZ, BANK, playable, pickGame, mayOffer, typedAnswer, judge, texts };
