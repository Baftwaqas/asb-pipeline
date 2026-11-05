// ADR-002 Lane C — Dish-to-Cart exact-quantity pricing (dish/kernel.js). Pure.
//   node --test test/dish-kernel.test.js
//
// Fixture prices are the live Shopify catalogue as read on 5 Nov 2026
// (Adrak 125 g Rs 87 / 250 g Rs 145, Payaz 500 g Rs 105), for illustration.
// Recipe and unit shapes mirror the Recipe Master metaobjects, including
// their stray spaces ("Verified ", "As Purchased ").
"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const { buildDishLines, validatePolicy, qtyLabel } = require("../dish/kernel");

const POLICY = { version: "DISH-PRICING-DRAFT-1", maxServings: 50, maxRecipes: 10, allowedScalingMethods: ["linear", "fixed"] };
const GRAM = { symbol: "g", dimension: "Mass", factorToBase: "1.0", active: true, verificationStatus: "Verified " };
const KG = { symbol: "kg", dimension: "Mass", factorToBase: "1000.0", active: true, verificationStatus: "Verified " };
const PIECE = { symbol: "pc", dimension: "Piece", factorToBase: "1.0", active: true, verificationStatus: "Verified " };
const TSP = { id: "UNT-000007", baseUnitId: "UNT-000003", symbol: "tsp", dimension: "Volume", factorToBase: "5.0", active: true, verificationStatus: "Verified " };
const PIECE_U = { id: "UNT-000005", baseUnitId: "UNT-000005", symbol: "pc", dimension: "Piece", factorToBase: "1.0", active: true, verificationStatus: "Verified " };
const LINEAR = { method: "Linear ", active: true, verificationStatus: "Verified " };
const FIXED = { method: "Fixed", active: true, verificationStatus: "Verified " };
const POWER = { method: "Power Curve", exponent: "0.85", active: true, verificationStatus: "Needs Review" };
const PCK = (id, min) => ({ profileId: id, verificationStatus: "Verified", commerceStatus: "Approved",
  downsizingMarkupPercent: "20.0", roundingRule: "nearest_rupee", minimumPracticalQuantity: min });

const catalog = () => ({
  "ING-GINGER": { canonicalProductId: "ASB-CANON-GINGER", name: "Adrak", unit: "g", packProfile: PCK("PCK-000001", 125),
    packs: [{ variantGid: "gid://shopify/ProductVariant/50590949474562", unit: "g", qty: 125, pricePaisa: 8700, live: true, verified: true },
            { variantGid: "gid://shopify/ProductVariant/47836668592386", unit: "g", qty: 250, pricePaisa: 14500, live: true, verified: true }] },
  "ING-ONION": { canonicalProductId: "ASB-CANON-ONION", name: "Payaz", unit: "g", packProfile: PCK("PCK-000002", 250), edibleYield: "0.90",
    packs: [{ variantGid: "gid://shopify/ProductVariant/47322505052418", unit: "g", qty: 500, pricePaisa: 10500, live: true, verified: true }] },
  "ING-SALT": { canonicalProductId: "ASB-CANON-SALT", name: "Namak", unit: "g", pantryExcludable: true, packProfile: PCK("PCK-X", 100),
    conversions: [{ sourceUnitId: "UNT-000003", sourceQuantity: "1.0", canonicalQuantity: "1.2", active: true, verificationStatus: "Verified" }],
    packs: [{ variantGid: "gid://shopify/ProductVariant/9", unit: "g", qty: 800, pricePaisa: 6000, live: true, verified: true }] },
  "ING-EGG": { canonicalProductId: "ASB-CANON-EGG", name: "Anday", unit: "piece", packProfile: PCK("PCK-E", 12),
    packs: [{ variantGid: "gid://shopify/ProductVariant/12", unit: "piece", qty: 12, pricePaisa: 42000, live: true, verified: true }] },
  "ING-GOAT": { canonicalProductId: "ASB-CANON-GOAT", name: "Gosht", unit: "g", packProfile: PCK("PCK-G", 500),
    packs: [{ variantGid: "gid://shopify/ProductVariant/20", unit: "g", qty: 1000, pricePaisa: 220000, live: true, verified: true }] },
  "ING-BEEF": { canonicalProductId: "ASB-CANON-BEEF", name: "Beef", unit: "g", packProfile: PCK("PCK-G", 500),
    packs: [{ variantGid: "gid://shopify/ProductVariant/21", unit: "g", qty: 1000, pricePaisa: 120000, live: true, verified: true }] },
});

const line = (lineId, ingredientId, baseQuantity, over = {}) => ({ lineId, ingredientId, baseQuantity, unit: GRAM, scaling: LINEAR,
  quantityBasis: "As Purchased ", active: true, verificationStatus: "Verified", optionChoiceIds: [], ...over });

