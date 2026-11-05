// ============================================================================
// ASB PIPELINE — dish/recipe-source.js
// Read-only adapter: Recipe Master metaobjects + Product Master metafields ->
// the input shapes dish/kernel.js prices from.
//
// PURE mapping over Admin GraphQL JSON (metaobject nodes with fields[], and
// products with metafields and variants). The network fetch lives in
// dish/shopify-read.js and only ever READS.
//
// Fail-closed selection of the product that sells an ingredient:
//   * product ACTIVE, asb_product_master.verification_status = Verified,
//     asb_product_master.dish_to_cart_enabled = true, has ingredient_concept
//     and an approved pack_intelligence_profile;
//   * keyed by (ingredient concept, sell preparation form). Several products
//     on one key (Moti / Choti / Pakora mirch are all green chilli, raw) are
//     AMBIGUOUS: none is used, and the key is reported - a person must pick;
//   * a variant's pack size comes from an EXACT variant title ("125 g",
//     "1 kg", "12 pcs") or, for "Default Title", the product's own
//     pack_quantity + pack_unit. Anything else is unreadable and skipped
//     (never guessed from free text: "1/2 kg" is not 2 kg).
// ============================================================================
"use strict";

const norm = (s) => String(s ?? "").trim().toLowerCase();
const isVerified = (s) => norm(s) === "verified";
const bool = (v) => v === true || norm(v) === "true";
const list = (v) => {
  if (Array.isArray(v)) return v;
  if (v == null || v === "") return [];
  try { const x = JSON.parse(v); return Array.isArray(x) ? x : []; } catch { return []; }
};

/** metaobject node -> { id, ...fields } */
function fieldsOf(node) {
  const o = { id: node.id };
  for (const f of node.fields || []) o[f.key] = f.value;
  return o;
}
const byId = (nodes) => new Map((nodes || []).map((n) => { const f = fieldsOf(n); return [f.id, f]; }));

// ---------------------------------------------------------------------------
// Units, scaling profiles, conversions
// ---------------------------------------------------------------------------
function mapUnits(unitNodes) {
  const units = byId(unitNodes);
  // base unit per dimension, so a conversion stated in ml applies to tsp
  const baseByDim = new Map();
  for (const u of units.values()) if (bool(u.is_base_unit)) baseByDim.set(norm(u.measurement_dimension), u.id);
  const out = new Map();
  for (const u of units.values()) {
    out.set(u.id, {
      id: u.id, symbol: u.unit_symbol, dimension: u.measurement_dimension,
      factorToBase: u.conversion_factor_to_base_unit, active: bool(u.active),
      verificationStatus: u.verification_status, baseUnitId: baseByDim.get(norm(u.measurement_dimension)) || null,
    });
  }
  return out;
}

function mapScaling(profileNodes) {
  const out = new Map();
  for (const p of byId(profileNodes).values()) {
    out.set(p.id, { method: p.scaling_method, exponent: p.scaling_exponent, maxMultiplier: p.maximum_scale_multiplier,
                    active: bool(p.active), verificationStatus: p.verification_status });
  }
  return out;
}

function conversionsByIngredient(convNodes) {
  const out = new Map();
  for (const c of byId(convNodes).values()) {
    const arr = out.get(c.ingredient) || [];
    arr.push({ id: c.id, sourceUnitId: c.source_unit, sourceQuantity: c.source_quantity,
               canonicalQuantity: c.equivalent_canonical_quantity, active: bool(c.active),
               verificationStatus: c.verification_status, preparationForms: list(c.preparation_form) });
    out.set(c.ingredient, arr);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Pack Intelligence profile -> kernel packProfile. The rounding rule is free
// text in Shopify; only the approved wording maps to "nearest_rupee".
// ---------------------------------------------------------------------------
function mapPackProfile(p) {
  if (!p) return null;
  return {
    profileId: p.profile_id,
    verificationStatus: p.verification_status,
    commerceStatus: p.commerce_status,
    downsizingMarkupPercent: p.downsizing_markup_percent,
    roundingRule: /round the final selling price to the nearest whole pkr/i.test(p.rounding_rule || "") ? "nearest_rupee" : "unrecognised",
    minimumPracticalQuantity: p.minimum_practical_quantity,
  };
}

// ---------------------------------------------------------------------------
// Pack size of one variant. Exact titles only.
// ---------------------------------------------------------------------------
const TITLE = /^\s*(\d+(?:\.\d{1,3})?)\s*(g|gm|gms|gram|grams|kg|pc|pcs|piece|pieces|adad|dozen|darjan|gaddi|bunch)\s*$/i;
function variantPack(variantTitle, product, units) {
  if (variantTitle && variantTitle !== "Default Title") {
    const m = TITLE.exec(variantTitle);
    if (!m) return null;
    const n = m[1], u = m[2].toLowerCase();
    const [whole, f = ""] = n.split(".");
    const milli = Number(whole) * 1000 + Number(f.padEnd(3, "0"));
    if (["kg"].includes(u)) return { unit: "g", qty: milli };
    if (["dozen", "darjan"].includes(u)) return Number.isInteger(milli * 12 / 1000) ? { unit: "piece", qty: milli * 12 / 1000 } : null;
    const q = milli / 1000;
    if (!Number.isSafeInteger(q) || q <= 0) return null;
    return { unit: ["g", "gm", "gms", "gram", "grams"].includes(u) ? "g" : "piece", qty: q };
  }
  const pq = product.packQuantity, pu = units.get(product.packUnit);
  if (pq == null || !pu || !isVerified(pu.verificationStatus)) return null;
  const m = /^(\d+)(?:\.(\d{1,3}))?$/.exec(String(pq).trim());
  if (!m) return null;
  const f = dec3(m[2]);
  const factor = /^(\d+)(?:\.(\d{1,3}))?$/.exec(String(pu.factorToBase).trim());
  if (!factor) return null;
  const qtyMilli = (Number(m[1]) * 1000 + f) * (Number(factor[1]) * 1000 + dec3(factor[2])) / 1000;
  const q = qtyMilli / 1000;
  if (!Number.isSafeInteger(q) || q <= 0) return null;
  const dim = norm(pu.dimension);
  return { unit: dim === "mass" ? "g" : dim === "piece" || dim === "count" ? "piece" : null, qty: q };
}
function dec3(f) { return Number(String(f || "").padEnd(3, "0")); }

/** "145.00" -> 14500, exactly */
function pricePaisa(price) {
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(String(price ?? "").trim());
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] || "").padEnd(2, "0"));
}

