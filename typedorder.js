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

const { normaliseQty } = require("./qtywords");

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

/** How much she asked for, in the product's own unit; null when the units cannot meet. */
function wantedIn(product, qty, unit) {
  const q = Number(qty);
  if (!(q > 0)) return null;
  const raw = String(unit || "").toLowerCase().trim();
  const u = ALIAS[raw] || raw;
  const pu = String(product.unit || "").toLowerCase();
  if (GRAMS[u] && ["kg", "g", "pao"].includes(pu)) return (q * GRAMS[u]) / GRAMS[pu];
  if (COUNT[u] && COUNT[u] === pu) return q;
  if (u === pu || (ALIAS[pu] || pu) === u) return q;
  if (u === "darjan" && pu === "pcs") return q * PER.darjan;                       // "1 dozen" sold per piece
  if (u === "piece" && pu === "dozen") return q / PER.darjan;   // "12 kele" = 1 dozen, "6 kele" = half
  return null;
}

/**
 * Packs for what she asked. ANY QUANTITY (founder, 20 Nov 2026): a pao of a
 * half-kilo tomato pack is half a pack, priced pro rata. Weights are kept to
 * the gram; counted things (adad, gaddi, packet) to a whole one, a dozen to a
 * whole piece. Returns { packs, rounded } or null when the units cannot meet.
 */
function packsExact(product, qty, unit) {
  const wanted = wantedIn(product, qty, unit);
  if (wanted == null) return null;
  const size = Number(product.min_qty) > 0 ? Number(product.min_qty) : 1;
  const pu = String(product.unit || "").toLowerCase();
  let base;   // in the product's unit, after keeping it sensible
  if (pu === "kg") base = Math.round(wanted * 1000) / 1000;
  else if (pu === "g") base = Math.round(wanted);
  else if (pu === "pao") base = Math.round(wanted * 1000) / 1000;
  else if (pu === "dozen") base = Math.round(wanted * PER.darjan) / PER.darjan;
  else base = Math.round(wanted);                               // pcs, bundle, packet
  const smallest = pu === "dozen" ? 1 / PER.darjan : (["kg", "pao"].includes(pu) ? 0.05 : (pu === "g" ? 50 : 1));
  if (base < smallest) base = smallest;
  const packs = Math.round((base / size) * 1e6) / 1e6;
  return { packs, rounded: Math.abs(base - wanted) > 1e-6 * Math.max(1, wanted) };
}

/** Old name kept for callers: packs only. */
function packsFor(product, qty, unit) {
  const r = packsExact(product, qty, unit);
  return r ? r.packs : null;
}

const UNIT_WORD = { kg: "kilo", g: "gram", pao: "pao", dozen: "darjan", pcs: "adad (piece)", bundle: "gaddi", packet: "packet" };
const unitWord = (u) => UNIT_WORD[String(u || "").toLowerCase()] || String(u || "");

function catalogueText(products) {
  return products.map((p) => {
    const names = [p.name_en, p.name_roman, p.name_ur].filter((x, i, a) => x && a.indexOf(x) === i).join(" / ");
    return `${p.sku} | ${names} | sold per ${p.min_qty} ${p.unit}`;
  }).join("\n");
}

const SYSTEM =
  "You read grocery orders written by customers in Karachi, in Roman Urdu, Urdu or English, " +
  "and match each item to the shop's product list. Reply with JSON only, no other text, in exactly this shape: " +
  '{"items":[{"sku":"","qty":0,"unit":"","said":""}],"choose":[{"said":"","qty":0,"unit":"","options":[""]}],"unknown":[],"unclear":[]}. ' +
  "Rules: sku must be copied exactly from the list. qty is what the customer asked for and unit is one of " +
  "kg, g, pao, gaddi, darjan, piece, packet (aadha kilo = 0.5 kg, sawa kilo = 1.25 kg, dhai kilo = 2.5 kg, " +
  "ek pao = 1 pao). Common names: aloo/aaloo/aroo = potato, payaz/piyaz = onion, tamatar = tomato, adrak = ginger, " +
  "lehsan = garlic, hari mirch = green chilli, dhania = coriander, podina = mint, palak = spinach, bhindi = okra, " +
  "lauki/loki = bottle gourd, gobi = cauliflower, kela/kele/kelay/kalay/kelly = banana (sold by the dozen; 12 pieces = 1 dozen; never kala tarbooz), " +
  "kala tarbooz = black watermelon (only when the customer says tarbooz), seb = apple, " +
  "kinnu/kino = kinnow, malta = orange, amrood = guava, anaar = pomegranate, angoor = grapes, papita = papaya, " +
  "khajoor = dates, aam = mango, nashpati = pear. Customers write in English, Roman Urdu or Urdu script; match " +
  "by meaning. dozen = darjan. TYPES: if her words fit MORE THAN ONE product in the list (different " +
  "types of the same thing, e.g. lehsan -> China / Desi / Peeled garlic; aloo -> Aloo White / Aloo Lal; gajar -> Lal / Peli; " +
  "angoor -> the grape kinds; chicken/murghi -> Mix Boti / Boneless; palak, bengan, mirch, apple, tarbooz kinds) and she did " +
  "NOT say which, do not pick one: put it in choose with her qty and unit and EVERY matching sku in options. If she named " +
  "the type (lal aloo, safaid/pheeka aloo = Aloo White, desi lehsan, chhila lehsan = Peeled, boneless/breast/fillet = Chicken " +
  "Boneless, boti/mix = Chicken Mix Boti) put it in items. qeema/keema is not on the list unless listed. 'anday/andae/egg' = Eggs (sold by the dozen; " +
  "6 eggs = half a dozen). 'mg' written for vegetables or fruit means grams (250 mg = 250 g). 'moti mirch' is Moti Mirch, " +
  "not Shimla Mirch; 'shimla' is Shimla Mirch. A ditto mark (\") after a number repeats the unit of the line above.  If the customer's unit differs from how it is sold, still copy their qty and unit. " +
  "If the same item is sold in more than one way (e.g. per kg and per dozen), choose the one that matches the " +
  "customer's unit. If an item is not in the list, put just its name (no quantity, e.g. chicken) in unknown. " +
  "If an item has no quantity, put it in unclear. Never invent a sku.";

