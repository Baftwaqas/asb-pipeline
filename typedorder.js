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
// Words the AI (or the customer) may use for the same unit.
const ALIAS = {
  kilo: "kg", kgs: "kg", kilogram: "kg", gram: "g", gm: "g", grams: "g", paao: "pao", paav: "pao",
  dozen: "darjan", dozens: "darjan", dazan: "darjan", darjen: "darjan",
  pcs: "piece", pc: "piece", pieces: "piece", adad: "piece", nos: "piece",
  bundle: "gaddi", bundles: "gaddi", gadi: "gaddi", packets: "packet", pack: "packet",
};
const PER = { darjan: 12 };   // pieces in one unit

/** "2 kg" of a 500 g pack -> 4 packs; "2 gaddi" of a 1-gaddi pack -> 2. Null when the units cannot meet. */
function packsFor(product, qty, unit) {
  const q = Number(qty);
  if (!(q > 0)) return null;
  const size = Number(product.min_qty) > 0 ? Number(product.min_qty) : 1;
  const raw = String(unit || "").toLowerCase().trim();
  const u = ALIAS[raw] || raw;
  const pu = String(product.unit || "").toLowerCase();
  let wanted = null;   // in the product's own unit
  if (GRAMS[u] && ["kg", "g", "pao"].includes(pu)) {
    wanted = (q * GRAMS[u]) / GRAMS[pu];
  } else if (COUNT[u] && COUNT[u] === pu) {
    wanted = q;
  } else if (u === pu || (ALIAS[pu] || pu) === u) {
    wanted = q;
  } else if (u === "darjan" && pu === "pcs") {
    wanted = q * PER.darjan;                       // "1 dozen" of bananas sold per piece
  } else if (u === "piece" && pu === "dozen" && q % PER.darjan === 0) {
    wanted = q / PER.darjan;                       // "12 kele" of bananas sold per dozen
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
  "lauki/loki = bottle gourd, gobi = cauliflower, kela/kele/kelay/kalay = banana, seb = apple, " +
  "kinnu/kino = kinnow, malta = orange, amrood = guava, anaar = pomegranate, angoor = grapes, papita = papaya, " +
  "khajoor = dates, aam = mango, nashpati = pear. Customers write in English, Roman Urdu or Urdu script; match " +
  "by meaning. dozen = darjan. If the customer's unit differs from how it is sold, still copy their qty and unit. If an item is not in the list, put the customer's words in unknown. " +
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
  const why = (json.unclear || []).length ? ["ai said unclear"] : [];
  for (const it of json.items || []) {
    const p = by.get(String(it.sku || ""));
    if (!p) { if (it.said) unclear.push(String(it.said)); why.push(`no sku "${it.sku}"`); continue; }   // invented or wrong sku
    const packs = packsFor(p, it.qty, it.unit);
    if (!packs) { unclear.push(String(it.said || p.name_en)); why.push(`${p.sku}: ${it.qty} ${it.unit} vs sold per ${p.unit}`); continue; }
    merged.set(p.sku, (merged.get(p.sku) || 0) + packs);
  }
  return {
    lines: [...merged].map(([sku, packs]) => ({ sku, packs })),
    unknown: [...(json.unknown || [])].map(String).slice(0, 10),
    unclear: unclear.slice(0, 10),
    why,
  };
}

module.exports = { looksLikeOrder, packsFor, catalogueText, read, SYSTEM };
