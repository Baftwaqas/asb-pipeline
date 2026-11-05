// ============================================================================
// ASB PIPELINE — dish/kernel.js
// ADR-002 Lane C: Dish-to-Cart exact-quantity quote lines.
//
// PURE: no database, no Shopify, no clock. Callers pass SERVER-RESOLVED
// recipe, catalogue and pricing records (read from the Recipe Master
// metaobjects and the live catalogue). Nothing from the customer's browser is
// trusted except WHICH recipes, HOW MANY servings, WHICH option choices and
// WHICH pantry items to leave out - and each of those is validated here.
//
// Contract (docs/quote-contract-v1.md, accepted 5 Nov 2026):
//   §1.4  Dish quantities come from verified recipes and may be below Apna
//         sizes (40 g ginger) or above Apna caps. Aggregated BEFORE pricing.
//         No forced extras: the customer gets the exact quantity needed.
//   §3    provenance.recipeIds on every line; never client-supplied.
//   §4    one Shopify line per product: quantity 1, priceSet = whole line
//         price, grams in properties. Never quantity 40 at a per-gram price.
//   R2    integer paisa, exact arithmetic (BigInt), the line price is the
//         line ceiling at confirmation.
//
// Pricing (ASB Pack Intelligence, owner-approved 4 Oct 2026, PCK profiles):
//   price = reference live pack price x (quantity / reference quantity)
//           x (1 + downsizing markup)   only when quantity < reference qty
//   same size keeps the live price; larger than the reference gets no
//   markup; the result is rounded to the nearest whole rupee.
//   The reference is the verified live pack NEAREST the needed quantity
//   (a tie goes to the larger pack, which has the lower per-gram price).
//   Never above the price of a whole live pack that already covers the need.
//
// Every failure is FAIL-CLOSED for the whole quote: an unverified recipe, an
// unknown unit, a missing conversion, a scaling profile not approved by
// policy, a missing price - no lines are returned, only the problems.
// ============================================================================
"use strict";

class DishError extends Error {
  constructor(code, detail) { super(code + (detail ? ": " + detail : "")); this.code = code; }
}

// ---------------------------------------------------------------------------
// Exact rationals in BigInt. Quantities and prices never touch floating point.
// ---------------------------------------------------------------------------
function gcd(a, b) { a = a < 0n ? -a : a; b = b < 0n ? -b : b; while (b) [a, b] = [b, a % b]; return a || 1n; }
function frac(n, d = 1n) {
  if (d === 0n) throw new DishError("DIVIDE_BY_ZERO");
  if (d < 0n) { n = -n; d = -d; }
  const g = gcd(n, d);
  return { n: n / g, d: d / g };
}
const mul = (a, b) => frac(a.n * b.n, a.d * b.d);
const div = (a, b) => frac(a.n * b.d, a.d * b.n);
const add = (a, b) => frac(a.n * b.d + b.n * a.d, a.d * b.d);
const cmp = (a, b) => { const x = a.n * b.d, y = b.n * a.d; return x < y ? -1 : x > y ? 1 : 0; };
const ceilInt = (a) => (a.n + a.d - 1n) / a.d; // a >= 0
const roundHalfUpInt = (a) => (2n * a.n + a.d) / (2n * a.d); // a >= 0

/** "500.0" | "0.85" | 12 -> exact rational; refuses anything else. */
function dec(value, name) {
  const s = String(value ?? "").trim();
  const m = /^(\d{1,12})(?:\.(\d{1,9}))?$/.exec(s);
  if (!m) throw new DishError("INVALID_DECIMAL", `${name} = ${JSON.stringify(value)}`);
  const f = m[2] || "";
  return frac(BigInt(m[1] + f), 10n ** BigInt(f.length));
}
const toSafe = (b, name) => {
  if (b > BigInt(Number.MAX_SAFE_INTEGER)) throw new DishError("OVERFLOW", name);
  return Number(b);
};

// Shopify metaobject text often carries stray spaces ("Verified ", " Piecewise").
const norm = (s) => String(s ?? "").trim().toLowerCase();
const isVerified = (s) => norm(s) === "verified";
const str = (s, name) => {
  if (typeof s !== "string" || !s.trim()) throw new DishError("INVALID_STRING", name);
  return s.trim();
};

