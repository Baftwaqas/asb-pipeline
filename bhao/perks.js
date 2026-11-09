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
// A perk gives Seth Ji ROOM, not a discount: it lowers the opening price and
// the floor by a few percent, and the haggle still decides the rest. All
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
  pickup:  { pct: 0.02, label: "Khud pickup 🛵", conditional: true },
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
            (SELECT count(*) FROM orders o WHERE o.customer_id = c.id AND o.status <> 'cancelled'
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

/** Perks her message earns ("advance de dungi", "khud le jaungi"), not already held. */
function perksFromText(text, held = []) {
  const have = new Set(held.map((p) => p.key));
  const add = [];
  if (ADVANCE.test(text) && !have.has("advance")) add.push({ key: "advance", pct: PERKS.advance.pct, label: PERKS.advance.label, conditional: true });
  if (PICKUP.test(text) && !have.has("pickup")) add.push({ key: "pickup", pct: PERKS.pickup.pct, label: PERKS.pickup.label, conditional: true });
  return add;
}

const totalPct = (perks = []) => Math.min(PERKS.capPct, perks.reduce((a, p) => a + (p.pct || 0), 0));

/**
 * The item as Seth Ji sees it FOR HER: opening price and floors lowered by
 * her perks (capped), rounded to Rs 10, never below cost, group tiers kept
 * strictly lower than the single-piece floor.
 */
function applyPerks(item, perks = []) {
  const pct = totalPct(perks);
  if (!pct) return item;
  const step = PERKS.roundToPaisa;
  const cost = item.costPaisa ?? 0;
  const cut = (x) => Math.max(cost, Math.ceil((x * (1 - pct)) / step) * step);
  const floorPaisa = Math.min(item.floorPaisa, cut(item.floorPaisa));
  const anchorPaisa = Math.max(floorPaisa, cut(item.anchorPaisa));
  const groupTiers = [];
  let last = floorPaisa;
  for (const t of item.groupTiers || []) {
    const f = cut(t.floorPaisa);
    if (f < last) { groupTiers.push({ minQty: t.minQty, floorPaisa: f }); last = f; }
  }
  return { ...item, anchorPaisa, floorPaisa, groupTiers };
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
  if (!have.has("advance")) more.push("💵 advance payment");
  if (!have.has("pickup")) more.push("🛵 khud pickup");
  if (groupSizes.length) more.push(`👥 ${groupSizes[0]} milke lein`);
  if (more.length) lines.push("Aur gunjaish chahiye? " + more.join(" · "));
  lines.push("_Har sauda alag hota hai - aap ka card aap ka bhao._");
  return lines.join("\n");
}

module.exports = { PERKS, ADVANCE, PICKUP, karachiHour, goodMoodDay, standingOf, perksAtOpen, perksFromText, totalPct, applyPerks, cardText };
