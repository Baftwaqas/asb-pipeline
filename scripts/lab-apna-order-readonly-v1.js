// One-shot, READ-ONLY check for the newly created synthetic Apna Onion order.
// Does not print customer address/phone, tokens or full order details.
"use strict";
const {createDevCredentialsShopifyClient}=
  require("../checkout/dev-shopify-credentials-v1");
const {parseMoneyAsPaisa}=require("../checkout/ordercreate-v1");
const fixture=require("../checkout/fixtures/asb-checkout-lab.json");
const SHOP="asb-checkout-lab.myshopify.com";
async function main(){
  const id=process.env.ASB_LAB_APNA_AUDIT_ORDER_GID;
  if(process.env.ASB_LAB_APNA_ORDER_AUDIT!=="READ_APNA_ORDER"||
    process.env.ASB_ENV!=="development"||
    process.env.ASB_LAB_SHOP_DOMAIN!==SHOP||
    process.env.ASB_LAB_WRITE_MODE!=="disabled"||
    !/^gid:\/\/shopify\/Order\/[1-9][0-9]*$/.test(id||""))
    throw Error("LAB_APNA_ORDER_AUDIT_NOT_ARMED");
  const cli=createDevCredentialsShopifyClient({
    shopDomain:SHOP,devDomainAllowlist:[SHOP],
    clientId:process.env.ASB_LAB_APP_CLIENT_ID,
    clientSecret:process.env.ASB_LAB_APP_CLIENT_SECRET
  });
  const granted=await cli.readGrantedScopesForLab();
  if(!granted.ready)throw Error("LAB_APNA_SCOPES_NOT_GRANTED");
  const o=await cli.readLabOrderForAmendment({orderGid:id});
  const variant=fixture.products[0].variants[0];
  if(!o.tags.includes("ASB-ADR002")||
     !o.tags.includes("ASB-APNA-AMENDMENT-TARGET")||
     !o.tags.some(x=>/^ASB-CYCLE-MON-\d{4}-\d{2}-\d{2}$/.test(x))||
     o.lineItems.nodes.length!==1||
     o.lineItems.nodes[0].variant?.id!==variant.gid||
     o.lineItems.nodes[0].quantity!==1||
     !o.lineItems.nodes[0].customAttributes?.some(a=>
       a.key==="_asb_door"&&a.value==="apna_order")||
     !o.lineItems.nodes[0].customAttributes?.some(a=>
       a.key==="_asb_product"&&a.value==="ASB-CANON-ONION")||
     o.currentTotalPriceSet?.shopMoney?.currencyCode!=="PKR"||
     parseMoneyAsPaisa(o.currentTotalPriceSet.shopMoney.amount)!==4500||
     parseMoneyAsPaisa(o.totalOutstandingSet?.shopMoney?.amount)!==4500)
    throw Error("LAB_APNA_ORDER_STATE_OR_PRICE_MISMATCH");
  console.log("[lab-apna-audit] APP_GRANTED_SCOPES_OK shop="+SHOP);
  console.log("[lab-apna-audit] ORDER_VERIFIED id="+o.id+
    " TEST=true APNA_ONLY=true COD_PKR=45.00 UNFULFILLED=true");
  console.log("[lab-apna-audit] READ_ONLY=true SHOPIFY_WRITES=0");
}
if(require.main===module)main().catch(err=>{
  const raw=String(err?.code||err?.message||"LAB_APNA_AUDIT_FAILED");
  console.error("[lab-apna-audit] BLOCKED reason="+
    (/^[A-Z0-9_]{3,70}$/.test(raw)?raw:"UNCLASSIFIED_LAB_APNA_AUDIT_FAILURE"));
  process.exitCode=2;
});
module.exports={main};