// ---------------------------------------------------------------------------
// Units. Mass and count map to the contract's base units g | piece. When the
// recipe's dimension differs from how the product is sold (1 medium onion,
// 1 tsp salt, both sold by the gram), a VERIFIED, ACTIVE per-ingredient
// conversion is required (asb_ingredient_measurement_conversion:
// sourceQuantity of sourceUnit = canonicalQuantity of the sold unit). It is
// matched on the recipe's own unit, or on that dimension's base unit.
// Without one the recipe fails closed.
// ---------------------------------------------------------------------------
const DIMENSION_UNIT = { mass: "g", piece: "piece", count: "piece", volume: "ml" };

function toBaseUnit(qty, unit, ingredient, where) {
  if (!unit || unit.active !== true || !isVerified(unit.verificationStatus))
    throw new DishError("UNIT_NOT_VERIFIED", where);
  const factor = dec(unit.factorToBase, where + " unit.factorToBase");
  const dim = DIMENSION_UNIT[norm(unit.dimension)];
  if (!dim) throw new DishError("UNKNOWN_UNIT_DIMENSION", where + " " + unit.dimension);
  const base = mul(qty, factor);
  if (dim === ingredient.unit) return { unit: dim, qty: base };

  for (const c of ingredient.conversions || []) {
    if (c.active !== true || !isVerified(c.verificationStatus)) continue;
    const src = dec(c.sourceQuantity, where + " conversion.sourceQuantity");
    const eq = dec(c.canonicalQuantity, where + " conversion.canonicalQuantity");
    if (cmp(src, frac(0n)) <= 0 || cmp(eq, frac(0n)) <= 0) throw new DishError("INVALID_CONVERSION", where);
    const rate = div(eq, src);
    if (c.sourceUnitId && c.sourceUnitId === unit.id) return { unit: ingredient.unit, qty: mul(qty, rate) };
    if (c.sourceUnitId && c.sourceUnitId === unit.baseUnitId) return { unit: ingredient.unit, qty: mul(base, rate) };
  }
  throw new DishError("NO_VERIFIED_CONVERSION", `${where} ${dim} -> ${ingredient.unit}`);
}

// ---------------------------------------------------------------------------
// Scaling profiles (asb_scaling_profile). Only methods the policy allows, and
// only verified, active profiles. Power curves give irrational factors and are
// refused here until a reviewed, rational rule replaces them.
// ---------------------------------------------------------------------------
function scaled(base, servings, baseServings, profile, policy, where) {
  if (!profile || profile.active !== true || !isVerified(profile.verificationStatus))
    throw new DishError("SCALING_PROFILE_NOT_VERIFIED", where);
  const method = norm(profile.method);
  if (!policy.allowedScalingMethods.includes(method))
    throw new DishError("SCALING_METHOD_NOT_ALLOWED", `${where} ${method}`);
  const s = frac(BigInt(servings), BigInt(baseServings));
  if (method === "linear") return mul(base, s);
  if (method === "fixed") return base;
  if (method === "capped") {
    const cap = dec(profile.maxMultiplier, where + " maxMultiplier");
    return mul(base, cmp(s, cap) > 0 ? cap : s);
  }
  throw new DishError("SCALING_METHOD_UNSUPPORTED", `${where} ${method}`);
}

// ---------------------------------------------------------------------------
// Policy. Versioned, explicit, no defaults that widen anything.
// ---------------------------------------------------------------------------
function validatePolicy(p) {
  if (!p || typeof p !== "object") throw new DishError("NO_POLICY");
  str(p.version, "policy.version");
  if (!Number.isSafeInteger(p.maxServings) || p.maxServings < 1 || p.maxServings > 200)
    throw new DishError("INVALID_POLICY", "maxServings");
  if (!Number.isSafeInteger(p.maxRecipes) || p.maxRecipes < 1 || p.maxRecipes > 50)
    throw new DishError("INVALID_POLICY", "maxRecipes");
  if (!Array.isArray(p.allowedScalingMethods) || !p.allowedScalingMethods.length)
    throw new DishError("INVALID_POLICY", "allowedScalingMethods");
  for (const m of p.allowedScalingMethods)
    if (!["linear", "fixed", "capped"].includes(m)) throw new DishError("INVALID_POLICY", "scaling method " + m);
  return p;
}