const recipes = () => ({
  "RCP-000007": { recipeId: "RCP-000007", active: true, verificationStatus: "Verified ", baseServings: 4, optionGroups: [],
    ingredients: [line("RIN-1", "ING-GINGER", "40.0"), line("RIN-2", "ING-ONION", "300.0"),
                  line("RIN-3", "ING-SALT", "1.0", { unit: TSP, scaling: FIXED })] },
  "RCP-000008": { recipeId: "RCP-000008", active: true, verificationStatus: "Verified", baseServings: 2, optionGroups: [],
    ingredients: [line("RIN-4", "ING-GINGER", "15.0"), line("RIN-5", "ING-EGG", "3", { unit: PIECE })] },
  "RCP-ALOO-GOSHT": { recipeId: "RCP-ALOO-GOSHT", active: true, verificationStatus: "Verified", baseServings: 4,
    optionGroups: [{ groupId: "OPT-MEAT", choiceIds: ["CH-GOAT", "CH-BEEF"] }],
    ingredients: [line("RIN-6", "ING-GOAT", "500.0", { optionChoiceIds: ["CH-GOAT"] }),
                  line("RIN-7", "ING-BEEF", "500.0", { optionChoiceIds: ["CH-BEEF"] }),
                  line("RIN-8", "ING-ONION", "0.25", { unit: KG })] },
});

const run = (selections, over = {}) => buildDishLines({ cycleCode: "MON-2026-11-09", selections,
  recipes: recipes(), catalog: catalog(), policy: POLICY, ...over });
const byCanon = (r) => Object.fromEntries(r.lines.map((l) => [l.canonicalProductId, l]));

test("40 g ginger (below the Apna 125 g minimum) is sold exactly, priced from the 125 g pack + 20%", () => {
  const r = run([{ recipeId: "RCP-000007", servings: 4 }]);
  assert.equal(r.ok, true, JSON.stringify(r.problems));
  const g = byCanon(r)["ASB-CANON-GINGER"];
  assert.equal(g.qty, 40);
  // Rs 87 x 40/125 x 1.20 = Rs 33.408 -> Rs 33 (nearest rupee)
  assert.equal(g.ceilingLinePaisa, 3300);
  assert.equal(g.quotedLinePaisa, 3300);
  assert.equal(g.pricing.referenceQty, 125);
  assert.equal(g.pricing.downsized, true);
  assert.deepEqual(g.provenance, { kind: "recipe", recipeIds: ["RCP-000007"] });
  assert.equal(g.door, "dish_to_cart");
});

test("Shopify line is quantity 1 at the whole line price, grams in properties (contract §4)", () => {
  const g = byCanon(run([{ recipeId: "RCP-000007", servings: 4 }]))["ASB-CANON-GINGER"];
  assert.equal(g.shopifyLine.quantity, 1);
  assert.deepEqual(g.shopifyLine.priceSet, { shopMoney: { amount: "33.00", currencyCode: "PKR" } });
  assert.equal(g.shopifyLine.title, "Adrak — 40 g (Dish-to-Cart)");
  const props = Object.fromEntries(g.shopifyLine.properties.map((p) => [p.name, p.value]));
  assert.deepEqual([props._asb_qty, props._asb_unit, props._asb_recipe_ids, props._asb_ceiling_line_paisa],
    ["40", "g", "RCP-000007", "3300"]);
});

test("ingredients are aggregated across recipes BEFORE pricing, and rounded up once", () => {
  // ginger: 40 g (4 servings of a 4-serving recipe) + 15 g x 3/2 = 22.5 g -> 62.5 g -> 63 g
  const r = run([{ recipeId: "RCP-000007", servings: 4 }, { recipeId: "RCP-000008", servings: 3 }]);
  const g = byCanon(r)["ASB-CANON-GINGER"];
  assert.equal(g.qty, 63);
  assert.deepEqual(g.provenance.recipeIds, ["RCP-000007", "RCP-000008"]);
  // Rs 87 x 63/125 x 1.2 = 52.6176 -> Rs 53; pricing two separate lines would round twice.
  assert.equal(g.ceilingLinePaisa, 5300);
  assert.equal(r.lines.filter((l) => l.canonicalProductId === "ASB-CANON-GINGER").length, 1);
});

test("servings scale linearly; Fixed stays fixed; eggs round up to whole pieces", () => {
  const r = byCanon(run([{ recipeId: "RCP-000007", servings: 6 }, { recipeId: "RCP-000008", servings: 3 }]));
  assert.equal(r["ASB-CANON-ONION"].qty, 450);       // 300 x 6/4
  assert.equal(r["ASB-CANON-SALT"].qty, 6);          // 1 tsp = 5 ml x 1.2 g/ml, fixed
  assert.equal(r["ASB-CANON-EGG"].qty, 5);           // 3 x 3/2 = 4.5 -> 5
  assert.equal(r["ASB-CANON-EGG"].sellUnitLabel, "5 adad");
});

