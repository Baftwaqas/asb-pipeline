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
const LIST = require(path.join(__dirname, "data", "karachi-areas.json"));

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
  notServed: (a) =>
    `Shukriya! Abhi hum *${a.name}* mein deliver nahi karte, lekin jaise hi shuru karenge ` +
    "aap ko sab se pehle batayenge. 🙏",
  again:
    "Maazrat, area samajh nahi aaya. Apne area ka naam likh dein (jaise Gulshan-e-Iqbal, DHA, Nazimabad) " +
    "ya *Send location* se apni location bhej dein.",
  staff: "Shukriya! Hamari team aap ka area dekh kar jald jawab degi.",
};
const YES = { id: "area:yes", title: "Ji haan" };
const NO = { id: "area:no", title: "Nahi" };

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
     SELECT a.id, a.district, a.name, a.served, count(p.phone)::int AS people
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
// The bot. Called for every inbound customer message AFTER it is saved (so the
// team still sees everything). Returns what it did, or null. Never throws into
// the webhook; never asks the same person twice.
//   send: { text(phone, body), buttons(phone, body, buttons), location(phone, body) }
//         each returns { ok, wamid } and is also logged in the inbox by the caller.
// ---------------------------------------------------------------------------
async function onInbound(db, { phone, msg, send, env = process.env }) {
  if (!on(env) || !(await ready(db))) return null;
  const areasList = await all(db);
  const known = await areaOf(db, phone);
  if (known?.id) return null;                       // area already known

  const st = (await db.query(`SELECT * FROM customer_locations WHERE phone = $1`, [phone])).rows[0];
  const state = st?.bot_state || "none";
  if (state === "done" || state === "staff") return null;

  const reply = msg?.interactive?.button_reply?.id || msg?.button?.payload || null;
  const typed = msg?.type === "text" ? msg.text?.body || "" : (msg?.interactive?.button_reply?.title || "");

  // First message from someone we know nothing about: ask, once.
  if (state === "none") {
    await db.query(
      `INSERT INTO customer_locations (phone, bot_state, asked_at) VALUES ($1, 'asked', now())
       ON CONFLICT (phone) DO UPDATE SET bot_state = 'asked', asked_at = now()`, [phone]);
    await send.location(phone, TEXT.ask);
    return { did: "asked" };
  }

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

  if (state === "confirming") {
    const yes = reply === YES.id || /^\s*(ji\s*haan|haan|han|ji|yes|jee|g|sahi|theek)\b/i.test(typed);
    const no = reply === NO.id || /^\s*(nahi|nahin|na|no|ghalat|galat)\b/i.test(typed);
    if (yes && st.pending_area) {
      await setArea(db, phone, st.pending_area, { source: "bot", by: "bot" });
      const area = areasList.find((a) => Number(a.id) === Number(st.pending_area));
      await send.text(phone, area.served ? TEXT.served(area) : TEXT.notServed(area));
      return { did: area.served ? "served" : "waitlist", area: area.name };
    }
    if (!no) {
      // They typed another area name instead of yes/no: try that.
      const other = matchText(areasList, typed);
      if (other) return suggest(other, typed);
    }
    return miss(null);
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
  TEXT, LIST, on, ready, loadList, all, norm, matchText, matchPoint, km,
  areaOf, setArea, addArea, counts, phonesIn, onInbound,
};
