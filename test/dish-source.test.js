// Dish-to-Cart read-only adapter: Recipe Master + Product Master -> kernel input.
// Fixtures copy the live Admin API shapes read on 5 Nov 2026 (units,
// scaling profiles, PCK-000001, option group ROG-000001, RIN-000001..3,
// IMC-000001, Adrak / Payaz / green chilli products), trimmed.
//   node --test test/dish-source.test.js
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const kernel = require("../dish/kernel");
const src = require("../dish/recipe-source");
const { loadDishSources } = require("../dish/shopify-read");
const { run } = require("../scripts/dish-readiness");

const mo = (id, fields) => ({ id, fields: Object.entries(fields).map(([key, value]) => ({ key, value })) });
const G = (n) => "gid://shopify/Metaobject/" + n;

const unitNodes = [
  mo(G(279824695554), { unit_id: "UNT-000001", unit_symbol: "g", measurement_dimension: "Mass", conversion_factor_to_base_unit: "1.0", is_base_unit: "true", active: "true", verification_status: "Verified " }),
  mo(G(279830987010), { unit_id: "UNT-000002", unit_symbol: "kg", measurement_dimension: "Mass", conversion_factor_to_base_unit: "1000.0", is_base_unit: "false", active: "true", verification_status: "Verified " }),
  mo(G(279833313538), { unit_id: "UNT-000005", unit_symbol: "pc", measurement_dimension: "Piece", conversion_factor_to_base_unit: "1.0", is_base_unit: "true", active: "true", verification_status: "Verified " }),
];
const scalingNodes = [
  mo(G(280530649346), { scaling_profile_id: "SCL-000001", scaling_method: "Linear ", active: "true", verification_status: "Verified " }),
  mo(G(280533369090), { scaling_profile_id: "SCL-000002", scaling_method: "Power Curve", scaling_exponent: "0.85", active: "true", verification_status: "Needs Review" }),
];
const packProfileNodes = [
  mo(G(325368840450), { profile_id: "PCK-000001", verification_status: "Verified", commerce_status: "Approved", downsizing_markup_percent: "20.0",
    minimum_practical_quantity: "125.0", rounding_rule: "Apply the 20% markup after prorating, then round the final selling price to the nearest whole PKR." }),
  mo(G(325368873218), { profile_id: "PCK-000002", verification_status: "Verified", commerce_status: "Approved", downsizing_markup_percent: "20.0",
    minimum_practical_quantity: "250.0", rounding_rule: "Apply the 20% markup after prorating, then round the final selling price to the nearest whole PKR." }),
];
const RAW = G(280146673922);
const conceptNodes = [
  mo(G(281919226114), { ingredient_id: "ING-GINGER", english_name: "Ginger", pantry_class: "Fresh", verification_status: "Verified" }),
  mo(G(279852253442), { ingredient_id: "ING-ONION", english_name: "Onion", pantry_class: "Fresh", verification_status: "Verified", default_edible_yield: "0.90" }),
  mo(G(281937051906), { ingredient_id: "ING-GREEN-CHILLI", english_name: "Green chilli", verification_status: "Verified" }),
  mo(G(281883214082), { ingredient_id: "ING-MUTTON", english_name: "Mutton", verification_status: "Verified" }),
];
const conversionNodes = [
  mo(G(280149098754), { conversion_id: "IMC-000001", ingredient: G(279852253442), source_unit: G(279833313538), source_quantity: "1.0",
    equivalent_canonical_quantity: "130.0", active: "false", verification_status: "Needs Review" }),
];
const groupNodes = [
  mo(G(281887736066), { option_group_id: "ROG-000001", recipe: G(280655462658), selection_mode: "Single Select ", minimum_selections: "1", active: "false", verification_status: "Needs Review" }),
];
const choiceNodes = [
  mo(G(281888260354), { option_choice_id: "ROC-000001", option_group: G(281887736066), mapped_ingredient: G(281883214082), active: "true", verification_status: "Needs Review" }),
];
const recipeNodes = [
  mo(G(280655462658), { recipe_id: "RCP-000001", english_name: "Aloo Gosht", base_servings: "4", active: "false", verification_status: "Needs Review" }),
  mo(G(900000000001), { recipe_id: "RCP-TEST-1", english_name: "Adrak Chai Test", base_servings: "4", active: "true", verification_status: "Verified " }),
  mo(G(900000000002), { recipe_id: "RCP-TEST-2", english_name: "Mirch Test", base_servings: "2", active: "true", verification_status: "Verified" }),
];
const lineNodes = [
  mo(G(1), { recipe_ingredient_id: "RIN-000001", recipe: G(280655462658), ingredient: G(281883214082), base_quantity: "500.0", unit: G(279824695554),
    scaling_profile: G(280530649346), quantity_basis: "As Purchased ", active: "false", verification_status: "Needs Review",
    applicable_option_choices: JSON.stringify([G(281888260354)]), display_order: "1" }),
  mo(G(2), { recipe_ingredient_id: "RIN-T1", recipe: G(900000000001), ingredient: G(281919226114), preparation_forms: JSON.stringify([RAW]),
    base_quantity: "40.0", unit: G(279824695554), scaling_profile: G(280530649346), quantity_basis: "As Purchased ", active: "true",
    verification_status: "Verified", display_order: "2" }),
  mo(G(3), { recipe_ingredient_id: "RIN-T2", recipe: G(900000000001), ingredient: G(279852253442), base_quantity: "0.3",
    unit: G(279830987010), scaling_profile: G(280530649346), quantity_basis: "As Purchased ", active: "true",
    verification_status: "Verified", display_order: "1" }),
  mo(G(4), { recipe_ingredient_id: "RIN-T3", recipe: G(900000000002), ingredient: G(281937051906), base_quantity: "20",
    unit: G(279824695554), scaling_profile: G(280530649346), quantity_basis: "As Purchased ", active: "true", verification_status: "Verified" }),
];
const v = (value) => (value == null ? null : { value });
const product = (id, title, { dish = "true", ver = "Verified", concept, form = null, profile, pq = null, pu = null, variants, status = "ACTIVE" }) => ({
  id: "gid://shopify/Product/" + id, title, status, verification: v(ver), dishEnabled: v(dish), ingredientConcept: v(concept),
  sellForm: v(form), packProfile: v(profile), packQuantity: v(pq), packUnit: v(pu),
  variants: { nodes: variants, pageInfo: { hasNextPage: false } },
});
const productNodes = [
  product(9418086252802, "Adrak — 250 gm | ادرک", { concept: G(281919226114), form: RAW, profile: G(325368840450),
    variants: [{ id: "gid://shopify/ProductVariant/47836668592386", title: "250 g", price: "145.00" },
               { id: "gid://shopify/ProductVariant/50590949474562", title: "125 g", price: "87.00" }] }),
  product(9280522322178, "Payaz — 500 gm | پیاز", { concept: G(279852253442), form: RAW, profile: G(325368873218), pq: "500.0", pu: G(279824695554),
    variants: [{ id: "gid://shopify/ProductVariant/47322505052418", title: "Default Title", price: "105.00" }] }),
  ...["Moti", "Choti", "Pakora"].map((k, i) => product(10331738767618 + i, `${k} Mirch — 250 gm`, { concept: G(281937051906), form: RAW,
    profile: G(325368840450), variants: [{ id: "gid://shopify/ProductVariant/" + (700 + i), title: "250 g", price: "60.00" }] })),
  product(9418087334146, "Lemon — 250 gm | لیموں", { dish: null, concept: G(1), profile: G(325368840450),
    variants: [{ id: "gid://shopify/ProductVariant/9", title: "Default Title", price: "50.00" }] }),
];
const sources = () => ({ recipeNodes, lineNodes, unitNodes, scalingNodes, groupNodes, choiceNodes, conceptNodes,
  conversionNodes, packProfileNodes, productNodes });
