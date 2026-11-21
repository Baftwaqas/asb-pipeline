// ============================================================================
// ASB PIPELINE — catalogPlan.js
//
// Keeps the WhatsApp catalogue (Meta) complete: every product we sell should be
// in it, so "List se chunein" and the shop button show chicken, eggs and the
// rest - not only the items someone once added by hand.
//
// plan() compares our products table with the catalogue as Meta has it and
// says, without changing anything:
//   linked   already joined up (prices flow on their own)
//   link     a catalogue item that looks like one of our products but was never
//            joined up -> join it (and send our title + prices)
//   add      for sale with us, not in the catalogue -> create it
//   orphans  in the catalogue, matches nothing we sell -> mark out of stock
//   problems cannot be added yet (no picture, no price)
//
// Nothing is pushed from here: the inbox shows the plan, the owner approves,
// and only the approved rows are sent (inbox.js /api/inbox/rates/apply).
// ============================================================================

"use strict";

const STOP = new Set(["fresh", "the", "and", "of", "per", "large", "small", "kg", "kilo", "g", "gm", "gms",
  "gram", "grams", "dozen", "darjan", "pcs", "piece", "pieces", "adad", "pack", "packet", "gaddi",
  "bunch", "bundle", "pao", "local", "desi"]);

/** "Kela (Banana) — 1 darjan" -> ["kela", "banana"] */
function tokens(s) {
  return String(s || "")
    .split("|")[0]
    .toLowerCase()
    .replace(/[—–\-()/,.+&]/g, " ")
    .replace(/\d+(\.\d+)?/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w));
}

/** What a pack of this product is, in the words the titles use. */
function packLabel(unit, minQty) {
  const n = Number(minQty) || 1;
  const k = (x) => String(Number(x.toFixed(3)));
  switch (unit) {
    case "kg": return `${k(n)} kg`;
    case "g": return n >= 1000 ? `${k(n / 1000)} kg` : `${k(n)} gm`;
    case "pao": return `${k(n)} pao`;
    case "bundle": return `${k(n)} gaddi`;
    case "dozen": return `${k(n)} darjan`;
    case "pcs": return `${k(n)} adad`;
    case "packet": return `${k(n)} packet`;
    default: return `${k(n)} ${unit || ""}`.trim();
  }
}

/** The pack written in a catalogue title, in grams / pieces, if any. */
function packIn(title) {
  const t = String(title || "").toLowerCase();
  let m = t.match(/(\d+(?:\.\d+)?)\s*(kg|kilo)\b/);
  if (m) return { kind: "w", n: Number(m[1]) * 1000 };
  m = t.match(/(\d+(?:\.\d+)?)\s*(g|gm|gms|gram|grams)\b/);
  if (m) return { kind: "w", n: Number(m[1]) };
  if (/\b(dozen|darjan)\b/.test(t)) return { kind: "dz", n: 1 };
  return null;
}

function ourPack(p) {
  const n = Number(p.min_qty) || 1;
  if (p.unit === "kg") return { kind: "w", n: n * 1000 };
  if (p.unit === "g") return { kind: "w", n };
  if (p.unit === "pao") return { kind: "w", n: n * 250 };
  if (p.unit === "dozen") return { kind: "dz", n };
  return null;
}

const titleOf = (p) => `${p.name_en} — ${packLabel(p.unit, p.min_qty)}`;

/** 0..1: how sure we are that catalogue item `m` is product `p`. */
function score(p, m) {
  const a = new Set([...tokens(p.name_en), ...tokens(p.name_roman)]);
  const b = new Set(tokens(m.name));
  if (!a.size || !b.size) return 0;
  let both = 0;
  for (const w of a) if (b.has(w)) both++;
  if (!both) return 0;
  // Shared words over the longer name: "Aloo" vs "Aloo Lal" is only 0.5, so
  // a plain kind never swallows a named one.
  const s = both / Math.max(a.size, b.size);
  const mp = packIn(m.name);
  const op = ourPack(p);
  // A different pack (Adrak 1 kg vs our Adrak 250 gm) is still the same thing,
  // but the catalogue title will be rewritten, so mark it.
  return mp && op && mp.kind === op.kind && mp.n !== op.n ? s * 0.9 : s;
}

/**
 * products: rows of products (id, sku, name_en, name_roman, name_ur, unit,
 *           min_qty, asb_price, market_price, is_active, image_url,
 *           shopify_variant_id, meta_retailer_id)
 * items:    the catalogue as metaItems() returns it
 */
