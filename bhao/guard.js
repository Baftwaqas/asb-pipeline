// ============================================================================
// ASB PIPELINE — bhao/guard.js
// Keeps Bhao Tao fun for everyone by making it hard to abuse, technically or
// emotionally - in either direction. Founder (9 Nov): "make it interesting
// enough that the masses adopt it, yet effective, so nobody can abuse it".
//
// Against probing and farming the price:
//   * at most DAILY_BARGAINS new bargains per phone per day (Karachi day);
//   * one deal per item per phone per DEAL_COOLDOWN_DAYS (no reselling, no
//     "buy it again lower");
//   * restarting never resets the ask (whatsapp.js, 7-day memory);
//   * MAX_CANCELLATIONS cancelled deals in 30 days pauses her Bhao Tao for
//     PAUSE_DAYS - saying "pakka" and backing out is how a floor gets probed;
//   * a burst of messages (FLOOD_MAX in FLOOD_WINDOW_S) is answered once,
//     together, not message by message.
// Against abuse of Seth Ji:
//   * gaali / insults: the first time he answers with dignity and a warning;
//     the second time the bargain ends politely and pauses PAUSE_DAYS.
// Against abuse OF HER (the voice may never do this - voice.js checks):
//   * no insults, no shaming, no mocking her means; a hardship story is met
//     with kindness and an offer to connect her to the team - and the price,
//     which the engine alone decides, does not move because of it.
// ============================================================================
"use strict";

const LIMITS = Object.freeze({
  DAILY_BARGAINS: 3,
  DEAL_COOLDOWN_DAYS: 7,
  MAX_CANCELLATIONS: 2,
  CANCEL_WINDOW_DAYS: 30,
  PAUSE_DAYS: 7,
  FLOOD_MAX: 6,
  FLOOD_WINDOW_S: 60,
  ABUSE_STRIKES_TO_CLOSE: 2,
});

// Gaali and insults aimed at Seth Ji (Roman Urdu / English). Deliberately
// narrow: haggling banter ("mehenga", "loot", "chor bazaar") is NOT abuse.
const ABUSE = /\b(?:ch[uo]t[iy]+[ae]?|chu?tiya|harami|haramzad[ae]|kam\s*zaat|kutt[aei]y?|kuttay|kamin[ae]|ullu\s+k[ae]\s+path[ae]|gadh[ae]\s+k[ae]\s+bach[ae]|bhen\s*ch\w*|madarch\w*|behenchod|lanat|lanti|bloody|idiot|stupid|bastard|shut\s+up|f+u+c+k\w*|sh[i1]t)\b/i;

// She tells him she is struggling. Never a lever on the price; always met
// with kindness and a human.
const HARDSHIP = /\b(?:bimar|beemar|hospital|ilaj|ilaaj|dawai|ghareeb|gharib|ghurbat|paise\s+nahi|paisay\s+nahi|majboor|majbur|qarz|udhaar|udhar|naukri\s+chali|berozgar|beti\s+ki\s+shadi|yateem|bewa)\b/i;

function karachiDayStart(now) {
  const d = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return new Date(d + "T00:00:00+05:00");
}
const daysAgo = (now, d) => new Date(now.getTime() - d * 864e5);
const nf = (paisa) => "Rs " + Math.round(paisa / 100).toLocaleString("en-US");

/**
 * May she START a bargain on this item now? Returns { ok: true } or
 * { ok: false, reason, text } - text is Seth Ji's polite line.
 */
