// ============================================================================
// ASB PIPELINE — areas.js
//
// Where customers live, all over Karachi (founder, 19 Nov 2026).
//
// People outside the areas ASB serves message us too. Every phone gets an
// area, so that the day ASB opens a new area there is a ready list to message,
// and the counts show where demand is growing. The area is set two ways:
//
//   1. THE BOT (switch AREA_BOT=on). The first time someone with no known area
//      writes, it asks them to verify their delivery location: a pin (WhatsApp's
//      own "Send location" button) or the area's name in their own words. It
//      then asks "Kya aap ka area X hai?" with Ji haan / Nahi buttons. Nothing
//      is saved until they say yes. Served area -> welcome; anywhere else ->
//      "abhi nahi, lekin sab se pehle aap ko batayenge". Two misses -> it stops
//      and leaves it to a person. It never asks the same person twice.
//   2. STAFF, from the chat screen (inbox.js): pick or correct the area.
//
// Customers already tied to an ASB society count as Gulistan-e-Johar (or their
// society's area) without being asked.
//
// The list of areas is data/karachi-areas.json: 7 districts, their main areas,
// the spellings people use, and an approximate centre point. A pin only ever
// SUGGESTS the nearest area; the customer confirms it.
// ============================================================================

"use strict";

const path = require("path");
const crypto = require("crypto");
const LIST = require(path.join(__dirname, "data", "karachi-areas.json"));
const REWARDS = require(path.join(__dirname, "data", "referral-rewards.json"));

// Areas outside ours open once this many people want them (founder, 19 Nov).
// The team is alerted at the target; the founder decides to open the area.
const UNLOCK_AT = 50;
const MILESTONES = [25, 40, 50];

// ---------------------------------------------------------------------------
// The words customers read. Pakistani Roman Urdu. Founder-approved idea
// (19 Nov): verify the delivery location first; outside our areas, tell them
// we will come and they will hear first.
// ---------------------------------------------------------------------------
const TEXT = {
  ask:
    "Assalam-o-Alaikum! Apna Sasta Bazaar mein khush aamdeed 🌿\n\n" +
    "Meharbani kar ke apni delivery location verify kar dein: neeche *Send location* dabayein, " +
    "ya apne area ka naam likh dein (jaise Gulistan-e-Johar, Gulshan-e-Iqbal, North Nazimabad).",
  confirm: (a) => `Shukriya! Kya aap ka area *${a.name}* (${a.district}) hai?`,
  served: (a) =>
    `Bohat khoob! ✅ Hum *${a.name}* mein deliver karte hain. Apna order isi number par bhej dein.`,
  // Gulistan-e-Johar (and any area we serve): society / gated community or not
  gatedAsk: "Ek aur sawal: kya aap kisi *society ya gated community* mein rehte hain?",
  societyAsk: (examples) =>
    "Apni society ka naam likh dein" + (examples.length ? ` (jaise ${examples.join(", ")})` : "") + ".",
  societyConfirm: (soc) => `Kya aap ki society *${soc.name}* hai?`,
  servedSociety: (a, soc) =>
    `Bohat khoob! ✅ Hum *${soc.name}* (${a.name}) mein deliver karte hain. Apna order isi number par bhej dein.`,
  societyUnknown: (a) =>
    `Shukriya! Hamari team aap ki society check kar legi. ✅ Hum *${a.name}* mein deliver karte hain. Apna order isi number par bhej dein.`,
  // Outside our areas: where the area stands, and the link to bring neighbours
  notServed: (a, count, link) =>
    `Shukriya! Abhi hum *${a.name}* mein deliver nahi karte, lekin jaise hi shuru karenge ` +
    "aap ko sab se pehle batayenge. 🙏\n\n" +
    `*${a.name}* mein abhi tak *${count}/${a.unlock_target || UNLOCK_AT}* log jud chuke hain. ` +
    `Sirf *${Math.max(0, (a.unlock_target || UNLOCK_AT) - count)} aur* chahiye, phir hum aap ke area ko unlock kar denge!\n\n` +
    (link
      ? `Apne padosiyon aur building ke group mein ye link bhejein:\n${link}\n\n`
      : "Apne padosiyon ko bhi isi number par message karne ka kahein.\n\n") +
    "Jitne zyada log aap ke link se judenge aur order karenge, utne bare inaam: discount aur free items! 🎁",
  again:
    "Maazrat, area samajh nahi aaya. Apne area ka naam likh dein (jaise Gulshan-e-Iqbal, DHA, Nazimabad) " +
    "ya *Send location* se apni location bhej dein.",
  staff: "Shukriya! Hamari team aap ka area dekh kar jald jawab degi.",
  shareText: (a, code) => `Assalam-o-Alaikum! Mujhe bhi ${a.name} mein Apna Sasta Bazaar chahiye. (code ${code})`,
};
const YES = { id: "area:yes", title: "Ji haan" };
const NO = { id: "area:no", title: "Nahi" };
const GATED_YES = { id: "gated:yes", title: "Ji haan, society" };
const GATED_NO = { id: "gated:no", title: "Nahi" };
const SOC_YES = { id: "soc:yes", title: "Ji haan" };
const SOC_NO = { id: "soc:no", title: "Nahi" };

