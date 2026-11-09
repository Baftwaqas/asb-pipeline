// ============================================================================
// ASB PIPELINE — bhao/perks.js
// The "Bhao Card": WHY one customer's price differs from another's, the way
// it does at a real counter - and shown to her, so a lower price somewhere
// else has a visible, honest reason instead of starting a fight.
//
// Founder (7 Nov): "no two customers get the same price at the physical
// store either ... make it visible: is she a regular, once in a blue moon or
// gold; what time of day; will she pay in advance ..."
//
// A perk gives Seth Ji ROOM, not a discount: it lowers the floor by a few
// percent - never the opening, which is always the listed price (founder,
// 9 Nov) - and the haggle still decides the rest. All
// perks together are capped, and nothing ever goes below the item's cost.
//
//   standing  from ASB's own records (customers.badge + orders in 90 days):
//             naye mehmaan / kabhi kabhi / regular / gold
//   bohni     the shop's first deal of the day, before noon (Karachi time)
//   shaam     closing time, after 9 pm: "dukaan band ho rahi hai"
//   advance   she pays in advance (a CONDITION on the deal; the team checks)
//   pickup    she collects it herself, no delivery (a CONDITION too)
//   group     more pieces together - already the engine's group tiers
//
// Never by who she is beyond her history with ASB: no area, no name, no
// guess about her means. Percentages are DRAFT - founder decision pending;
// the version is stamped on every conversation.
// ============================================================================
"use strict";

const PERKS = Object.freeze({
  version: "PERKS-DRAFT-1",
  capPct: 0.10,
  standing: Object.freeze({
    new:        { pct: 0,    label: "Naye mehmaan 🙏" },
    occasional: { pct: 0.02, label: "Kabhi kabhi aane wali customer" },
    regular:    { pct: 0.04, label: "Regular customer 🌟" },
    gold:       { pct: 0.06, label: "Gold customer ⭐" },
  }),
  bohni:   { pct: 0.03, label: "Subah ki bohni 🌅", beforeHour: 12 },
  shaam:   { pct: 0.02, label: "Dukaan band hone ka waqt 🌙", fromHour: 21 },
  advance: { pct: 0.03, label: "Advance payment 💵", conditional: true },
  // ASB does not offer self-pickup yet (founder's live test, 9 Nov: "khud
  // pickup tu aap ki website pr arha hi nahi"). Off until it does.
  pickup:  { pct: 0.02, label: "Khud pickup 🛵", conditional: true, enabled: false },
  // Some days Seth Ji is simply in a good mood - the SAME for everyone that
  // day (decided by the date alone), so it is fun and still fair.
  mood:    { pct: 0.01, label: "Aaj Seth Ji ka mood bohat acha hai 😄", everyNthDay: 4 },
  roundToPaisa: 1000, // Rs 10
});

const ADVANCE = /\badvance\b|\bpehl[ae]\s+(?:hi\s+)?(?:pay|payment|paise|paisay|raqam)|\bjazz\s*cash\b|\beasy\s*paisa\b|\bonline\s+(?:pay|bhej|transfer)|\bbank\s+transfer\b/i;
const PICKUP = /\bkhud\s+(?:hi\s+)?(?:le|utha|aa)\w*|\bpick\s*-?up\b|\baa\s+ke\s+le\w*|\bdukaan\s+se\s+le\w*/i;

/** Karachi wall-clock hour (0-23) for `now`. */
function karachiHour(now) {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Karachi", hour: "2-digit", hourCycle: "h23" }).format(now));
}
function karachiDayStart(now) {
  const d = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  return new Date(d + "T00:00:00+05:00");
}

