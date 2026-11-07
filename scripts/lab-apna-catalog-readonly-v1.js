#!/usr/bin/env node
// ASB Checkout Lab — server-to-server Shopify CATALOG READ-ONLY audit.
// NO test orders, no product status changes, no founder approvals, no DB writes.
"use strict";
const {guardedTarget}=require("./lab-readiness-v1");
const {createDevCredentialsShopifyClient}=
  require("../checkout/dev-shopify-credentials-v1");
const {parseShopifyPack}=require("../checkout/apna-shopify-pack-bindings-v1");
const SHOP="asb-checkout-lab.myshopify.com";
const PRODUCT_IDS=[
  "gid://shopify/Product/15548928753698",
  "gid://shopify/Product/15548929015842",
  "gid://shopify/Product/15548929277986"
];
async function runCatalogAudit({client}={}){
  const shop=await client.checkShop();
  if(shop.shopDomain!==SHOP||shop.currency!=="PKR"||
     shop.timeZone!=="Asia/Karachi")throw Error("LAB_WRONG_SHOP");
  const products=await client.readProductsForPolicy({productGids:PRODUCT_IDS});
  if(products.length!==3||products.some((p,i)=>p.id!==PRODUCT_IDS[i]))
    throw Error("LAB_CATALOG_NOT_EXACT");
  const report=[];
  for(const p of products){
    if(!["DRAFT","ACTIVE","ARCHIVED"].includes(p.status)||
       p.variants.pageInfo.hasNextPage||p.variants.nodes.length!==2)
      throw Error("LAB_CATALOG_STATUS_OR_PAGINATION_UNSAFE");
    const sizes=[];
    for(const v of p.variants.nodes){
      const parsed=parseShopifyPack(v.title,p.title);
      if(!parsed||typeof v.sku!=="string"||!v.sku.startsWith("ASB-LAB-"))
        throw Error("LAB_CATALOG_PACK_OR_SKU_AMBIGUOUS");
      sizes.push(parsed.qty+(parsed.unit==="g"?"g":"piece"));
    }
    report.push({name:p.title,status:p.status,
      variantCount:p.variants.nodes.length,packs:sizes,
      eligibleForFounderApprovedActivation:p.status==="ACTIVE"});
  }
  const status=report.every(r=>r.eligibleForFounderApprovedActivation)?
    "ELIGIBLE_FOR_FURTHER_REVIEW_ONLY":"BLOCKED_DRAFT_OR_INACTIVE_PRODUCTS";
  return {shop:SHOP,status,products:report,shopifyOrdersCreated:0,
    policyReleasesActivated:0};
}
async function main(){
  // Guard server, database target, environment and exact shop BEFORE OAuth.
  guardedTarget();
  const client=createDevCredentialsShopifyClient({
    shopDomain:SHOP,devDomainAllowlist:[SHOP],
    clientId:process.env.ASB_LAB_APP_CLIENT_ID,
    clientSecret:process.env.ASB_LAB_APP_CLIENT_SECRET
  });
  const audit=await runCatalogAudit({client});
  console.log("[lab-catalog] "+JSON.stringify(audit));
  console.log("[lab-catalog] READ_ONLY_COMPLETE; ORDERS=0; POLICY_ACTIVATIONS=0");
}
if(require.main===module)main().catch(err=>{
  // Provider errors may carry secrets; log only our controlled error CODE.
  const raw=String(err?.code||err?.message||"AUDIT_FAILED");
  console.error("[lab-catalog] BLOCKED "+(/^[A-Z_]{4,60}$/.test(raw)?raw:"AUDIT_FAILED"));
  process.exitCode=4;
});
module.exports={runCatalogAudit};
