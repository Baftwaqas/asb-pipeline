// ============================================================================
// ASB PIPELINE — grocery/bill-send-scope.js
//
// Additional fail-closed control for a narrowly authorized production test.
// BOTH the existing bill env/DB activation switches and this scope must permit
// a send. "single" matches the immutable source PK AND Shopify order ID.
// Missing/invalid configuration always denies; "all" requires explicit opt-in.
//
// Scope is checked again INSIDE the row-locked bill claim, not only at the
// worker/sweeper entry point. This blocks manual processBill(), webhook kicks,
// and races involving newly-arriving customer orders.
// ============================================================================

"use strict";

const SOURCE_ENV = "GROCERY_BILL_TARGET_SOURCE_ID";
const SHOPIFY_ENV = "GROCERY_BILL_TARGET_SHOPIFY_ORDER_ID";
const MODE_ENV = "GROCERY_BILL_SEND_SCOPE";

const canonicalId = (value) =>
  typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) &&
  BigInt(value) <= 9223372036854775807n;

/** No mode means OFF, not permission to use the old global send path. */
function config(env = process.env) {
  const mode = env[MODE_ENV] || "off";
  const sourceId = env[SOURCE_ENV] || "";
  const shopifyOrderId = env[SHOPIFY_ENV] || "";

  if (mode === "single" && canonicalId(sourceId) && canonicalId(shopifyOrderId)) {
    return { mode: "single", valid: true, sourceId, shopifyOrderId };
  }
  if (mode === "all" && !sourceId && !shopifyOrderId) {
    return { mode: "all", valid: true, sourceId: null, shopifyOrderId: null };
  }
  if (mode === "off" && !sourceId && !shopifyOrderId) {
    return { mode: "off", valid: false, sourceId: null, shopifyOrderId: null };
  }
  return { mode: "invalid", valid: false, sourceId: null, shopifyOrderId: null };
}

/** Fail closed for missing source, wrong identity or invalid settings. */
function allowsSource(source, env = process.env) {
  const scope = config(env);
  if (!scope.valid || !source) return false;
  if (scope.mode === "all") return true;
  return source.origin === "live" &&
    String(source.id) === scope.sourceId &&
    String(source.shopify_order_id) === scope.shopifyOrderId;
}

module.exports = { config, allowsSource };