const on = (env = process.env) => String(env.AREA_BOT || "").toLowerCase() === "on";

// ---------------------------------------------------------------------------
// The list: loaded into karachi_areas once per version. served is only set
// when an area is first added, so a change made in the inbox is never undone.
// ---------------------------------------------------------------------------
async function ready(db) {
  return (await db.query(`SELECT to_regclass('karachi_areas') IS NOT NULL AS ok`)).rows[0].ok;
}

let loadedVersion = null;
async function loadList(db) {
  if (loadedVersion === LIST.version) return;
  if (!(await ready(db))) return;
  for (const [district, name, lat, lng, aliases, served] of LIST.areas) {
    await db.query(
      `INSERT INTO karachi_areas (district, name, aliases, lat, lng, served)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (name) DO UPDATE SET district = EXCLUDED.district, aliases = EXCLUDED.aliases,
                                        lat = EXCLUDED.lat, lng = EXCLUDED.lng`,
      [district, name, aliases || [], lat, lng, Boolean(served)]);
  }
  loadedVersion = LIST.version;
}

async function all(db) {
  await loadList(db);
  return (await db.query(`SELECT * FROM karachi_areas ORDER BY district, name`)).rows;
}

// ---------------------------------------------------------------------------
// Matching what people type. "johar block 13", "Gulshan-e-Iqbal", "Nazimabad
// no 3", "dha phase 6", "NORTH NAZIMABAD". Longest matching name/alias wins, so
// "north nazimabad" beats "nazimabad". One-letter slips allowed in long words.
// ---------------------------------------------------------------------------
function norm(s) {
  return ` ${String(s || "").toLowerCase()
    .replace(/[-_.,/()]+/g, " ")
    .replace(/\b(e|ul|al)\b/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ").trim()} `;
}
function close(a, b) {   // edit distance <= 1, for words of 5+ letters
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}
function phraseIn(text, phrase) {
  if (text.includes(phrase)) return true;
  const words = phrase.trim().split(" "), t = text.trim().split(" ");
  for (let k = 0; k + words.length <= t.length; k++) {
    if (words.every((w, x) => close(t[k + x], w))) return true;
  }
  return false;
}
function matchText(areasList, text) {
  const t = norm(text);
  let best = null, bestLen = 0;
  for (const a of areasList) {
    for (const p of [a.name, ...(a.aliases || [])].map(norm)) {
      if (p.trim().length < 3) continue;
      if (phraseIn(t, p) && p.length > bestLen) { best = a; bestLen = p.length; }
    }
  }
  return best;
}

