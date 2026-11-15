"use strict";
// Founder policy checkpoint: Apna Onion 500g minimum, 2000g household-cycle cap.
// No Shopify orders, DB writes, signed activation or live policy changes.
const test=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const {canonical}=require("../checkout/quote-crypto-v1");
const {verifyApprovedApnaRelease,validateApnaQuoteAgainstRelease}
  =require("../checkout/apna-approved-policy-v1");

const SHOP="asb-checkout-lab.myshopify.com";
const SECRET="ASB_LAB_ONION_REGRESSION_SIGNING_KEY_0123456789";
const ONION="ASB-CANON-ONION", PRODUCT="gid://shopify/Product/110012";
const HALF="gid://shopify/ProductVariant/99002";
const KILO="gid://shopify/ProductVariant/99003";
const CYCLE="MON-2026-11-09";
const HOUSEHOLD="LAB-ONION-FAMILY-1";
const payload={
  schemaVersion:"ASB_APNA_POLICY_RELEASE_V1",
  deploymentState:"FOUNDER_SIGNED_REQUIRES_INDEPENDENT_IMPORT",
  shop:SHOP,issuedAt:"2026-11-09T06:00:00.000Z",
  expiresAt:"2026-11-09T07:00:00.000Z",authorizedBy:"42",
  policies:[{canonicalProductId:ONION,unit:"g",minQuantity:500,
    maxQuantity:2000,allowedSizes:[500,1000],revision:2,
    approvedBy:"42",approvedAt:"2026-11-08T06:00:00.000Z"}],
  mappings:[{productGid:PRODUCT,canonicalProductId:ONION}]
};
const envelope={payload,signature:"sha256:"+crypto.createHmac("sha256",SECRET)
  .update(canonical(payload),"utf8").digest("hex")};
const release=verifyApprovedApnaRelease(envelope,{
  expectedShop:SHOP,signingKey:SECRET,now:new Date("2026-11-09T06:05:00.000Z")
});
const variantBindings=[{shopDomain:SHOP,productGid:PRODUCT,variantGid:HALF,
  canonicalProductId:ONION,unit:"g",packQuantity:500,active:true},
  {shopDomain:SHOP,productGid:PRODUCT,variantGid:KILO,
    canonicalProductId:ONION,unit:"g",packQuantity:1000,active:true}];
function line(qty,door="apna_order"){
  return {door,canonicalProductId:ONION,unit:"g",qty,
    shopifyVariantGid:qty===500?HALF:KILO,
    provenance:door==="apna_order"?{kind:"apna_selection"}:{kind:"community_pack"}};
}
function existing(qty,{householdKey=HOUSEHOLD,cycleCode=CYCLE,status="confirmed",door="apna_order"}={}){
  return {...line(qty,door),householdKey,cycleCode,status,orderId:"LAB-PRIOR-ORDER"};
}
function evaluate(incomingLines,existingCycleLines=[],options={}){
  const identity={serverAuthenticated:true,phoneVerified:true,householdKey:HOUSEHOLD};
  return validateApnaQuoteAgainstRelease({
    quote:{customerReference:HOUSEHOLD,cycleCode:CYCLE,
      deliveryDate:"2026-11-09",apnaPolicyVersion:release.policyVersion,
      lines:incomingLines},
    identity,cycleCode:CYCLE,shopDomain:SHOP,release,
    variantBindings,bindingsVerified:true,existingCycleLines,
    historyVerified:true,...options
  });
}
test("Founder Onion release binds only real 500g and 1000g packs, with 2000g cycle cap",()=>{
  assert.deepEqual(release.limitsByProduct[ONION],{
    unit:"g",minQuantity:500,maxQuantity:2000,allowedSizes:[500,1000]});
  assert.equal(evaluate([line(500)]).allowed,true);
  assert.equal(evaluate([line(1000)]).allowed,true);
  assert.equal(evaluate([line(1000),line(1000)]).allowed,true);
  assert.equal(evaluate([line(500),line(500),line(1000)]).allowed,true);
});
test("a 2.5 kg cart is rejected even when split into valid Shopify variants",()=>{
  assert.throws(()=>evaluate([line(1000),line(1000),line(500)]),
    /APNA_APPROVED_LIMIT_VIOLATION/);
});
test("same household-cycle second order cannot exceed 2kg, including pending orders",()=>{
  assert.equal(evaluate([line(1000)],[existing(1000)]).allowed,true);
  assert.throws(()=>evaluate([line(1000)],[existing(1000),existing(500,{status:"pending"})]),
    /APNA_APPROVED_LIMIT_VIOLATION/);
  assert.throws(()=>evaluate([line(500)],[existing(1000),existing(1000,{status:"pending"})]),
    /APNA_APPROVED_LIMIT_VIOLATION/);
});
test("cancelled or different cycle/household reservations do not take the cap",()=>{
  assert.equal(evaluate([line(1000)],[existing(1000,{status:"cancelled"}),existing(1000)]).allowed,true);
  assert.equal(evaluate([line(1000)],[existing(2000,{cycleCode:"THU-2026-11-12"})]).allowed,true);
  assert.equal(evaluate([line(1000)],[existing(2000,{householdKey:"DIFFERENT"})]).allowed,true);
});
test("Community 5kg/10kg and Dish quantities are not evaluated as Apna lines",()=>{
  const community={door:"community_order",canonicalProductId:ONION,unit:"g",qty:5000,
    shopifyVariantGid:"gid://shopify/ProductVariant/99909",
    provenance:{kind:"community_pack"}};
  const dish={door:"dish_to_cart",canonicalProductId:ONION,unit:"g",qty:2500,
    provenance:{kind:"recipe"}};
  assert.equal(evaluate([line(1000),community,dish],[existing(1000)]).allowed,true);
  assert.equal(evaluate([line(1000)],[existing(10000,{door:"community_order"})]).allowed,true);
  // This checks Apna isolation only; other doors require their own verifier.
});
test("a fake 2kg single variant, wrong variant, and omitted history fail closed",()=>{
  assert.throws(()=>evaluate([{...line(1000),qty:2000}]),
    /APNA_QUOTE_VARIANT_PACK_MISMATCH/);
  assert.throws(()=>evaluate([{...line(500),shopifyVariantGid:"gid:\/\/shopify\/ProductVariant\/91919"}]),
    /APNA_VARIANT_MISSING_APPROVED_BINDING/);
  assert.throws(()=>evaluate([line(500)],[],{historyVerified:false}),
    /APNA_AUTHORITATIVE_SOURCES_REQUIRED/);
});