/** Is today one of Seth Ji's good-mood days? Same answer for every customer. */
function goodMoodDay(now) {
  const d = karachiDayStart(now).toISOString().slice(0, 10);
  let h = 2166136261 >>> 0;
  for (let i = 0; i < d.length; i++) { h ^= d.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return h % PERKS.mood.everyNthDay === 0;
}

/** Her standing with ASB, from ASB's own records. Unknown phone = new. */
async function standingOf(db, phone, now) {
  const c = (await db.query(
    `SELECT c.badge::text AS badge,
            -- only DELIVERED orders count: a new SIM cannot fake a doorstep
            (SELECT count(*) FROM orders o WHERE o.customer_id = c.id AND o.status = 'delivered'
                AND o.placed_at > $2)::int AS recent
       FROM customers c WHERE c.phone = $1`, [phone, new Date(now - 90 * 864e5)])).rows[0];
  if (!c) return { key: "new", recentOrders: 0 };
  const n = c.recent;
  const key = c.badge === "gold" || n >= 10 ? "gold"
    : c.badge === "regular" || n >= 4 ? "regular"
    : n >= 1 ? "occasional" : "new";
  return { key, recentOrders: n };
}

/** The perks she has when she walks in (standing + time of day). */
async function perksAtOpen(db, { phone, now }) {
  const out = [];
  const s = await standingOf(db, phone, now);
  out.push({ key: "standing:" + s.key, ...PERKS.standing[s.key], recentOrders: s.recentOrders });
  const h = karachiHour(now);
  if (h < PERKS.bohni.beforeHour) {
    const sold = (await db.query(
      `SELECT 1 FROM bhao_conversations WHERE accepted_offer IS NOT NULL AND ended_at >= $1 LIMIT 1`,
      [karachiDayStart(now)])).rowCount;
    if (!sold) out.push({ key: "bohni", pct: PERKS.bohni.pct, label: PERKS.bohni.label });
  }
  if (h >= PERKS.shaam.fromHour) out.push({ key: "shaam", pct: PERKS.shaam.pct, label: PERKS.shaam.label });
  if (goodMoodDay(now)) out.push({ key: "mood", pct: PERKS.mood.pct, label: PERKS.mood.label });
  return out;
}

// She COMMITS ("advance de dungi", "haan, advance kar deti hoon") - as
// opposed to ASKING ("agar advance karun toh kya milega?") or complaining
// ("advance kyun mang rahe ho?"). Live test, 9 Nov: a question was taken as
// a promise, the price moved silently, and Seth Ji then said "discount nahi
// milta". Only a commitment earns the perk; a question gets a straight answer.
const COMMIT = /\b(?:de\s*doo?n?\s*g[iea]|de\s*dun?g[iea]|kar\s*doo?n?\s*g[iea]|kar\s*dun?g[iea]|kar\s*det[ia]|kar\s*rah[ia]|bhej\s*doo?n?\s*g[iea]|bhej\s*dun?g[iea]|bhej\s*det[ia]|haan|ji\s+haan|theek\s+hai|thik\s+hai|ok\b|okay|chalo|chalein|done|pakka|manzoor)/i;
const QUESTION = /\?|\bagar\b|\bkya\b|\bkia\b|\bkitn[aei]\b|\bkyun\b|\bkyu\b|\bkuu?\b|\bkoo\b|\bmil[ae]y?\s*g[aei]\b|\bmilta\b|\bfaida\b/i;
const offered = (k) => PERKS[k].enabled !== false;
const mentions = (text) => [["advance", ADVANCE], ["pickup", PICKUP]].filter(([k, re]) => offered(k) && re.test(text)).map(([k]) => k);

/** Perks her message EARNS: she committed to them. */
function perksFromText(text, held = []) {
  const have = new Set(held.map((p) => p.key));
  const committed = COMMIT.test(text) && !/\bagar\b/i.test(text);
  if (!committed) return [];
  return mentions(text).filter((k) => !have.has(k))
    .map((k) => ({ key: k, pct: PERKS[k].pct, label: PERKS[k].label, conditional: true }));
}

/** Perks she only ASKED about (or questioned): answer with what it would really mean. */
function perksAskedAbout(text, held = []) {
  const have = new Set(held.map((p) => p.key));
  if (perksFromText(text, held).length) return [];
  return mentions(text).filter((k) => !have.has(k)).map((k) => ({ key: k, pct: PERKS[k].pct, label: PERKS[k].label }));
}

/** Her current ask if she adds these perks (Rs 10 rounding, never below the new floor). */
function askWith(item, heldPerks, extraPerks, askPaisa, liftPct = 0) {
  const perks = [...heldPerks, ...extraPerks];
  const extra = totalPct(perks) - totalPct(heldPerks);
  const floorNow = applyPerks(item, perks, { liftPct }).floorPaisa;
  const lowered = Math.max(floorNow, Math.ceil((askPaisa * (1 - extra)) / PERKS.roundToPaisa) * PERKS.roundToPaisa);
  return Math.min(askPaisa, lowered);
}

const totalPct = (perks = []) => Math.min(PERKS.capPct, perks.reduce((a, p) => a + (p.pct || 0), 0));

/**
 * The item as Seth Ji sees it FOR HER: opening price and floors lowered by
 * her perks (capped), rounded to Rs 10, never below cost, group tiers kept
 * strictly lower than the single-piece floor.
 */
function applyPerks(item, perks = [], { liftPct = 0 } = {}) {
  if (liftPct > 0) item = liftFloors(item, liftPct);
  const pct = totalPct(perks);
  if (!pct) return item;
  const step = PERKS.roundToPaisa;
  const cost = item.costPaisa ?? 0;
  const cut = (x) => Math.max(cost, Math.ceil((x * (1 - pct)) / step) * step);
  const floorPaisa = Math.min(item.floorPaisa, cut(item.floorPaisa));
  // Founder, 9 Nov: the opening is ALWAYS the listed price - if Seth Ji
  // opened lower for some customers, the listed price would read as fake.
  // Perks give room below it (a lower floor); she names the first number.
  const anchorPaisa = item.anchorPaisa;
  const groupTiers = [];
  let last = floorPaisa;
  for (const t of item.groupTiers || []) {
    const f = cut(t.floorPaisa);
    if (f < last) { groupTiers.push({ minQty: t.minQty, floorPaisa: f }); last = f; }
  }
  return { ...item, anchorPaisa, floorPaisa, groupTiers };
}

// ---------------------------------------------------------------------------
// Protecting the floor from probing (founder, 9 Nov: "a customer bargains
// from 5 phones at once and learns our lowest price").
//   * the floor a conversation can reach is LIFTED above the approved floor:
//     - weekly drift: 0..weeklyDriftMaxPct, per item per week (by date alone)
//       - what was learned last month is wrong this month;
//     - a per-conversation cushion: 0..cushionMaxPct, from the conversation's
//       seed - "is se neeche nahi" is true for HER, today, but is not the
//       true floor, so a probe cannot read it to the rupee;
//     - new numbers (no delivered order with ASB): +newNumberLiftPct - five
//       fresh SIMs all meet the HIGHEST floor; the lowest is reachable only
//       with real history, real advance, or real neighbours;
//     - probe guard: several new numbers on one item within a few hours lift
//       new numbers' floors further for a day, and the team is alerted.
//   * never below the approved floor (lifts only raise it), never above the
//     opening price. Perks then cut as usual (capped, never below cost).
// DRAFT numbers - founder decision pending.
// ---------------------------------------------------------------------------
const PROTECT = Object.freeze({
  version: "PROTECT-DRAFT-1",
  weeklyDriftMaxPct: 0.03,
  cushionMaxPct: 0.05,
  newNumberLiftPct: 0.05,
  probe: Object.freeze({ windowHours: 6, newNumbers: 4, liftPct: 0.05, holdHours: 24 }),
});

function hashUnit(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995) >>> 0; h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}
/** Karachi week number since an epoch (Monday-based), the same for everyone. */
function weekKey(now) {
  const d = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Karachi", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const days = Math.round(Date.parse(d + "T00:00:00Z") / 864e5); // Karachi calendar day number
  return Math.floor((days + 3) / 7); // 1970-01-01 was a Thursday: weeks start on Monday
}
const weeklyDrift = (itemId, now) => hashUnit(`${itemId}:week:${weekKey(now)}`) * PROTECT.weeklyDriftMaxPct;
const cushion = (seed) => hashUnit(`${seed}:cushion`) * PROTECT.cushionMaxPct;