test("a quantity above the reference pack gets no markup", () => {
  // onion 300 g x 8/4 = 600 g; nearest pack 500 g @ Rs 105 -> Rs 126, no 20%
  const o = byCanon(run([{ recipeId: "RCP-000007", servings: 8 }]))["ASB-CANON-ONION"];
  assert.equal(o.qty, 600);
  assert.equal(o.pricing.downsized, false);
  assert.equal(o.ceilingLinePaisa, 12600);
});

test("never more than a whole pack that already covers the need (120 g ginger vs the 125 g pack)", () => {
  const rec = recipes();
  rec["RCP-000007"].ingredients = [line("RIN-1", "ING-GINGER", "120.0")];
  const g = byCanon(run([{ recipeId: "RCP-000007", servings: 4 }], { recipes: rec }))["ASB-CANON-GINGER"];
  // Rs 87 x 120/125 x 1.2 = Rs 100.22 would exceed the Rs 87 pack
  assert.equal(g.ceilingLinePaisa, 8700);
  assert.equal(g.pricing.cappedAtPackPrice, true);
});

test("option groups: exactly one valid choice; only that choice's lines are bought", () => {
  const r = byCanon(run([{ recipeId: "RCP-ALOO-GOSHT", servings: 4, optionChoices: { "OPT-MEAT": "CH-BEEF" } }]));
  assert.ok(r["ASB-CANON-BEEF"] && !r["ASB-CANON-GOAT"]);
  assert.equal(r["ASB-CANON-ONION"].qty, 250); // 0.25 kg
  const none = run([{ recipeId: "RCP-ALOO-GOSHT", servings: 4 }]);
  assert.equal(none.ok, false);
  assert.equal(none.problems[0].code, "OPTION_NOT_CHOSEN");
  const bad = run([{ recipeId: "RCP-ALOO-GOSHT", servings: 4, optionChoices: { "OPT-MEAT": "CH-LAMB" } }]);
  assert.equal(bad.problems[0].code, "INVALID_OPTION_CHOICE");
});

test("pantry exclusions: only pantry items can be left out", () => {
  const r = byCanon(run([{ recipeId: "RCP-000007", servings: 4, pantryExclusions: ["ING-SALT"] }]));
  assert.ok(!r["ASB-CANON-SALT"]);
  const bad = run([{ recipeId: "RCP-000007", servings: 4, pantryExclusions: ["ING-GINGER"] }]);
  assert.equal(bad.ok, false);
  assert.equal(bad.problems[0].code, "NOT_A_PANTRY_ITEM");
});

test("edible-weight lines are converted to purchase weight with the verified yield", () => {
  const rec = recipes();
  rec["RCP-000007"].ingredients = [line("RIN-2", "ING-ONION", "270.0", { quantityBasis: "Edible" })];
  const o = byCanon(run([{ recipeId: "RCP-000007", servings: 4 }], { recipes: rec }))["ASB-CANON-ONION"];
  assert.equal(o.qty, 300); // 270 / 0.90
});

test("fail closed: unverified recipe, line, unit, scaling profile or pack profile -> no lines at all", () => {
  const cases = [
    ["RECIPE_NOT_VERIFIED", (r) => { r["RCP-000007"].verificationStatus = "Needs Review"; }],
    ["RECIPE_NOT_VERIFIED", (r) => { r["RCP-000007"].active = false; }],
    ["INGREDIENT_LINE_NOT_VERIFIED", (r) => { r["RCP-000007"].ingredients[0].verificationStatus = "Needs Review"; }],
    ["UNIT_NOT_VERIFIED", (r) => { r["RCP-000007"].ingredients[0].unit = { ...GRAM, verificationStatus: "Draft" }; }],
    ["SCALING_PROFILE_NOT_VERIFIED", (r) => { r["RCP-000007"].ingredients[0].scaling = POWER; }],
    ["SCALING_METHOD_NOT_ALLOWED", (r) => { r["RCP-000007"].ingredients[0].scaling = { ...POWER, verificationStatus: "Verified" }; }],
    ["UNKNOWN_QUANTITY_BASIS", (r) => { r["RCP-000007"].ingredients[0].quantityBasis = "approx"; }],
    ["ZERO_QUANTITY", (r) => { r["RCP-000007"].ingredients[0].baseQuantity = "0"; }],
    ["INVALID_DECIMAL", (r) => { r["RCP-000007"].ingredients[0].baseQuantity = null; }],
  ];
  for (const [code, mutate] of cases) {
    const rec = recipes(); mutate(rec);
    const r = run([{ recipeId: "RCP-000007", servings: 4 }], { recipes: rec });
    assert.equal(r.ok, false, code);
    assert.deepEqual(r.lines, [], code);
    assert.equal(r.problems[0].code, code, JSON.stringify(r.problems));
  }
  const cat = catalog(); cat["ING-GINGER"].packProfile = { ...cat["ING-GINGER"].packProfile, commerceStatus: "Planned" };
  assert.equal(run([{ recipeId: "RCP-000007", servings: 4 }], { catalog: cat }).problems[0].code, "PACK_PROFILE_NOT_APPROVED");
  const cat2 = catalog(); cat2["ING-GINGER"].packs.forEach((p) => { p.live = false; });
  assert.equal(run([{ recipeId: "RCP-000007", servings: 4 }], { catalog: cat2 }).problems[0].code, "NO_VERIFIED_LIVE_PRICE");
  const cat3 = catalog(); delete cat3["ING-SALT"].conversions;
  assert.equal(run([{ recipeId: "RCP-000007", servings: 4 }], { catalog: cat3 }).problems[0].code, "NO_VERIFIED_CONVERSION");
  const cat5 = catalog(); cat5["ING-SALT"].conversions[0].verificationStatus = "Needs Review"; // like IMC-000001 today
  assert.equal(run([{ recipeId: "RCP-000007", servings: 4 }], { catalog: cat5 }).problems[0].code, "NO_VERIFIED_CONVERSION");
  const cat4 = catalog(); delete cat4["ING-GINGER"];
  assert.equal(run([{ recipeId: "RCP-000007", servings: 4 }], { catalog: cat4 }).problems[0].code, "INGREDIENT_NOT_SELLABLE");
});