async function canStart(db, { phone, itemId, itemName, now }) {
  // paused: insults, or deals said "pakka" and then cancelled
  const paused = (await db.query(
    `SELECT 1 FROM bhao_conversations WHERE phone = $1 AND state->>'closedFor' = 'abuse' AND ended_at > $2 LIMIT 1`,
    [phone, daysAgo(now, LIMITS.PAUSE_DAYS)])).rowCount;
  if (paused) return { ok: false, reason: "paused_abuse",
    text: "Baji, pichli dafa baat izzat se nahi hui thi, is liye Seth Ji ne kuch din ka waqfa liya hai. Saman aap website se le sakti hain. 🙏" };
  const cancels = (await db.query(
    `SELECT count(*)::int AS n, max(cancelled_at) AS last FROM bhao_conversations
      WHERE phone = $1 AND status = 'cancelled' AND cancelled_at > $2`,
    [phone, daysAgo(now, LIMITS.CANCEL_WINDOW_DAYS)])).rows[0];
  if (cancels.n >= LIMITS.MAX_CANCELLATIONS && new Date(cancels.last) > daysAgo(now, LIMITS.PAUSE_DAYS))
    return { ok: false, reason: "paused_cancellations",
      text: `Baji, pichle dinon ${cancels.n} dafa sauda pakka hua aur phir cancel. Bhao Tao kuch din aaram karega - agle hafte phir aaiye ga, chai pe baat hogi. 🙏` };

  // one deal per item per week
  const recent = (await db.query(
    `SELECT 1 FROM bhao_conversations WHERE phone = $1 AND item_id = $2 AND status = 'accepted' AND ended_at > $3 LIMIT 1`,
    [phone, itemId, daysAgo(now, LIMITS.DEAL_COOLDOWN_DAYS)])).rowCount;
  if (recent) return { ok: false, reason: "deal_cooldown",
    text: `Baji, ${itemName} ka sauda toh is hafte ho chuka hai! Agle hafte phir bhao lagayen - tab tak koi aur cheez dekhein? Agar aap ke khayal mein koi sauda nahi hua, bata dein - team check kar legi. 🙏` };

  // a few bargains a day, not a hundred
  const today = (await db.query(
    `SELECT count(*)::int AS n FROM bhao_conversations WHERE phone = $1 AND started_at >= $2
        AND COALESCE(state->>'closedFor', '') = ''`, [phone, karachiDayStart(now)])).rows[0].n;
  if (today >= LIMITS.DAILY_BARGAINS) return { ok: false, reason: "daily_limit",
    text: `Baji, aaj ${today} bhao ho gaye - Seth Ji ka gala baith gaya! 😄 Kal phir aaiye ga.` };

  return { ok: true };
}

/** Too many messages from her in the last minute: answer them together, once. */
async function flooding(db, { conversationId, now }) {
  const n = (await db.query(
    `SELECT count(*)::int AS n FROM bhao_messages WHERE conversation_id = $1 AND direction = 'in' AND created_at > $2`,
    [conversationId, new Date(now.getTime() - LIMITS.FLOOD_WINDOW_S * 1000)])).rows[0].n;
  return n > LIMITS.FLOOD_MAX;
}

const isAbuse = (text) => ABUSE.test(String(text || ""));
const isHardship = (text) => HARDSHIP.test(String(text || ""));

// ---------------------------------------------------------------------------
// Delight: titles (cosmetic only - never a price lever) and the victory card
// ---------------------------------------------------------------------------
const TITLES = Object.freeze([
  { min: 10, label: "Seth-Maar 👑" },
  { min: 6, label: "Bhao Ustad 🥇" },
  { min: 3, label: "Bhao Khiladi 🥈" },
  { min: 1, label: "Bhao Shagird 🥉" },
  { min: 0, label: "Naya khiladi 🎯" },
]);
async function titleOf(db, phone) {
  const n = (await db.query(
    `SELECT count(*)::int AS n FROM bhao_conversations WHERE phone = $1 AND status = 'accepted'`, [phone])).rows[0].n;
  return { deals: n, label: TITLES.find((t) => n >= t.min).label };
}

/** The shareable "I beat Seth Ji" card, after a deal. Null if she saved nothing. */
function victoryText({ openPaisa, unitPaisa, qty = 1, itemCode, title, shareNumber }) {
  if (!(openPaisa > unitPaisa)) return null;
  const saved = (openPaisa - unitPaisa) * qty;
  const pct = Math.round(((openPaisa - unitPaisa) / openPaisa) * 100);
  const share = `Main ne Seth Ji ko hara diya! 😎 Aap bhi try karein: "BHAO ${itemCode}"`;
  const link = shareNumber ? `\nhttps://wa.me/${shareNumber}?text=${encodeURIComponent("BHAO " + itemCode)}` : "";
  return [
    "🏆 *Aap ne Seth Ji ko hara diya!*",
    `Shuru: ${nf(openPaisa)} → Aap ka sauda: ${nf(unitPaisa)}${qty > 1 ? ` × ${qty}` : ""}`,
    `Bachat: ${nf(saved)} (${pct}%)`,
    title ? `Aap ka darja: ${title}` : null,
    `Doston aur ghar walon ko bhejein 👇\n${share}${link}`,
  ].filter(Boolean).join("\n");
}

module.exports = { LIMITS, ABUSE, HARDSHIP, canStart, flooding, isAbuse, isHardship, TITLES, titleOf, victoryText };
