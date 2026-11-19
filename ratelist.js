// ============================================================================
// ASB PIPELINE — ratelist.js
//
// "Rate list?" answered by itself (founder, 19 Nov 2026). Customers asking for
// the rate list used to wait for a person. Now (switch RATELIST_BOT=on) the
// bot sends a short menu, and each choice sends that part of today's prices,
// read from the products table (the same prices Shopify sets, the same the
// bills use):
//
//   🔥 Sab se bari bachat   the biggest savings vs the bazaar
//   🥔 Roz ki sabzi          aloo, payaz, tamatar, adrak, lehsan, mirch...
//   🥬 Sabziyaan A-L / M-Z   every vegetable
//   🍎 Phal                  every fruit
//
// Only within the 24-hour window (the customer just wrote), so free to send.
// This is also the first screen of the order flow that comes next.
// ============================================================================

"use strict";

const on = (env = process.env) => String(env.RATELIST_BOT || "").toLowerCase() === "on";

// "rate list", "rates?", "aaj ka rate", "bhao kya hai", "price list", "qeemat"
const ASK = /\b(rate\s*-?\s*list|ratelist|rates?|reat|qee?mat|qimat|bhao|bhaav|price\s*list|prices?|daam)\b/i;
function isAsk(text) {
  const t = String(text || "").trim();
  return t.length > 0 && t.length <= 60 && ASK.test(t);
}

// The everyday basics, matched by name (Shopify titles vary: "Aroo", "Payaz", "Hari Mirch"...)
const DAILY = /\b(aa?roo|aa?loo|pa?y[ae]a?z|piyaz|tamatar|tomato|adrak|ginger|lehsan|garlic|mirch|dhania|dhaniya|podina|pudina|lemon|leemu|nimbu)\b/i;

const MENU = [
  { id: "ratelist:deals", title: "🔥 Sab se bari bachat", description: "Bazaar se sab se zyada sasta" },
  { id: "ratelist:daily", title: "🥔 Roz ki sabzi", description: "Aloo, payaz, tamatar, adrak, mirch..." },
  { id: "ratelist:veg1", title: "🥬 Sabziyaan A–L", description: "Har sabzi, A se L tak" },
  { id: "ratelist:veg2", title: "🥬 Sabziyaan M–Z", description: "Har sabzi, M se Z tak" },
  { id: "ratelist:fruit", title: "🍎 Phal", description: "Har phal" },
];

const MENU_TEXT =
  "Assalam-o-Alaikum! 🌿 Aaj ka rate list haazir hai.\n\n" +
  "Neeche *Rate list dekhein* dabayein aur jo hissa chahiye chun lein.";

/** "500 g", "1 kg", "1 gaddi", "1 darjan", "1 piece" */
function packOf(p) {
  const q = Number(p.min_qty || p.step_qty || 1);
  switch (p.unit) {
    case "kg": return q < 1 ? `${Math.round(q * 1000)} g` : `${+q.toFixed(2)} kg`;
    case "g": return `${Math.round(q)} g`;
    case "pao": return `${+q.toFixed(2)} pao`;
    case "bundle": return q === 1 ? "1 gaddi" : `${q} gaddi`;
    case "dozen": return q === 1 ? "1 darjan" : `${q} darjan`;
    case "pcs": return q === 1 ? "1 piece" : `${q} pieces`;
    case "packet": return q === 1 ? "1 packet" : `${q} packets`;
    default: return "";
  }
}
const rs = (n) => `Rs ${Math.round(Number(n)).toLocaleString("en-PK")}`;
function line(p) {
  const off = p.market_price > p.asb_price ? Math.round((1 - p.asb_price / p.market_price) * 100) : 0;
  return `• ${p.name_en} (${packOf(p)}) — *${rs(p.asb_price)}*` + (off > 0 ? `  ~${rs(p.market_price)}~  -${off}%` : "");
}

async function products(db) {
  return (await db.query(
    `SELECT name_en, category, unit::text AS unit, min_qty, step_qty, asb_price, market_price
       FROM products
      WHERE is_active AND asb_price > 0
      ORDER BY name_en`)).rows.map((p) => ({ ...p, asb_price: Number(p.asb_price), market_price: p.market_price == null ? null : Number(p.market_price) }));
}

/** The text for one menu choice. Long lists are split to stay under WhatsApp's limit. */
async function part(db, key) {
  const all = await products(db);
  const veg = all.filter((p) => p.category !== "phal");
  const pick = {
    deals: () => all.filter((p) => p.market_price > p.asb_price)
      .sort((a, b) => (b.market_price - b.asb_price) / b.market_price - (a.market_price - a.asb_price) / a.market_price)
      .slice(0, 20),
    daily: () => all.filter((p) => DAILY.test(p.name_en)),
    veg1: () => veg.filter((p) => /^[a-l]/i.test(p.name_en)),
    veg2: () => veg.filter((p) => !/^[a-l]/i.test(p.name_en)),
    fruit: () => all.filter((p) => p.category === "phal"),
  }[key];
  if (!pick) return null;
  const items = pick();
  const head = MENU.find((m) => m.id === `ratelist:${key}`).title;
  if (!items.length) return [`*${head}*\n\nAbhi is hisse mein koi item nahi. Baqi hisse dekhne ke liye *rate list* likh dein.`];
  const out = [];
  let cur = `*${head}* (aaj ke rate)\n`;
  for (const p of items) {
    const l = line(p) + "\n";
    if (cur.length + l.length > 3500) { out.push(cur); cur = ""; }
    cur += l;
  }
  cur += "\nOrder ke liye isi number par apni list bhej dein. Doosra hissa dekhne ke liye *rate list* likh dein.";
  out.push(cur);
  return out;
}

/**
 * Called for every inbound customer message after it is saved (and after the
 * area bot, which goes first). Returns what it did, or null.
 *   send: { text(phone, body), list(phone, body, buttonText, rows) }
 */
async function onInbound(db, { phone, msg, send, env = process.env }) {
  if (!on(env)) return null;
  const chosen = msg?.interactive?.list_reply?.id || "";
  if (chosen.startsWith("ratelist:")) {
    const texts = await part(db, chosen.slice("ratelist:".length));
    if (!texts) return null;
    for (const t of texts) await send.text(phone, t);
    return { did: "part", part: chosen };
  }
  const typed = msg?.type === "text" ? msg.text?.body : msg?.type === "button" ? msg.button?.text : null;
  if (!isAsk(typed)) return null;
  await send.list(phone, MENU_TEXT, "Rate list dekhein", MENU);
  return { did: "menu" };
}

module.exports = { on, isAsk, MENU, MENU_TEXT, packOf, line, part, onInbound };