const POLICY = { version: "T", maxServings: 50, maxRecipes: 10, allowedScalingMethods: ["linear", "fixed"] };

test("variant pack sizes come from exact titles only, never guessed", () => {
  const units = src.mapUnits(unitNodes);
  const p = { packQuantity: "500.0", packUnit: G(279824695554) };
  assert.deepEqual(src.variantPack("125 g", p, units), { unit: "g", qty: 125 });
  assert.deepEqual(src.variantPack("1.5 kg", p, units), { unit: "g", qty: 1500 });
  assert.deepEqual(src.variantPack("12 pcs", p, units), { unit: "piece", qty: 12 });
  assert.deepEqual(src.variantPack("1 dozen", p, units), { unit: "piece", qty: 12 });
  assert.deepEqual(src.variantPack("1 gaddi", p, units), { unit: "piece", qty: 1 });
  assert.deepEqual(src.variantPack("Default Title", p, units), { unit: "g", qty: 500 });
  for (const bad of ["1/2 kg", "2 x 500 g", "125 g + 250 g", "Fresh", "aadha kg", "0.0005 kg", "1.5 pcs"]) {
    assert.equal(src.variantPack(bad, p, units), null, bad);
  }
  assert.equal(src.variantPack("Default Title", { packQuantity: null }, units), null);
});