// ---------------------------------------------------------------------------
// Catalogue: ingredient key -> sellable product, plus the readiness report.
// Key = conceptId + "|" + (preparation form id or "*").
// ---------------------------------------------------------------------------
function mapCatalog({ productNodes, conceptNodes, packProfileNodes, conversionNodes, unitNodes }) {
  const units = mapUnits(unitNodes);
  const concepts = byId(conceptNodes);
  const profiles = byId(packProfileNodes);
  const conversions = conversionsByIngredient(conversionNodes);
  const issues = [];
  const candidates = new Map(); // key -> [product]

  for (const p of productNodes || []) {
    const mf = (k) => p[k]?.value ?? null;
    const prod = {
      id: p.id, title: p.title, status: p.status,
      verified: isVerified(mf("verification")), dishEnabled: bool(mf("dishEnabled")),
      conceptId: mf("ingredientConcept"), formId: mf("sellForm"), profileId: mf("packProfile"),
      packQuantity: mf("packQuantity"), packUnit: mf("packUnit"),
      variants: p.variants?.nodes || [],
    };
    if (!prod.dishEnabled) continue; // not offered to Dish at all: silent
    const why = [];
    if (prod.status !== "ACTIVE") why.push("not ACTIVE");
    if (!prod.verified) why.push("product master not Verified");
    if (!prod.conceptId) why.push("no ingredient_concept");
    if (!prod.profileId) why.push("no pack_intelligence_profile");
    if (why.length) { issues.push({ code: "PRODUCT_NOT_READY", productId: prod.id, title: prod.title, detail: why.join("; ") }); continue; }
    for (const key of [prod.conceptId + "|" + (prod.formId || "*"), prod.conceptId + "|*"]) {
      const arr = candidates.get(key) || [];
      if (!arr.includes(prod)) arr.push(prod);
      candidates.set(key, arr);
    }
  }

  const catalog = {};
  for (const [key, prods] of candidates) {
    if (prods.length > 1) {
      issues.push({ code: "AMBIGUOUS_SELLABLE", key, detail: prods.map((x) => x.title).join(" | ") });
      continue;
    }
    const prod = prods[0];
    const concept = concepts.get(prod.conceptId);
    if (!concept || !isVerified(concept.verification_status)) {
      issues.push({ code: "CONCEPT_NOT_VERIFIED", key, detail: prod.title });
      continue;
    }
    const packs = [];
    for (const v of prod.variants) {
      const pk = variantPack(v.title, prod, units);
      const paisa = pricePaisa(v.price);
      if (!pk || !pk.unit || paisa == null || paisa <= 0) {
        issues.push({ code: "VARIANT_UNREADABLE", key, detail: `${prod.title} / ${v.title} / ${v.price}` });
        continue;
      }
      packs.push({ variantGid: v.id, unit: pk.unit, qty: pk.qty, pricePaisa: paisa, live: true, verified: true });
    }
    const units0 = [...new Set(packs.map((x) => x.unit))];
    if (units0.length !== 1) {
      issues.push({ code: units0.length ? "MIXED_PACK_UNITS" : "NO_READABLE_PACKS", key, detail: prod.title });
      continue;
    }
    catalog[key] = {
      canonicalProductId: "ASB-CANON-" + String(concept.ingredient_id || prod.conceptId).toUpperCase(),
      name: String(prod.title).split(/\s+[—–|(-]\s*/)[0].trim(),
      unit: units0[0],
      pantryExcludable: norm(concept.pantry_class).startsWith("pantry"),
      edibleYield: concept.default_edible_yield ?? null,
      conversions: conversions.get(prod.conceptId) || [],
      packProfile: mapPackProfile(profiles.get(prod.profileId)),
      packs,
      productGid: prod.id,
    };
  }
  return { catalog, issues };
}

// ---------------------------------------------------------------------------
// Recipes.
// ---------------------------------------------------------------------------
function mapRecipes({ recipeNodes, lineNodes, unitNodes, scalingNodes, groupNodes, choiceNodes }) {
  const units = mapUnits(unitNodes);
  const scaling = mapScaling(scalingNodes);
  const groups = byId(groupNodes);
  const choices = byId(choiceNodes);
  const recipes = {};
  const gidToRecipeId = new Map();

  for (const r of byId(recipeNodes).values()) {
    const rid = r.recipe_id;
    if (!rid) continue;
    gidToRecipeId.set(r.id, rid);
    recipes[rid] = {
      recipeId: rid, gid: r.id, name: r.english_name, active: bool(r.active),
      verificationStatus: r.verification_status, baseServings: Number(r.base_servings),
      optionGroups: [], ingredients: [],
    };
  }

  // Option groups: only active, verified groups with active, verified choices.
  // A recipe line tied to a choice of an unusable group makes the recipe
  // unusable (the kernel will see an unknown choice and fail closed).
  const choicesByGroup = new Map();
  for (const c of choices.values()) {
    if (!bool(c.active) || !isVerified(c.verification_status)) continue;
    const arr = choicesByGroup.get(c.option_group) || [];
    arr.push(c.option_choice_id || c.id);
    choicesByGroup.set(c.option_group, arr);
  }
  const choiceCode = new Map([...choices.values()].map((c) => [c.id, c.option_choice_id || c.id]));
  for (const g of groups.values()) {
    const rid = gidToRecipeId.get(g.recipe);
    if (!rid) continue;
    if (!bool(g.active) || !isVerified(g.verification_status) || norm(g.selection_mode) !== "single select") {
      recipes[rid].unusableOptionGroup = g.option_group_id || g.id; // recipe fails closed below
      continue;
    }
    recipes[rid].optionGroups.push({ groupId: g.option_group_id || g.id, choiceIds: choicesByGroup.get(g.id) || [] });
  }

  for (const l of byId(lineNodes).values()) {
    const rid = gidToRecipeId.get(l.recipe);
    if (!rid) continue;
    const forms = list(l.preparation_forms);
    if (forms.length > 1) { recipes[rid].ambiguousForm = l.recipe_ingredient_id; }
    recipes[rid].ingredients.push({
      lineId: l.recipe_ingredient_id || l.id,
      ingredientId: l.ingredient + "|" + (forms.length === 1 ? forms[0] : "*"),
      baseQuantity: l.base_quantity,
      unit: units.get(l.unit) || null,
      scaling: scaling.get(l.scaling_profile) || null,
      quantityBasis: l.quantity_basis,
      minQuantity: l.minimum_quantity ?? null,
      maxQuantity: l.maximum_quantity ?? null,
      optionChoiceIds: list(l.applicable_option_choices).map((c) => choiceCode.get(c) || c),
      active: bool(l.active),
      verificationStatus: l.verification_status,
      displayOrder: Number(l.display_order) || 0,
    });
  }

  // Recipes the adapter itself knows are unsafe are marked unverified, so
  // the kernel refuses them with a clear code rather than guessing.
  for (const r of Object.values(recipes)) {
    r.ingredients.sort((a, b) => a.displayOrder - b.displayOrder);
    if (r.unusableOptionGroup) { r.verificationStatus = "adapter: option group not ready"; }
    if (r.ambiguousForm) { r.verificationStatus = "adapter: line with several preparation forms"; }
  }
  return recipes;
}

// ---------------------------------------------------------------------------
// Readiness: which recipes the kernel could price today, and why not.
// ---------------------------------------------------------------------------
function readiness({ recipes, catalog, kernel, policy }) {
  const rows = [];
  for (const r of Object.values(recipes).sort((a, b) => (a.recipeId < b.recipeId ? -1 : 1))) {
    const optionChoices = {};
    for (const g of r.optionGroups) if (g.choiceIds.length) optionChoices[g.groupId] = g.choiceIds[0];
    const res = kernel.buildDishLines({
      cycleCode: "READINESS", policy, recipes, catalog,
      selections: [{ recipeId: r.recipeId, servings: Number.isSafeInteger(r.baseServings) && r.baseServings > 0 ? r.baseServings : 1, optionChoices }],
    });
    rows.push({ recipeId: r.recipeId, name: r.name, ready: res.ok,
                firstProblem: res.ok ? null : res.problems[0].code, problems: res.problems.length,
                totalPaisa: res.ok ? res.totalPaisa : null });
  }
  const byProblem = {};
  for (const r of rows) if (!r.ready) byProblem[r.firstProblem] = (byProblem[r.firstProblem] || 0) + 1;
  return { recipes: rows.length, ready: rows.filter((r) => r.ready).length, byFirstProblem: byProblem, rows };
}

module.exports = { fieldsOf, mapUnits, mapScaling, mapPackProfile, variantPack, pricePaisa, mapCatalog, mapRecipes, readiness };