/** Raise the floors (single and group) by liftPct: Rs 10 steps, never above the opening price. */
function liftFloors(item, liftPct) {
  const step = PERKS.roundToPaisa;
  const up = (x) => Math.ceil((x * (1 + liftPct)) / step) * step;
  const floorPaisa = Math.min(item.anchorPaisa, up(item.floorPaisa));
  const groupTiers = [];
  let last = floorPaisa;
  for (const t of item.groupTiers || []) {
    const f = Math.min(up(t.floorPaisa), last - step);
    if (f >= t.floorPaisa && f < last) { groupTiers.push({ minQty: t.minQty, floorPaisa: f }); last = f; }
    else if (t.floorPaisa < last) { groupTiers.push({ minQty: t.minQty, floorPaisa: t.floorPaisa }); last = t.floorPaisa; }
  }
  return { ...item, floorPaisa, groupTiers };
}

/**
 * How far above the approved floor THIS conversation's floor sits, and why
 * (kept in the conversation state for audit; never shown to her).
 */
async function floorLiftFor(db, { itemId, phone, seed, now, standingKey }) {
  const parts = { weekly: weeklyDrift(itemId, now), cushion: cushion(seed), newNumber: 0, probe: 0 };
  let probeAlert = null;
  if (standingKey === "new") {
    parts.newNumber = PROTECT.newNumberLiftPct;
    const recentNew = (await db.query(
      `SELECT count(DISTINCT phone)::int AS n FROM bhao_conversations
        WHERE item_id = $1 AND phone <> $2 AND started_at > $3
          AND state->'perks' @> '[{"key": "standing:new"}]'`,
      [itemId, phone, new Date(now - PROTECT.probe.windowHours * 3600e3)])).rows[0].n;
    const held = (await db.query(
      `SELECT 1 FROM bhao_conversations WHERE item_id = $1 AND started_at > $2
          AND (state->'floorLift'->>'probe')::numeric > 0 LIMIT 1`,
      [itemId, new Date(now - PROTECT.probe.holdHours * 3600e3)])).rowCount;
    if (recentNew >= PROTECT.probe.newNumbers || held) {
      parts.probe = PROTECT.probe.liftPct;
      if (recentNew >= PROTECT.probe.newNumbers) probeAlert = { itemId, newNumbers: recentNew + 1, windowHours: PROTECT.probe.windowHours };
    }
  }
  const pct = Object.values(parts).reduce((a, b) => a + b, 0);
  return { pct, parts, version: PROTECT.version, probeAlert };
}