test("prices are read exactly in paisa", () => {
  assert.equal(src.pricePaisa("145.00"), 14500);
  assert.equal(src.pricePaisa("87"), 8700);
  assert.equal(src.pricePaisa("0.5"), 50);
  for (const bad of ["-1", "1e3", "abc", "", null, "1.234"]) assert.equal(src.pricePaisa(bad), null, String(bad));
});

test("catalogue: dish-enabled, verified, unambiguous products only; the rest are reported", () => {
  const { catalog, issues } = src.mapCatalog(sources());
  const ginger = catalog[G(281919226114) + "|" + RAW];
  assert.equal(ginger.canonicalProductId, "ASB-CANON-ING-GINGER");
  assert.equal(ginger.name, "Adrak");
  assert.deepEqual(ginger.packs.map((p) => [p.qty, p.pricePaisa]), [[250, 14500], [125, 8700]]);
  assert.equal(ginger.packProfile.roundingRule, "nearest_rupee");
  const onion = catalog[G(279852253442) + "|*"];
  assert.deepEqual(onion.packs.map((p) => [p.qty, p.pricePaisa]), [[500, 10500]]); // Default Title -> pack_quantity
  assert.equal(onion.conversions.length, 1); // carried, but Needs Review -> kernel will not use it
  assert.ok(!Object.keys(catalog).some((k) => k.startsWith(G(281937051906))), "green chilli is ambiguous");
  const amb = issues.filter((i) => i.code === "AMBIGUOUS_SELLABLE");
  assert.ok(amb.some((i) => /Moti Mirch.*Choti Mirch.*Pakora Mirch/.test(i.detail)));
  assert.ok(!JSON.stringify(catalog).includes("Lemon"), "not dish_to_cart_enabled -> not offered");
});

test("unrecognised rounding wording is not treated as approved", () => {
  assert.equal(src.mapPackProfile({ rounding_rule: "round up to the next 5 rupees" }).roundingRule, "unrecognised");
});

test("recipes: real Aloo Gosht shape is refused (inactive, Needs Review, option group not ready)", () => {
  const recipes = src.mapRecipes(sources());
  const { catalog } = src.mapCatalog(sources());
  const r = kernel.buildDishLines({ cycleCode: "T", policy: POLICY, recipes, catalog,
    selections: [{ recipeId: "RCP-000001", servings: 4, optionChoices: {} }] });
  assert.equal(r.ok, false);
  assert.equal(r.problems[0].code, "RECIPE_NOT_VERIFIED");
});

