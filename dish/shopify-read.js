// ============================================================================
// ASB PIPELINE — dish/shopify-read.js
// READ-ONLY loader for Dish-to-Cart: every query here is a `query`, never a
// mutation (a test asserts it). The GraphQL transport is injected, so the
// same code runs against the Admin API (SHOPIFY_ADMIN_TOKEN with
// read_products + read_metaobjects) and against fixtures in tests.
// ============================================================================
"use strict";

const METAOBJECT_TYPES = Object.freeze({
  recipeNodes: "asb_recipe",
  lineNodes: "asb_recipe_ingredient",
  unitNodes: "asb_unit_definition",
  scalingNodes: "asb_scaling_profile",
  groupNodes: "asb_recipe_option_group",
  choiceNodes: "asb_recipe_option_choice",
  conceptNodes: "asb_ingredient_concept",
  conversionNodes: "asb_ingredient_measurement_conversion",
  packProfileNodes: "asb_pack_intelligence_profile",
});

const METAOBJECTS_QUERY = `query AsbDishMetaobjects($type: String!, $after: String) {
  metaobjects(type: $type, first: 100, after: $after) {
    nodes { id fields { key value } }
    pageInfo { hasNextPage endCursor }
  }
}`;

// Aliases are the names dish/recipe-source.js reads (p.verification.value ...).
const PRODUCTS_QUERY = `query AsbDishProducts($after: String) {
  products(first: 100, after: $after) {
    nodes {
      id title status
      verification: metafield(namespace: "asb_product_master", key: "verification_status") { value }
      dishEnabled: metafield(namespace: "asb_product_master", key: "dish_to_cart_enabled") { value }
      ingredientConcept: metafield(namespace: "asb_product_master", key: "ingredient_concept") { value }
      sellForm: metafield(namespace: "asb_product_master", key: "sell_preparation_form") { value }
      packProfile: metafield(namespace: "asb_product_master", key: "pack_intelligence_profile") { value }
      packQuantity: metafield(namespace: "asb_product_master", key: "pack_quantity") { value }
      packUnit: metafield(namespace: "asb_product_master", key: "pack_unit") { value }
      variants(first: 100) { nodes { id title price } pageInfo { hasNextPage } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;

const MAX_PAGES = 50; // 5,000 rows per type: far above today's 395 ingredient lines

async function paginate(graphql, query, variables, pick) {
  const out = [];
  let after = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const data = await graphql(query, { ...variables, after });
    const conn = pick(data);
    if (!conn || !Array.isArray(conn.nodes)) throw new Error("DISH_READ: unexpected response shape");
    out.push(...conn.nodes);
    if (!conn.pageInfo?.hasNextPage) return out;
    after = conn.pageInfo.endCursor;
  }
  throw new Error("DISH_READ: more than " + MAX_PAGES + " pages; refusing a partial read");
}

/** Everything recipe-source needs, read in full or not at all. */
async function loadDishSources(graphql) {
  const src = {};
  for (const [name, type] of Object.entries(METAOBJECT_TYPES)) {
    src[name] = await paginate(graphql, METAOBJECTS_QUERY, { type }, (d) => d.metaobjects);
  }
  src.productNodes = await paginate(graphql, PRODUCTS_QUERY, {}, (d) => d.products);
  for (const p of src.productNodes) {
    if (p.variants?.pageInfo?.hasNextPage) throw new Error(`DISH_READ: ${p.title} has over 100 variants; refusing a partial read`);
  }
  return src;
}

module.exports = { loadDishSources, METAOBJECTS_QUERY, PRODUCTS_QUERY, METAOBJECT_TYPES };