function plan(products, items, { threshold = 0.99 } = {}) {
  const byRid = new Map(items.map((i) => [String(i.retailer_id), i]));
  const takenRid = new Set();
  const linked = [];
  const stale = [];
  const open = [];

  for (const p of products) {
    if (p.meta_retailer_id && byRid.has(String(p.meta_retailer_id))) {
      linked.push({ product: p, item: byRid.get(String(p.meta_retailer_id)) });
      takenRid.add(String(p.meta_retailer_id));
    } else {
      if (p.meta_retailer_id) stale.push(p); // linked to something Meta no longer has
      if (p.is_active) open.push(p);
    }
  }

  const freeItems = items.filter((i) => !takenRid.has(String(i.retailer_id)));

  // Best pairs first, each catalogue item used once.
  const pairs = [];
  for (const p of open) for (const m of freeItems) {
    const s = score(p, m);
    if (s >= threshold * 0.9) pairs.push({ p, m, s });
  }
  pairs.sort((x, y) => y.s - x.s);
  const usedP = new Set();
  const usedM = new Set();
  const link = [];
  for (const { p, m, s } of pairs) {
    if (usedP.has(p.id) || usedM.has(m.retailer_id)) continue;
    usedP.add(p.id); usedM.add(m.retailer_id);
    link.push({
      shopify_variant_id: p.shopify_variant_id, product: p.name_en, our_title: titleOf(p),
      retailer_id: m.retailer_id, catalogue_title: m.name, score: Number(s.toFixed(2)),
      pack_differs: s < threshold,
    });
  }

  const add = [];
  const problems = [];
  for (const p of open) {
    if (usedP.has(p.id)) continue;
    const why = [];
    if (!p.image_url) why.push("no picture");
    if (!(Number(p.asb_price) > 0)) why.push("no price");
    const row = { shopify_variant_id: p.shopify_variant_id, product: p.name_en, title: titleOf(p),
                  asb_price: Number(p.asb_price) || null,
                  market_price: p.market_price == null ? null : Number(p.market_price) };
    if (why.length) problems.push({ ...row, why });
    else add.push(row);
  }

  // Left-over catalogue items: show the nearest product of ours, so a person
  // can still join "Dawn Bread" to "Dawn Bread Large" by hand.
  const orphans = freeItems
    .filter((m) => !usedM.has(m.retailer_id))
    .map((m) => {
      let best = null;
      for (const p of products) {
        const s = score(p, m);
        if (s >= 0.5 && (!best || s > best.s)) best = { p, s };
      }
      return { retailer_id: m.retailer_id, catalogue_title: m.name, availability: m.availability,
               maybe: best ? { shopify_variant_id: best.p.shopify_variant_id, product: best.p.name_en,
                               score: Number(best.s.toFixed(2)) } : null };
    });

  return {
    counts: { for_sale: products.filter((p) => p.is_active).length, catalogue: items.length,
              linked: linked.length, link: link.length, add: add.length,
              problems: problems.length, orphans: orphans.length, stale: stale.length },
    link, add, problems, orphans,
    stale: stale.map((p) => ({ shopify_variant_id: p.shopify_variant_id, product: p.name_en,
                               retailer_id: p.meta_retailer_id })),
  };
}

/** The new catalogue item for one product. Its retailer id is our sku. */
function createData(p, { storeUrl = process.env.STORE_URL || "https://apnasastabazaar.com" } = {}) {
  const asb = Number(p.asb_price);
  const mkt = p.market_price == null ? null : Number(p.market_price);
  const money = (n) => `${Number(n).toFixed(2)} PKR`;
  const data = {
    id: p.sku,
    title: titleOf(p),
    description: [p.name_ur, `${p.name_en} — ${packLabel(p.unit, p.min_qty)}`, "Apna Sasta Bazaar"]
      .filter(Boolean).join(" · "),
    availability: p.is_active ? "in stock" : "out of stock",
    condition: "new",
    brand: "Apna Sasta Bazaar",
    image_link: p.image_url,
    link: p.shopify_handle ? `${storeUrl.replace(/\/$/, "")}/products/${p.shopify_handle}` : storeUrl,
  };
  if (mkt > asb) { data.price = money(mkt); data.sale_price = money(asb); }
  else data.price = money(asb);
  return data;
}

module.exports = { plan, createData, tokens, score, packLabel, titleOf };