const EDIT_RULES =
  " EDIT MODE: you get the CURRENT ORDER and a change. Return the WHOLE new order in items: every current item " +
  "that stays (same qty and unit as listed), with the customer's changes applied. 'hata dein/nikal dein/nahi chahiye/" +
  "remove' = drop it; 'X kar dein/X kar do' = set the new quantity; 'aur/bhi/add/plus' = add it, or add to the " +
  "quantity if already there; 'kam kar dein' = reduce. If they remove everything, items is empty. Only put things " +
  "in unclear or unknown if they come from the change.";

/**
 * Read a typed order. Returns { lines:[{sku,packs}], unknown:[], unclear:[], said:{sku:text} }
 * or throws {code} when the AI service fails (the caller leaves it for the team).
 */
async function read(text, products, { env = process.env, fetchImpl = fetch, current = null } = {}) {
  let user = `PRODUCT LIST (sku | name | how it is sold):\n${catalogueText(products)}\n\n`;
  if (current && current.length) {
    const by = new Map(products.map((p) => [p.sku, p]));
    const now = current.filter((l) => by.has(l.sku)).map((l) => {
      const p = by.get(l.sku);
      const size = Number(p.min_qty) > 0 ? Number(p.min_qty) : 1;
      return `${p.sku} | ${p.name_en} | ${+(l.packs * size).toFixed(3)} ${p.unit}`;
    });
    user += `CURRENT ORDER (sku | name | qty unit):\n${now.join("\n")}\n\nCUSTOMER WANTS TO CHANGE IT:\n${normaliseQty(text).slice(0, 800)}`;
  } else {
    user += `CUSTOMER WROTE:\n${normaliseQty(text).slice(0, 800)}`;
  }
  const raw = await ai.complete({ system: current && current.length ? SYSTEM + EDIT_RULES : SYSTEM, user, env, fetchImpl });
  const json = (() => {
    const m = /\{[\s\S]*\}/.exec(raw);
    try { return m ? JSON.parse(m[0]) : null; } catch (_) { return null; }
  })();
  if (!json) throw Object.assign(new Error("unreadable reply"), { code: "bad_reply" });
  const by = new Map(products.map((p) => [p.sku, p]));
  const merged = new Map();
  // the model sometimes returns objects ({said, reason}) instead of strings: show her words, never "[object Object]"
  const asText = (x) => (x && typeof x === "object") ? String(x.said || x.text || x.item || x.name || "").trim() : String(x || "").trim();
  const unclear = [...(json.unclear || [])].map(asText).filter(Boolean);
  const why = (json.unclear || []).length ? ["ai said unclear"] : [];
  const adjusted = [];   // she asked for less (or an odd amount) than a pack: we rounded, and we say so
  const askUnit = [];    // "12 kele" but kele are sold by the kilo: ask "kitne kilo?"
  for (const it of json.items || []) {
    const p = by.get(String(it.sku || ""));
    if (!p) { if (it.said) unclear.push(String(it.said)); why.push(`no sku "${it.sku}"`); continue; }   // invented or wrong sku
    const wanted = wantedIn(p, it.qty, it.unit);
    if (wanted == null) {
      askUnit.push({ name: p.name_en, unit: unitWord(p.unit), said: String(it.said || "") });
      why.push(`${p.sku}: ${it.qty} ${it.unit} vs sold per ${p.unit}`);
      continue;
    }
    const size = Number(p.min_qty) > 0 ? Number(p.min_qty) : 1;
    const { packs, rounded } = packsExact(p, it.qty, it.unit);
    if (rounded) adjusted.push({ sku: p.sku, name: p.name_en, packs, size, unit: p.unit });
    merged.set(p.sku, (merged.get(p.sku) || 0) + packs);
  }
  // "Which kind?" items: only real, sellable options whose units fit what she asked.
  const choose = [];
  for (const c of json.choose || []) {
    const opts = [];
    for (const sku of [...new Set((c?.options || []).map(String))]) {
      const p = by.get(sku);
      if (!p) continue;
      const pk = packsExact(p, c.qty, c.unit);
      if (pk) opts.push({ sku, name: p.name_en, packs: pk.packs });
    }
    const said = String(c?.said || "").trim();
    if (opts.length === 1) merged.set(opts[0].sku, (merged.get(opts[0].sku) || 0) + opts[0].packs);
    else if (opts.length > 1) choose.push({ said: said || opts[0].name, options: opts.slice(0, 10) });
    else if (said) unclear.push(said);
  }
  return {
    choose: choose.slice(0, 5),
    lines: [...merged].map(([sku, packs]) => ({ sku, packs })),
    unknown: [...(json.unknown || [])].map(asText).filter(Boolean).slice(0, 10),
    unclear: unclear.slice(0, 10),
    adjusted: adjusted.slice(0, 10),
    askUnit: askUnit.slice(0, 10),
    why,
  };
}

module.exports = { looksLikeOrder, packsFor, packsExact, wantedIn, unitWord, catalogueText, read, SYSTEM };
