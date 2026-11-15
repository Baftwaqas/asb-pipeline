"use strict";
const test=require("node:test"),assert=require("node:assert/strict");
const {verifyAmendmentPreflight}=require("../checkout/apna-order-amendment-preflight-v1");
const SHOP="asb-checkout-lab.myshopify.com",H="LAB-AMENDMENT-HOUSEHOLD",C="THU-2026-11-12";
const ORIGINAL={shopDomain:SHOP,householdKey:H,cycleCode:C,orderId:"LAB-ORDER-001",
  shopifyOrderGid:"gid://shopify/Order/123456",redemptionState:"completed",
  fulfillmentState:"confirmed",paymentState:"pending_cod"};
const LINE=(id,qty,price,door="apna_order")=>({lineId:id,door,canonicalProductId:"ASB-CANON-ONION",
  unit:"g",qty,shopifyVariantGid:qty===500?"gid://shopify/ProductVariant/1":"gid://shopify/ProductVariant/2",
  quotedLinePaisa:price,ceilingLinePaisa:price});
const old=LINE("ONION-1",500,4500),add=LINE("ONION-2",1000,9000),
  another=LINE("ONION-3",1000,9000);
const config={
  shopDomain:SHOP,identity:{householdKey:H,serverAuthenticated:true,phoneVerified:true},
  cycle:{code:C,status:"open",cutoffVerifiedByDatabase:true},
  originalOrder:ORIGINAL,originalLines:[old],proposedLines:[old,add],
  existingCycleLines:[{...old,householdKey:H,cycleCode:C,orderId:ORIGINAL.orderId,status:"confirmed"}],
  limitsByProduct:{"ASB-CANON-ONION":{unit:"g",minQuantity:500,maxQuantity:2000,
    allowedSizes:[500,1000]}},
  sourceVerified:true,historyVerified:true,policyVerified:true
};
const check=(o={})=>verifyAmendmentPreflight({...config,...o});
function rejects(code,override){assert.throws(()=>check(override),new RegExp(code));}
test("add a valid 1kg onion to prior 500g without double-counting same order",()=>{
  const x=check();assert.equal(x.state,"preflight_only_not_reserved_not_authorized");
  assert.equal(x.additionalPaisa,9000);assert.equal(x.proposedTotalPaisa,13500);
  assert.equal(x.quantityResults.products[0].totalQuantity,1500);
});
test("2.5kg replacement is rejected including valid separately packed Shopify quantities",()=>{
  rejects("AMENDMENT_APNA_LIMIT_VIOLATION",{proposedLines:[old,add,another]});
});
test("original items cannot be removed, repriced, requantified, or replaced",()=>{
  rejects("AMENDMENT_ORIGINAL_LINES_MUST_REMAIN_UNCHANGED",{proposedLines:[add]});
  rejects("AMENDMENT_ORIGINAL_LINES_MUST_REMAIN_UNCHANGED",
    {proposedLines:[{...old,quotedLinePaisa:4400},add]});
  rejects("AMENDMENT_ORIGINAL_LINES_MUST_REMAIN_UNCHANGED",
    {proposedLines:[{...old,qty:1000},add]});
});
test("different customers and cycles cannot amend another order",()=>{
  rejects("AMENDMENT_ORIGINAL_ORDER_MISMATCH",
    {identity:{...config.identity,householdKey:"ANOTHER"}});
  rejects("AMENDMENT_ORIGINAL_ORDER_MISMATCH",{cycle:{...config.cycle,code:"MON-2026-11-09"}});
});
test("booking cutoff, unknown external history and policy evidence fail closed",()=>{
  rejects("AMENDMENT_CYCLE_CLOSED_OR_UNVERIFIED",{cycle:{...config.cycle,status:"locked"}});
  rejects("AMENDMENT_CYCLE_CLOSED_OR_UNVERIFIED",
    {cycle:{...config.cycle,cutoffVerifiedByDatabase:false}});
  rejects("AMENDMENT_AUTHORITATIVE_EVIDENCE_REQUIRED",{historyVerified:false});
  rejects("AMENDMENT_AUTHORITATIVE_EVIDENCE_REQUIRED",{policyVerified:false});
});
test("paid, fulfilled, uncertain, or uncreated orders cannot be amended",()=>{
  for(const update of [{paymentState:"paid"},{fulfillmentState:"fulfilled"},
    {redemptionState:"needs_reconcile"},{redemptionState:"creating"}]){
    rejects("AMENDMENT_ORIGINAL_NOT_EDITABLE",{originalOrder:{...ORIGINAL,...update}});
  }
});
test("two amendments must not bypass locked household-cycle history",()=>{
  const committedOther={...old,orderId:"LAB-OTHER-ORDER",qty:1000,
    householdKey:H,cycleCode:C,status:"pending"};
  rejects("AMENDMENT_APNA_LIMIT_VIOLATION",
    {existingCycleLines:[...config.existingCycleLines,committedOther]});
});
test("Community/Budget/Dish/Bhao additions require separate feature verifier",()=>{
  for(const door of ["community_order","budget_to_cart","dish_to_cart","bhao_tao"])
    rejects("AMENDMENT_NEW_DOOR_NOT_SUPPORTED",
      {proposedLines:[old,LINE("NEW-OTHER",1000,9000,door)]});
});
test("idempotent or duplicated amendment payload is denied",()=>{
  rejects("AMENDMENT_NO_NEW_LINES",{proposedLines:[old]});
  rejects("AMENDMENT_DUPLICATE_LINE_ID",{proposedLines:[old,old,add]});
});
test("never trusts non-lab destinations or unverifiable identities",()=>{
  rejects("AMENDMENT_LAB_ONLY",{shopDomain:"live-asb.myshopify.com"});
  rejects("AMENDMENT_CUSTOMER_NOT_VERIFIED",
    {identity:{...config.identity,phoneVerified:false}});
});