test("client input is validated: servings, duplicates, unknown recipes and option groups", () => {
  for (const s of [0, -1, 1.5, 51, "4", null]) {
    assert.equal(run([{ recipeId: "RCP-000007", servings: s }]).problems[0].code, "INVALID_SERVINGS", String(s));
  }
  assert.equal(run([{ recipeId: "RCP-000007", servings: 4 }, { recipeId: "RCP-000007", servings: 2 }]).problems[0].code, "DUPLICATE_RECIPE");
  assert.equal(run([{ recipeId: "RCP-NOPE", servings: 4 }]).problems[0].code, "UNKNOWN_RECIPE");
  assert.equal(run([{ recipeId: "__proto__", servings: 4 }]).problems[0].code, "UNKNOWN_RECIPE");
  assert.equal(run([{ recipeId: "RCP-000007", servings: 4, optionChoices: { X: "Y" } }]).problems[0].code, "UNKNOWN_OPTION_GROUP");
  assert.equal(run([]).problems[0].code, "NO_RECIPES_SELECTED");
});

test("the line price is the line ceiling, and no line is ever priced at zero", () => {
  const r = run([{ recipeId: "RCP-000007", servings: 4 }, { recipeId: "RCP-000008", servings: 2 }]);
  for (const l of r.lines) {
    assert.equal(l.ceilingLinePaisa, l.quotedLinePaisa);
    assert.ok(l.ceilingLinePaisa > 0 && l.ceilingLinePaisa % 100 === 0);
    assert.ok(Number.isSafeInteger(l.qty) && l.qty > 0);
    assert.ok(l.unit === "g" || l.unit === "piece");
  }
  assert.equal(r.totalPaisa, r.lines.reduce((s, l) => s + l.ceilingLinePaisa, 0));
});

test("policy must be explicit", () => {
  assert.throws(() => validatePolicy(null), /NO_POLICY/);
  assert.throws(() => validatePolicy({ ...POLICY, allowedScalingMethods: ["power curve"] }), /INVALID_POLICY/);
  assert.equal(run([{ recipeId: "RCP-000007", servings: 4 }], { policy: { ...POLICY, maxServings: 0 } }).ok, false);
});

test("1 medium onion (piece) becomes grams through a verified conversion (IMC shape: 1 pc = 130 g)", () => {
  const rec = recipes();
  rec["RCP-000007"].ingredients = [line("RIN-9", "ING-ONION", "2", { unit: PIECE_U })];
  const cat = catalog();
  cat["ING-ONION"].conversions = [{ sourceUnitId: "UNT-000005", sourceQuantity: "1.0", canonicalQuantity: "130.0",
    active: true, verificationStatus: "Verified" }];
  const o = byCanon(run([{ recipeId: "RCP-000007", servings: 6 }], { recipes: rec, catalog: cat }))["ASB-CANON-ONION"];
  assert.equal(o.qty, 390); // 2 x 6/4 = 3 onions x 130 g
});

test("qtyLabel", () => {
  assert.equal(qtyLabel("g", 40), "40 g");
  assert.equal(qtyLabel("g", 1000), "1 kg");
  assert.equal(qtyLabel("g", 1250), "1.25 kg");
  assert.equal(qtyLabel("piece", 1), "1 adad");
});