// ---------------------------------------------------------------------------
// Price of an exact quantity, per the approved Pack Intelligence profile.
// ---------------------------------------------------------------------------
function referencePack(ing, qty, where) {
  const live = (ing.packs || []).filter((p) => p.live === true && p.verified === true && p.unit === ing.unit);
  if (!live.length) throw new DishError("NO_VERIFIED_LIVE_PRICE", where);
  let best = null;
  for (const p of live) {
    str(p.variantGid, where + " pack.variantGid");
    if (!Number.isSafeInteger(p.qty) || p.qty <= 0) throw new DishError("INVALID_PACK", where);
    if (!Number.isSafeInteger(p.pricePaisa) || p.pricePaisa <= 0) throw new DishError("INVALID_PACK", where);
    const dist = Math.abs(p.qty - qty);
    if (!best || dist < best.dist || (dist === best.dist && p.qty > best.p.qty)) best = { p, dist };
  }
  return best.p;
}

function priceExact(ing, qty, where) {
  const prof = ing.packProfile;
  if (!prof || !isVerified(prof.verificationStatus) || norm(prof.commerceStatus) !== "approved")
    throw new DishError("PACK_PROFILE_NOT_APPROVED", where);
  if (norm(prof.roundingRule) !== "nearest_rupee") throw new DishError("UNSUPPORTED_ROUNDING_RULE", where);
  const ref = referencePack(ing, qty, where);
  const markup = dec(prof.downsizingMarkupPercent, where + " markup");
  if (cmp(markup, frac(100n)) > 0) throw new DishError("INVALID_MARKUP", where);
  let price = mul(frac(BigInt(ref.pricePaisa)), frac(BigInt(qty), BigInt(ref.qty)));
  const downsized = qty < ref.qty;
  if (downsized) price = mul(price, add(frac(1n), div(markup, frac(100n))));
  const rupees = roundHalfUpInt(div(price, frac(100n)));
  let paisa = rupees * 100n;
  if (paisa <= 0n) throw new DishError("PRICE_ROUNDS_TO_ZERO", where);
  // Never more than a whole pack that already covers the need: 120 g must not
  // cost more than the 125 g pack (Rs 50 x 0.96 x 1.20 = Rs 57.60 would).
  let capPack = null;
  for (const pk of (ing.packs || []))
    if (pk.live === true && pk.verified === true && pk.unit === ing.unit && pk.qty >= qty
        && (!capPack || pk.pricePaisa < capPack.pricePaisa)) capPack = pk;
  const capped = capPack !== null && BigInt(capPack.pricePaisa) < paisa;
  if (capped) paisa = BigInt(capPack.pricePaisa);
  return { pricePaisa: toSafe(paisa, where), reference: ref, downsized, capped,
           capVariantGid: capped ? capPack.variantGid : null, markupPercent: prof.downsizingMarkupPercent };
}

function qtyLabel(unit, qty) {
  if (unit === "piece") return qty === 1 ? "1 adad" : `${qty} adad`;
  if (qty >= 1000 && qty % 1000 === 0) return `${qty / 1000} kg`;
  if (qty >= 1000) return `${(qty / 1000).toFixed(3).replace(/0+$/, "")} kg`;
  return `${qty} g`;
}

