// ============================================================================
// ASB PIPELINE — typedorder.js
//
// Typed orders without a human (founder, 20 Nov 2026). "2kg aloo, aadha kilo
// adrak, dhania 2 gaddi" -> an AI model matches each item to OUR products and
// says how much she asked for; the arithmetic (how many packs) is done here,
// in code, never by the model. The result goes to the same confirmation as a
// list order (autoorder.js): "Aap ka order: ..." [Theek hai] [Badlein].
// Nothing is saved until she taps Theek hai.
//
// What the model returns (JSON only):
//   { "items":   [{ "sku": "...", "qty": 2, "unit": "kg|g|pao|gaddi|darjan|piece|packet", "said": "2kg aloo" }],
//     "unknown": ["things she asked for that are not in the list"],
//     "unclear": ["things with no quantity, e.g. 'thoda dhania'"] }
//
// Every SKU is checked against the real list; anything invented is dropped.
// ============================================================================
"use strict";

const ai = require("./ai");

// Looks like an order: a number or a quantity word. ("salam", "kab aayega" do not.)
const QTY = /(\d|\b(aadh[aie]|adh[aie]|half|pao|paao|paav|kilo|kg|kilogram|gram|gm|g\b|gaddi|gadi|darjan|dozen|dazan|piece|pcs|packet|ek|do|teen|char|paanch)\b)/i;
function looksLikeOrder(text) {
  const t = String(text || "").trim();
  return t.length >= 4 && t.length <= 800 && QTY.test(t);
}

const GRAMS = { kg: 1000, g: 1, pao: 250 };
const COUNT = { gaddi: "bundle", darjan: "dozen", piece: "pcs", packet: "packet" };

/** "2 kg" of a 500 g pack -> 4 packs; "2 gaddi" of a 1-gaddi pack -> 2. Null when the units cannot meet. */
function packsFor(product, qty, unit) {
  const q = Number(qty);
  if (!(q > 0)) return null;
  const size = Number(product.min_qty) > 0 ? Number(product.min_qty) : 1;
  const u = String(unit || "").toLowerCase();
  let wanted = null;   // in the product's own unit
  if (GRAMS[u] && ["kg", "g", "pao"].includes(product.unit)) {
    const grams = q * GRAMS[u];
    wanted = grams / GRAMS[product.unit];
  } else if (COUNT[u] && COUNT[u] === product.unit) {
    wanted = q;
  } else if (u === product.unit) {
    wanted = q;
  }
  if (wanted == null) return null;
  return Math.max(1, Math.round(wanted / size));
}

function catalogueText(products) {
  return products.map((p) => `${p.sku} | ${p.name_en}${p.name_ur ? " / " + p.name_ur : ""} | sold per ${p.min_qty} ${p.unit}`).join("\n");
}

const SYSTEM =
  "You read grocery orders written by customers in Karachi, in Roman Urdu, Urdu or English, " +
  "and match each item to the shop's product list. Reply with JSON only, no other text, in exactly this shape: " +
  '{"items":[{"sku":"","qty":0,"unit":"","said":""}],"unknown":[],"unclear":[]}. ' +
  "Rules: sku must be copied exactly from the list. qty is what the customer asked for and unit is one of " +
  "kg, g, pao, gaddi, darjan, piece, packet (aadha kilo = 0.5 kg, sawa kilo = 1.25 kg, dhai kilo = 2.5 kg, " +
  "ek pao = 1 pao). Common names: aloo/aaloo/aroo = potato, payaz/piyaz = onion, tamatar = tomato, adrak = ginger, " +
  "lehsan = garlic, hari mirch = green chilli, dhania = coriander, podina = mint, palak = spinach, bhindi = okra, " +
  "lauki/loki = bottle gourd, gobi = cauliflower. If an item is not in the list, put the customer's words in unknown. " +
  "If an item has no quantity, put it in unclear. Never invent a sku.";

/**
 * Read a typed order. Returns { lines:[{sku,packs}], unknown:[], unclear:[], said:{sku:text} }
 * or throws {code} when the AI service fails (the caller leaves it for the team).
 */
async function read(text, products, { env = process.env, fetchImpl = fetch } = {}) {
  const user = `PRODUCT LIST (sku | name | how it is sold):\n${catalogueText(products)}\n\nCUSTOMER WROTE:\n${String(text).slice(0, 800)}`;
  const raw = await ai.complete({ system: SYSTEM, user, env, fetchImpl });
  const json = (() => {
    const m = /\{[\s\S]*\}/.exec(raw);
    try { return m ? JSON.parse(m[0]) : null; } catch (_) { return null; }
  })();
  if (!json) throw Object.assign(new Error("unreadable reply"), { code: "bad_reply" });
  const by = new Map(products.map((p) => [p.sku, p]));
  const merged = new Map();
  const unclear = [...(json.unclear || [])].map(String);
  for (const it of json.items || []) {
    const p = by.get(String(it.sku || ""));
    if (!p) { if (it.said) unclear.push(String(it.said)); continue; }        // invented or wrong sku
    const packs = packsFor(p, it.qty, it.unit);
    if (!packs) { unclear.push(String(it.said || p.name_en)); continue; }   // units do not meet (e.g. "2 tamatar")
    merged.set(p.sku, (merged.get(p.sku) || 0) + packs);
  }
  return {
    lines: [...merged].map(([sku, packs]) => ({ sku, packs })),
    unknown: [...(json.unknown || [])].map(String).slice(0, 10),
    unclear: unclear.slice(0, 10),
  };
}

module.exports = { looksLikeOrder, packsFor, catalogueText, read, SYSTEM };