// A pin -> the nearest area centre, if within 8 km. Only a suggestion.
function km(a, b) {
  const R = 6371, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function matchPoint(areasList, lat, lng) {
  let best = null, d = Infinity;
  for (const a of areasList) {
    if (a.lat == null) continue;
    const x = km({ lat, lng }, a);
    if (x < d) { d = x; best = a; }
  }
  return d <= 8 ? best : null;
}

// ---------------------------------------------------------------------------
// One phone's area: what was set for it, else its ASB society's area.
// ---------------------------------------------------------------------------
async function areaOf(db, phone) {
  await loadList(db);
  const { rows } = await db.query(
    `SELECT a.*, l.source, l.bot_state, l.raw_text
       FROM customer_locations l LEFT JOIN karachi_areas a ON a.id = l.area_id
      WHERE l.phone = $1`, [phone]);
  if (rows[0]?.id) return rows[0];
  const soc = (await db.query(
    `SELECT a.*, 'society' AS source FROM customers c
       JOIN societies s ON s.id = c.society_id
       JOIN karachi_areas a ON lower(a.name) = lower(COALESCE(s.area, 'Gulistan-e-Johar'))
      WHERE c.phone = $1`, [phone])).rows[0];
  return soc || (rows[0] ? { id: null, ...rows[0] } : null);
}

async function setArea(db, phone, areaId, { by = null, source = "staff" } = {}) {
  await db.query(
    `INSERT INTO customer_locations (phone, area_id, source, bot_state, set_at, set_by)
     VALUES ($1, $2, $3, 'done', now(), $4)
     ON CONFLICT (phone) DO UPDATE SET area_id = EXCLUDED.area_id, source = EXCLUDED.source,
            bot_state = 'done', pending_area = NULL, set_at = now(), set_by = EXCLUDED.set_by`,
    [phone, areaId, source, by]);
}

async function addArea(db, { district, name, by }) {
  const r = await db.query(
    `INSERT INTO karachi_areas (district, name, added_by) VALUES ($1, $2, $3)
     ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING *`,
    [String(district).trim(), String(name).trim(), by || "staff"]);
  return r.rows[0];
}

/** Counts for the inbox: people per area and per district (opted-out included in total only). */
async function counts(db) {
  await loadList(db);
  const { rows } = await db.query(
    `WITH placed AS (
       SELECT l.phone, l.area_id FROM customer_locations l WHERE l.area_id IS NOT NULL
       UNION
       SELECT c.phone, a.id FROM customers c
         JOIN societies s ON s.id = c.society_id
         JOIN karachi_areas a ON lower(a.name) = lower(COALESCE(s.area, 'Gulistan-e-Johar'))
        WHERE c.phone ~ '^92[0-9]{10}$'
          AND NOT EXISTS (SELECT 1 FROM customer_locations l2 WHERE l2.phone = c.phone AND l2.area_id IS NOT NULL)
     )
     SELECT a.id, a.district, a.name, a.served, a.unlock_target, a.unlocked_announced_at,
            count(p.phone)::int AS people
       FROM karachi_areas a LEFT JOIN placed p ON p.area_id = a.id
      GROUP BY a.id ORDER BY a.district, a.name`);
  return rows;
}

/** Phones in an area or a whole district (for the send chooser). */
async function phonesIn(db, { areaId = null, district = null }) {
  await loadList(db);
  const { rows } = await db.query(
    `WITH placed AS (
       SELECT l.phone, l.area_id FROM customer_locations l WHERE l.area_id IS NOT NULL
       UNION
       SELECT c.phone, a.id FROM customers c
         JOIN societies s ON s.id = c.society_id
         JOIN karachi_areas a ON lower(a.name) = lower(COALESCE(s.area, 'Gulistan-e-Johar'))
        WHERE c.phone ~ '^92[0-9]{10}$'
          AND NOT EXISTS (SELECT 1 FROM customer_locations l2 WHERE l2.phone = c.phone AND l2.area_id IS NOT NULL)
     )
     SELECT DISTINCT p.phone FROM placed p JOIN karachi_areas a ON a.id = p.area_id
      WHERE ($1::bigint IS NULL OR a.id = $1) AND ($2::text IS NULL OR a.district = $2)`,
    [areaId, district]);
  return rows.map((r) => r.phone);
}

// ---------------------------------------------------------------------------
// Sharing and unlocking
// ---------------------------------------------------------------------------
/** People who confirmed this area (each phone once). */
async function areaCount(db, areaId) {
  return (await db.query(`SELECT count(*)::int AS n FROM customer_locations WHERE area_id = $1`, [areaId])).rows[0].n;
}

/** A short code for a person's share link; made once, kept. */
async function refCodeFor(db, phone) {
  const cur = (await db.query(`SELECT ref_code FROM customer_locations WHERE phone = $1`, [phone])).rows[0]?.ref_code;
  if (cur) return cur;
  for (let i = 0; i < 5; i++) {
    const code = crypto.randomBytes(4).toString("base64").replace(/[^A-Za-z0-9]/g, "").slice(0, 5).toUpperCase().padEnd(5, "X");
    const r = await db.query(
      `UPDATE customer_locations SET ref_code = $2 WHERE phone = $1 AND ref_code IS NULL
         AND NOT EXISTS (SELECT 1 FROM customer_locations WHERE ref_code = $2) RETURNING ref_code`, [phone, code]);
    if (r.rows[0]) return code;
  }
  return null;
}

/** wa.me link that opens WhatsApp to ASB with a ready message and the code. Needs ASB_WHATSAPP_NUMBER. */
function shareLink(area, code, env = process.env) {
  const num = String(env.ASB_WHATSAPP_NUMBER || "").replace(/\D/g, "");
  if (!num || !code) return null;
  return `https://wa.me/${num}?text=${encodeURIComponent(TEXT.shareText(area, code))}`;
}

/** "(code AB12C)" in a message -> the phone that shared the link. */
async function referrerFrom(db, text) {
  const m = /\(code\s+([A-Z0-9]{5})\)/i.exec(String(text || ""));
  if (!m) return null;
  return (await db.query(`SELECT phone FROM customer_locations WHERE ref_code = $1`, [m[1].toUpperCase()])).rows[0]?.phone || null;
}

/**
 * Someone's network: how many joined through their link, how many of those
 * have ordered (an order on record, or a WhatsApp catalogue cart), and the
 * best reward tier reached. Rewards are a DRAFT until the founder approves.
 */
async function network(db, phone) {
  const { rows } = await db.query(
    `SELECT l.phone,
            (EXISTS (SELECT 1 FROM orders o JOIN customers c ON c.id = o.customer_id WHERE c.phone = l.phone)
             OR EXISTS (SELECT 1 FROM whatsapp_messages m WHERE m.phone = l.phone AND m.direction = 'inbound' AND m.msg_type = 'order')) AS ordered
       FROM customer_locations l WHERE l.referred_by = $1 AND l.area_id IS NOT NULL`, [phone]);
  const joined = rows.length, ordered = rows.filter((r) => r.ordered).length;
  const reached = REWARDS.tiers.filter((t) => joined >= t.joined && ordered >= t.ordered);
  const next = REWARDS.tiers.find((t) => !(joined >= t.joined && ordered >= t.ordered)) || null;
  return { joined, ordered, reward: reached.at(-1)?.reward || null, next, draft: !REWARDS.approved };
}

/**
 * After someone joins an area we don't serve: has it just crossed 25 / 40 / 50?
 * Each milestone once per area. Returns the milestone crossed (or null); the
 * caller tells the waiting people and, at the target, the team.
 */
async function milestone(db, area) {
  const n = await areaCount(db, area.id);
  const target = area.unlock_target || UNLOCK_AT;
  const marks = MILESTONES.map((m) => Math.round((m / UNLOCK_AT) * target));
  const hit = marks.filter((m) => n >= m).at(-1);
  if (!hit) return null;
  const r = await db.query(
    `UPDATE karachi_areas SET milestones_sent = array_append(milestones_sent, $2)
      WHERE id = $1 AND NOT ($2 = ANY(milestones_sent)) RETURNING id`, [area.id, hit]);
  return r.rows[0] ? { area: area.name, count: n, target, mark: hit, reached: n >= target } : null;
}

/** Phones waiting in an area (confirmed it), STOP excluded - for progress / unlock news. */
async function waitingIn(db, areaId) {
  return (await db.query(
    `SELECT l.phone FROM customer_locations l
       LEFT JOIN marketing_opt_outs o ON o.phone = l.phone
      WHERE l.area_id = $1 AND o.phone IS NULL`, [areaId])).rows.map((r) => r.phone);
}

// ---------------------------------------------------------------------------
// The bot. Called for every inbound customer message AFTER it is saved (so the
// team still sees everything). Returns what it did, or null. Never asks the
// same person twice.
//   send: { text(phone, body), buttons(phone, body, buttons), location(phone, body) }
//   onMilestone(info): optional - an area crossed 25 / 40 / 50 (server tells people / the team)
// ---------------------------------------------------------------------------
async function onInbound(db, { phone, msg, send, env = process.env, onMilestone = null }) {
  if (!on(env) || !(await ready(db))) return null;
  const areasList = await all(db);
  const st0 = (await db.query(`SELECT * FROM customer_locations WHERE phone = $1`, [phone])).rows[0];
  const state = st0?.bot_state || "none";
  if (state === "done" || state === "staff") return null;
  if (state === "none") {
    const known = await areaOf(db, phone);
    if (known?.id) return null;                       // e.g. an ASB society customer
  }
  const st = st0 || {};

  const reply = msg?.interactive?.button_reply?.id || msg?.button?.payload || null;
  const typed = msg?.type === "text" ? msg.text?.body || "" : (msg?.interactive?.button_reply?.title || "");
  const yesWord = /^\s*(ji\s*haan|haan|han|ji|yes|jee|g|sahi|theek)\b/i;
  const noWord = /^\s*(nahi|nahin|na|no|ghalat|galat)\b/i;

  const suggest = async (area, raw, lat = null, lng = null) => {
    await db.query(
      `UPDATE customer_locations SET bot_state = 'confirming', pending_area = $2,
              raw_text = COALESCE($3, raw_text), lat = COALESCE($4, lat), lng = COALESCE($5, lng)
        WHERE phone = $1`, [phone, area.id, raw || null, lat, lng]);
    await send.buttons(phone, TEXT.confirm(area), [YES, NO]);
    return { did: "confirm", area: area.name };
  };
  const miss = async (raw) => {
    const tries = (st.tries || 0) + 1;
    if (tries >= 2) {
      await db.query(`UPDATE customer_locations SET bot_state = 'staff', tries = $2, raw_text = COALESCE($3, raw_text) WHERE phone = $1`,
        [phone, tries, raw || null]);
      await send.text(phone, TEXT.staff);
      return { did: "staff" };
    }
    await db.query(`UPDATE customer_locations SET bot_state = 'asked', pending_area = NULL, tries = $2, raw_text = COALESCE($3, raw_text) WHERE phone = $1`,
      [phone, tries, raw || null]);
    await send.location(phone, TEXT.again);
    return { did: "again" };
  };
  const welcomeServed = async (area, soc = null, unknownSociety = false) => {
    await db.query(`UPDATE customer_locations SET bot_state = 'done', pending_society = NULL WHERE phone = $1`, [phone]);
    await send.text(phone, soc ? TEXT.servedSociety(area, soc) : unknownSociety ? TEXT.societyUnknown(area) : TEXT.served(area));
    return { did: "served", area: area.name, society: soc?.name || null };
  };

  // First message from someone we know nothing about.
  if (state === "none") {
    const ref = await referrerFrom(db, typed);
    await db.query(
      `INSERT INTO customer_locations (phone, bot_state, asked_at, referred_by) VALUES ($1, 'asked', now(), $2)
       ON CONFLICT (phone) DO UPDATE SET bot_state = 'asked', asked_at = now(),
              referred_by = COALESCE(customer_locations.referred_by, EXCLUDED.referred_by)`, [phone, ref]);
    // Came through a neighbour's link ("...mein Apna Sasta Bazaar chahiye (code X)"): the area is in the message.
    const fromLink = ref ? matchText(areasList, typed.replace(/apna sasta bazaar/ig, "")) : null;
    if (fromLink) { st.tries = 0; return suggest(fromLink, typed); }
    await send.location(phone, TEXT.ask);
    return { did: "asked", referred: Boolean(ref) };
  }

  if (state === "confirming") {
    const yes = reply === YES.id || yesWord.test(typed);
    const no = reply === NO.id || noWord.test(typed);
    if (yes && st.pending_area) {
      await setArea(db, phone, st.pending_area, { source: "bot", by: "bot" });
      const area = areasList.find((a) => Number(a.id) === Number(st.pending_area));
      if (area.served) {
        // Gulistan-e-Johar (or any area we serve): society / gated community?
        await db.query(`UPDATE customer_locations SET bot_state = 'gated' WHERE phone = $1`, [phone]);
        await send.buttons(phone, TEXT.gatedAsk, [GATED_YES, GATED_NO]);
        return { did: "gated?", area: area.name };
      }
      const code = await refCodeFor(db, phone);
      const count = await areaCount(db, area.id);
      await send.text(phone, TEXT.notServed(area, count, shareLink(area, code, env)));
      const m = await milestone(db, area);
      if (m && onMilestone) await onMilestone({ ...m, areaId: area.id });
      return { did: "waitlist", area: area.name, count, milestone: m };
    }
    if (!no) {
      const other = matchText(areasList, typed);
      if (other) return suggest(other, typed);
    }
    return miss(null);
  }

  // Served area: society or not.
  const myArea = st.area_id ? areasList.find((a) => Number(a.id) === Number(st.area_id)) : null;
  if (state === "gated" && myArea) {
    if (reply === GATED_NO.id || noWord.test(typed)) {
      await db.query(`UPDATE customer_locations SET gated = FALSE WHERE phone = $1`, [phone]);
      return welcomeServed(myArea);
    }
    if (reply === GATED_YES.id || yesWord.test(typed)) {
      await db.query(`UPDATE customer_locations SET gated = TRUE, bot_state = 'society' WHERE phone = $1`, [phone]);
      const ex = (await db.query(`SELECT name FROM societies WHERE is_active ORDER BY id LIMIT 3`)).rows.map((r) => r.name);
      await send.text(phone, TEXT.societyAsk(ex));
      return { did: "society?" };
    }
    // they typed a society name straight away
    if (typed.trim().length >= 3) {
      await db.query(`UPDATE customer_locations SET gated = TRUE, bot_state = 'society' WHERE phone = $1`, [phone]);
      st.bot_state = "society";
    } else return null;
  }
  if ((st.bot_state === "society" || state === "society") && myArea) {
    const socs = (await db.query(`SELECT id, name, code FROM societies WHERE is_active`)).rows
      .map((x) => ({ ...x, aliases: [x.code] }));
    const soc = matchText(socs, typed);
    if (soc) {
      await db.query(`UPDATE customer_locations SET bot_state = 'society_confirm', pending_society = $2, society_text = $3 WHERE phone = $1`,
        [phone, soc.id, typed.slice(0, 200)]);
      await send.buttons(phone, TEXT.societyConfirm(soc), [SOC_YES, SOC_NO]);
      return { did: "society_confirm", society: soc.name };
    }
    await db.query(`UPDATE customer_locations SET society_text = $2 WHERE phone = $1`, [phone, typed.slice(0, 200)]);
    return welcomeServed(myArea, null, true);
  }
  if (state === "society_confirm" && myArea) {
    if ((reply === SOC_YES.id || yesWord.test(typed)) && st.pending_society) {
      await db.query(`UPDATE customer_locations SET society_id = pending_society WHERE phone = $1`, [phone]);
      const soc = (await db.query(`SELECT id, name FROM societies WHERE id = $1`, [st.pending_society])).rows[0];
      return welcomeServed(myArea, soc);
    }
    return welcomeServed(myArea, null, true);   // not that one: the team checks what she typed
  }

  // state 'asked': a pin, or words.
  if (msg?.type === "location" && msg.location) {
    const { latitude: lat, longitude: lng, name, address } = msg.location;
    const byWords = matchText(areasList, `${name || ""} ${address || ""}`);
    const area = byWords || matchPoint(areasList, Number(lat), Number(lng));
    if (area) return suggest(area, [name, address].filter(Boolean).join(", ") || "(location)", lat, lng);
    return miss("(location outside the list)");
  }
  if (typed) {
    const area = matchText(areasList, typed);
    if (area) return suggest(area, typed);
    return miss(typed);
  }
  return null;   // a photo, voice note, catalogue order...: leave it to the team
}

module.exports = {
  TEXT, LIST, REWARDS, UNLOCK_AT, on, ready, loadList, all, norm, matchText, matchPoint, km,
  areaOf, setArea, addArea, counts, phonesIn, onInbound,
  areaCount, refCodeFor, shareLink, referrerFrom, network, milestone, waitingIn,
};