// ---------------------------------------------------------------------------
// The quote lines for a Dish-to-Cart selection.
//
//   selections: [{ recipeId, servings, optionChoices: { [groupId]: choiceId },
//                  pantryExclusions: [ingredientId] }]
//   recipes:    { [recipeId]: { recipeId, active, verificationStatus, baseServings,
//                  optionGroups: [{ groupId, choiceIds: [...] }],
//                  ingredients: [{ lineId, ingredientId, baseQuantity, unit, scaling,
//                    quantityBasis, minQuantity, maxQuantity, optionChoiceIds,
//                    active, verificationStatus }] } }
//   catalog:    { [ingredientId]: { canonicalProductId, name, unit, pantryExcludable,
//                  edibleYield, conversions: [...], packProfile, packs: [...] } }
//
// Returns { ok, lines, problems, totalPaisa }.
// ---------------------------------------------------------------------------
function buildDishLines({ cycleCode, selections, recipes, catalog, policy }) {
  const problems = [];
  const fail = (code, detail) => problems.push({ code, detail });
  try {
    validatePolicy(policy);
    str(cycleCode, "cycleCode");
  } catch (e) { return { ok: false, lines: [], problems: [{ code: e.code || "ERROR", detail: e.message }], totalPaisa: 0 }; }

  if (!Array.isArray(selections) || selections.length === 0) fail("NO_RECIPES_SELECTED");
  else if (selections.length > policy.maxRecipes) fail("TOO_MANY_RECIPES", String(selections.length));

  const need = new Map(); // ingredientId -> { qty: frac, unit, recipeIds:Set, contributions:[] }
  const seenRecipe = new Set();

  for (const sel of Array.isArray(selections) ? selections : []) {
    const rid = sel && sel.recipeId;
    try {
      str(rid, "recipeId");
      if (seenRecipe.has(rid)) throw new DishError("DUPLICATE_RECIPE", rid + " (raise servings instead)");
      seenRecipe.add(rid);
      if (!Number.isSafeInteger(sel.servings) || sel.servings < 1 || sel.servings > policy.maxServings)
        throw new DishError("INVALID_SERVINGS", `${rid}: ${sel.servings}`);
      const r = recipes && Object.prototype.hasOwnProperty.call(recipes, rid) ? recipes[rid] : null;
      if (!r) throw new DishError("UNKNOWN_RECIPE", rid);
      if (r.active !== true || !isVerified(r.verificationStatus)) throw new DishError("RECIPE_NOT_VERIFIED", rid);
      if (!Number.isSafeInteger(r.baseServings) || r.baseServings < 1) throw new DishError("INVALID_BASE_SERVINGS", rid);

      // Option groups (goat | beef | lamb): exactly one valid choice per group.
      const chosen = new Set();
      const choices = sel.optionChoices || {};
      for (const g of r.optionGroups || []) {
        const c = choices[g.groupId];
        if (c == null) throw new DishError("OPTION_NOT_CHOSEN", `${rid} ${g.groupId}`);
        if (!(g.choiceIds || []).includes(c)) throw new DishError("INVALID_OPTION_CHOICE", `${rid} ${g.groupId}=${c}`);
        chosen.add(c);
      }
      for (const gid of Object.keys(choices))
        if (!(r.optionGroups || []).some((g) => g.groupId === gid)) throw new DishError("UNKNOWN_OPTION_GROUP", `${rid} ${gid}`);

      const pantry = new Set(Array.isArray(sel.pantryExclusions) ? sel.pantryExclusions : []);
      const active = (r.ingredients || []).filter((l) => l.active === true);
      if (!active.length) throw new DishError("RECIPE_HAS_NO_ACTIVE_INGREDIENTS", rid);

      for (const l of active) {
        const where = `${rid}/${l.lineId}`;
        if (!isVerified(l.verificationStatus)) throw new DishError("INGREDIENT_LINE_NOT_VERIFIED", where);
        const opts = l.optionChoiceIds || [];
        if (opts.length && !opts.some((o) => chosen.has(o))) continue; // another choice was picked
        const ing = catalog && Object.prototype.hasOwnProperty.call(catalog, l.ingredientId) ? catalog[l.ingredientId] : null;
        if (!ing) throw new DishError("INGREDIENT_NOT_SELLABLE", `${where} ${l.ingredientId}`);
        if (pantry.has(l.ingredientId)) {
          if (ing.pantryExcludable !== true) throw new DishError("NOT_A_PANTRY_ITEM", `${where} ${l.ingredientId}`);
          continue;
        }

        let q = dec(l.baseQuantity, where + " baseQuantity");
        if (cmp(q, frac(0n)) <= 0) throw new DishError("ZERO_QUANTITY", where);
        q = scaled(q, sel.servings, r.baseServings, l.scaling, policy, where);
        if (l.minQuantity != null) { const mn = dec(l.minQuantity, where + " min"); if (cmp(q, mn) < 0) q = mn; }
        if (l.maxQuantity != null) { const mx = dec(l.maxQuantity, where + " max"); if (cmp(q, mx) > 0) q = mx; }

        if (ing.unit !== "g" && ing.unit !== "piece") throw new DishError("INVALID_SOLD_UNIT", `${where} ${ing.unit}`);
        let b = toBaseUnit(q, l.unit, ing, where);
        const basis = norm(l.quantityBasis);
        if (basis === "edible") {
          const y = dec(ing.edibleYield, where + " edibleYield");
          if (cmp(y, frac(0n)) <= 0 || cmp(y, frac(1n)) > 0) throw new DishError("INVALID_EDIBLE_YIELD", where);
          b = { unit: b.unit, qty: div(b.qty, y) };
        } else if (basis !== "as purchased") {
          throw new DishError("UNKNOWN_QUANTITY_BASIS", `${where} ${l.quantityBasis}`);
        }

        const cur = need.get(l.ingredientId) || { qty: frac(0n), unit: b.unit, recipeIds: new Set(), contributions: [] };
        cur.qty = add(cur.qty, b.qty);
        cur.recipeIds.add(rid);
        cur.contributions.push({ recipeId: rid, lineId: l.lineId, qty: b.qty });
        need.set(l.ingredientId, cur);
      }
    } catch (e) {
      fail(e.code || "ERROR", e.message);
    }
  }

  const lines = [];
  for (const [ingredientId, n] of [...need.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    const ing = catalog[ingredientId];
    const where = `ingredient ${ingredientId}`;
    try {
      const canonical = str(ing.canonicalProductId, where + " canonicalProductId");
      // Round UP once, after aggregation: never short the recipe by rounding
      // each contribution down, never charge more than one unit for rounding.
      const qty = toSafe(ceilInt(n.qty), where + " qty");
      if (qty <= 0) throw new DishError("ZERO_QUANTITY", where);
      const p = priceExact(ing, qty, where);
      const recipeIds = [...n.recipeIds].sort();
      const label = qtyLabel(n.unit, qty);
      lines.push({
        lineId: "D-" + canonical,
        door: "dish_to_cart",
        shopifyVariantGid: p.reference.variantGid,
        canonicalProductId: canonical,
        sku: null,
        unit: n.unit,
        qty,
        sellUnitLabel: label,
        heroTier: null,
        provenance: { kind: "recipe", recipeIds },
        ceilingLinePaisa: p.pricePaisa,
        quotedLinePaisa: p.pricePaisa,
        pricing: {
          method: "pack_intelligence_prorated",
          profileId: ing.packProfile.profileId,
          referenceVariantGid: p.reference.variantGid,
          referenceQty: p.reference.qty,
          referencePricePaisa: p.reference.pricePaisa,
          downsized: p.downsized,
          markupPercent: p.downsized ? p.markupPercent : "0",
          cappedAtPackPrice: p.capped,
          capVariantGid: p.capVariantGid,
          rounding: "nearest_rupee",
        },
        shopifyLine: {
          variantId: p.reference.variantGid,
          quantity: 1,
          title: `${ing.name} — ${label} (Dish-to-Cart)`,
          priceSet: { shopMoney: { amount: (p.pricePaisa / 100).toFixed(2), currencyCode: "PKR" } },
          properties: [
            { name: "_asb_door", value: "dish_to_cart" },
            { name: "_asb_line_id", value: "D-" + canonical },
            { name: "_asb_canonical_product", value: canonical },
            { name: "_asb_unit", value: n.unit },
            { name: "_asb_qty", value: String(qty) },
            { name: "_asb_recipe_ids", value: recipeIds.join(",") },
            { name: "_asb_ceiling_line_paisa", value: String(p.pricePaisa) },
          ],
        },
      });
    } catch (e) {
      fail(e.code || "ERROR", e.message);
    }
  }

  if (problems.length) return { ok: false, lines: [], problems, totalPaisa: 0 };
  const totalPaisa = lines.reduce((s, l) => s + l.ceilingLinePaisa, 0);
  if (!Number.isSafeInteger(totalPaisa)) return { ok: false, lines: [], problems: [{ code: "OVERFLOW" }], totalPaisa: 0 };
  return { ok: true, lines, problems: [], totalPaisa, policyVersion: policy.version };
}

module.exports = { DishError, buildDishLines, validatePolicy, qtyLabel };