test("end to end: a verified recipe prices from live-shape data exactly as the kernel does", () => {
  const recipes = src.mapRecipes(sources());
  const { catalog } = src.mapCatalog(sources());
  assert.deepEqual(recipes["RCP-TEST-1"].ingredients.map((l) => l.lineId), ["RIN-T2", "RIN-T1"]); // display order
  const r = kernel.buildDishLines({ cycleCode: "T", policy: POLICY, recipes, catalog,
    selections: [{ recipeId: "RCP-TEST-1", servings: 4 }] });
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  const by = Object.fromEntries(r.lines.map((l) => [l.canonicalProductId, l]));
  assert.equal(by["ASB-CANON-ING-GINGER"].qty, 40);
  assert.equal(by["ASB-CANON-ING-GINGER"].ceilingLinePaisa, 3300);
  assert.equal(by["ASB-CANON-ING-GINGER"].shopifyVariantGid, "gid://shopify/ProductVariant/50590949474562");
  assert.equal(by["ASB-CANON-ING-ONION"].qty, 300); // 0.3 kg
  // 105 x 300/500 x 1.2 = 75.6 -> Rs 76
  assert.equal(by["ASB-CANON-ING-ONION"].ceilingLinePaisa, 7600);
});

test("a recipe needing an ambiguous product fails closed", () => {
  const recipes = src.mapRecipes(sources());
  const { catalog } = src.mapCatalog(sources());
  const r = kernel.buildDishLines({ cycleCode: "T", policy: POLICY, recipes, catalog,
    selections: [{ recipeId: "RCP-TEST-2", servings: 2 }] });
  assert.equal(r.problems[0].code, "INGREDIENT_NOT_SELLABLE");
});

function fakeGraphql(data, pageSize = 2) {
  const calls = [];
  const fn = async (query, vars) => {
    calls.push({ query, vars });
    const after = vars.after ? Number(vars.after) : 0;
    let all;
    if (/metaobjects\(/.test(query)) {
      const key = Object.entries(require("../dish/shopify-read").METAOBJECT_TYPES).find(([, t]) => t === vars.type)[0];
      all = data[key];
    } else all = data.productNodes;
    const nodes = all.slice(after, after + pageSize);
    const conn = { nodes, pageInfo: { hasNextPage: after + pageSize < all.length, endCursor: String(after + pageSize) } };
    return /metaobjects\(/.test(query) ? { metaobjects: conn } : { products: conn };
  };
  return { fn, calls };
}

test("loader: paginates every type in full, and only ever sends queries", async () => {
  const { fn, calls } = fakeGraphql(sources());
  const s = await loadDishSources(fn);
  assert.equal(s.productNodes.length, productNodes.length);
  assert.equal(s.lineNodes.length, lineNodes.length);
  assert.ok(calls.length > 10);
  for (const c of calls) {
    assert.match(c.query, /^query\b/);
    assert.doesNotMatch(c.query, /mutation/i);
  }
});

test("loader refuses a partial read (product with more than 100 variants)", async () => {
  const s = sources();
  s.productNodes = [{ ...productNodes[0], variants: { nodes: [], pageInfo: { hasNextPage: true } } }];
  const { fn } = fakeGraphql(s);
  await assert.rejects(loadDishSources(fn), /refusing a partial read/);
});

test("readiness report: counts ready recipes and names what blocks the rest", async () => {
  const { fn } = fakeGraphql(sources());
  const out = await run({ graphql: fn });
  assert.equal(out.counts.recipes, 3);
  assert.equal(out.counts.ready, 1);
  assert.deepEqual(out.blockedByFirstProblem, { RECIPE_NOT_VERIFIED: 1, INGREDIENT_NOT_SELLABLE: 1 });
  assert.ok(out.catalogIssues.some((i) => i.code === "AMBIGUOUS_SELLABLE"));
});
