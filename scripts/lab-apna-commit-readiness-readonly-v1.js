#!/usr/bin/env node
// Verify Shopify Admin 2026-10 full financial read-back field availability
// on the already verified synthetic LAB order #1002. READ ONLY, NO COMMIT.
// This checks the pre-commit original Rs45 order; do not treat as approval.
"use strict";
const {createDevCredentialsShopifyClient}=
  require("../checkout/dev-shopify-credentials-v1");
const {parseMoneyAsPaisa}=require("../checkout/ordercreate-v1");
const {verifyOrder,SHOP,ORDER,CYCLE}=
  require("../checkout/lab-apna-signed-amendment-pg-v1");
function insist(x,code){if(!x)throw Error(code);}
function p(set){
  insist(set?.shopMoney?.currencyCode==="PKR",
    "LAB_COMMIT_READBACK_MONEY_CURRENCY_MISMATCH");
  return parseMoneyAsPaisa(set.shopMoney.amount);
}
async function main(){
  insist(process.env.ASB_LAB_COMMIT_READONLY==="VERIFY_FULL_ORDER_FIELDS"&&
    process.env.ASB_LAB_SHOP_DOMAIN===SHOP&&
    process.env.ASB_ENV==="development"&&
    process.env.ASB_LAB_WRITE_MODE==="disabled"&&
    process.env.ASB_LAB_REAL_COMMIT!=="REVIEWED_ONE_SHOT_ONLY"&&
    process.env.ASB_LAB_APNA_ONE_SHOT==="disabled"&&
    process.env.ASB_LAB_APNA_EDIT_PREVIEW==="disabled"&&
    process.env.ASB_LAB_MIGRATE_ONCE==="disabled",
    "LAB_COMMIT_READBACK_UNSAFE_ENV");
  const client=createDevCredentialsShopifyClient({
    shopDomain:SHOP,devDomainAllowlist:[SHOP],
    clientId:process.env.ASB_LAB_APP_CLIENT_ID,
    clientSecret:process.env.ASB_LAB_APP_CLIENT_SECRET
  });
  const grants=await client.readGrantedScopesForLab();
  insist(grants.ready&&grants.shopDomain===SHOP,
    "LAB_COMMIT_READBACK_SCOPES_NOT_GRANTED");
  const order=await client.readLabOrderForCommitReconcile({orderGid:ORDER});
  verifyOrder(order);
  insist(order.edited===false&&
    p(order.currentSubtotalPriceSet)===4500&&
    p(order.currentTotalPriceSet)===4500&&
    p(order.totalOutstandingSet)===4500&&
    p(order.currentTotalTaxSet)===0&&
    p(order.currentTotalDiscountsSet)===0&&
    p(order.currentShippingPriceSet)===0&&
    p(order.totalReceivedSet)===0&&
    order.tags.includes("ASB-CYCLE-"+CYCLE),
    "LAB_COMMIT_READBACK_PRECOMMIT_STATE_DRIFT");
  console.log("[lab-commit-readiness] GRAPHQL_2026_10_FINANCIAL_FIELDS_VERIFIED");
  console.log("[lab-commit-readiness] TEST_ORDER="+ORDER+
    " ORIGINAL_COD_PKR=45.00 EDITED=false"+
    " SHIPPING=0 TAX=0 DISCOUNT=0 PAID=0");
  console.log("[lab-commit-readiness] READ_ONLY=true COMMIT_CALLS=0 BILL_SENDS=0");
}
if(require.main===module)main().catch(err=>{
  const code=String(err?.code||err?.message||"LAB_READBACK_FAILURE");
  console.error("[lab-commit-readiness] BLOCKED reason="+
    (/^[A-Z0-9_]{3,100}$/.test(code)?code:"LAB_COMMIT_READBACK_UNCLASSIFIED"));
  process.exitCode=2;
});
module.exports={main};