/** The card she sees: what she has, and what would give her more room. */
function cardText(perks = [], { groupSizes = [], title = null } = {}) {
  const have = new Set(perks.map((p) => p.key));
  const lines = ["🧾 *Aap ka Bhao Card*"];
  if (title) lines.push("Darja: " + title);
  for (const p of perks) {
    if (p.key.startsWith("standing:") && p.recentOrders) lines.push(`${p.label} (pichle 3 mahine: ${p.recentOrders} order)`);
    else lines.push(p.label);
  }
  const more = [];
  if (!have.has("advance")) more.push("💵 advance payment (marzi hai, COD bhi chalega)");
  if (offered("pickup") && !have.has("pickup")) more.push("🛵 khud pickup");
  if (groupSizes.length) more.push(`👥 ${groupSizes[0]} milke lein`);
  if (more.length) lines.push("Aur gunjaish chahiye? " + more.join(" · "));
  lines.push("_Har sauda alag hota hai - aap ka card aap ka bhao._");
  return lines.join("\n");
}

module.exports = { PROTECT, floorLiftFor, liftFloors, weeklyDrift, cushion, weekKey, PERKS, ADVANCE, PICKUP, COMMIT, karachiHour, goodMoodDay, standingOf, perksAtOpen, perksFromText, perksAskedAbout, askWith, offered, totalPct, applyPerks, cardText };
