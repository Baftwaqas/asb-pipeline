// Bridge app's OWN granted Shopify scopes, read-only single-shot probe.
// Never print tokens, client credentials, customer information or full responses.
"use strict";
const {createDevCredentialsShopifyClient}=
  require("../checkout/dev-shopify-credentials-v1");
const SHOP="asb-checkout-lab.myshopify.com";
async function main(){
  if(process.env.ASB_LAB_SCOPES_READONLY!=="RUN_SCOPE_CHECK"||
    process.env.ASB_LAB_SHOP_DOMAIN!==SHOP||
    process.env.ASB_ENV!=="development"||
    process.env.ASB_LAB_WRITE_MODE!=="disabled")
    throw Error("LAB_SCOPE_PROBE_NOT_ARMED");
  const client=createDevCredentialsShopifyClient({
    shopDomain:SHOP,devDomainAllowlist:[SHOP],
    clientId:process.env.ASB_LAB_APP_CLIENT_ID,
    clientSecret:process.env.ASB_LAB_APP_CLIENT_SECRET
  });
  const scope=await client.readGrantedScopesForLab();
  console.log("[lab-scopes] SHOP_IDENTITY_OK bridge_credentials_checked=true");
  console.log("[lab-scopes] READ_PRODUCTS="+scope.readProducts+
    " WRITE_ORDERS="+scope.writeOrders+
    " WRITE_ORDER_EDITS="+scope.writeOrderEdits);
  console.log("[lab-scopes] "+(scope.ready?"APP_GRANTED_SCOPES_VERIFIED":"MISSING_REQUIRED_GRANT")+
    " READ_ONLY=true SHOPIFY_WRITES=0");
  if(!scope.ready)process.exitCode=2;
}
if(require.main===module)main().catch(err=>{
  const allowed=new Set([
    "LAB_SCOPE_PROBE_NOT_ARMED","DEV_STORE_NOT_EXPLICITLY_ALLOWLISTED",
    "DEV_APP_CREDENTIALS_REQUIRED","DEV_APP_TOKEN_REQUEST_FAILED",
    "DEV_APP_TOKEN_BAD_RESPONSE","DEV_APP_WRITE_ORDERS_NOT_GRANTED",
    "DEV_SHOP_CHECK_HTTP_FAILED","DEV_SHOP_IDENTITY_OR_SETTINGS_MISMATCH",
    "DEV_SCOPE_AUDIT_HTTP_FAILED","DEV_SCOPE_AUDIT_INVALID_RESPONSE",
    "DEV_SCOPE_AUDIT_GRANT_MISMATCH"
  ]);
  const code=String(err?.code||err?.message||"LAB_SCOPE_PROBE_FAILED");
  console.error("[lab-scopes] BLOCKED reason="+
    (allowed.has(code)?code:"UNCLASSIFIED_SCOPE_PROBE_FAILURE"));
  process.exitCode=2;
});
module.exports={main};
