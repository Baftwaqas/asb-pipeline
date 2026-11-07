// ADR-002: signed founder policy acceptance and Apna line + cycle caps.
"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const {canonical}=require("../checkout/quote-crypto-v1");
const {
  verifyApprovedApnaRelease,validateApnaQuoteAgainstRelease,
  createReleasedApnaCheckoutVerifier
}=require("../checkout/apna-approved-policy-v1");
const SECRET="ASB_SIGNED_APNA_RELEASE_UNIT_TEST_KEY_0123456789";
const SHOP="asb-checkout-lab.myshopify.com";
const ISSUED="2026-11-07T07:00:00.000Z";
const NOW=new Date("2026-11-07T07:05:00.000Z");
const ONION="ASB-CANON-ONION",GINGER="ASB-CANON-GINGER";
const GINGER_PRODUCT="gid://shopify/Product/110011";
const ONION_PRODUCT="gid://shopify/Product/110012";
const GINGER_VARIANT="gid://shopify/ProductVariant/99001";
const ONION_VARIANT="gid://shopify/ProductVariant/99002";
const policy=(id,min,max,allowed)=>({
  canonicalProductId:id,unit:"g",minQuantity:min,maxQuantity:max,
  allowedSizes:allowed,revision:2,approvedBy:"42",
  approvedAt:"2026-11-06T11:00:00.000Z"
});
function body(){
  return {
    schemaVersion:"ASB_APNA_POLICY_RELEASE_V1",
    deploymentState:"FOUNDER_SIGNED_REQUIRES_INDEPENDENT_IMPORT",
    shop:SHOP,issuedAt:ISSUED,expiresAt:"2026-11-07T08:00:00.000Z",
    authorizedBy:"42",
    policies:[policy(GINGER,125,500,[125,250,500]),
      policy(ONION,500,2000,[500,1000,2000])],
    mappings:[
      {productGid:GINGER_PRODUCT,canonicalProductId:GINGER},
      {productGid:ONION_PRODUCT,canonicalProductId:ONION}
    ]
  };
}
function sign(payload=body(),secret=SECRET){
  return {payload,signature:"sha256:"+crypto.createHmac("sha256",secret)
    .update(canonical(payload),"utf8").digest("hex")};
}
const bind=(productGid,variantGid,canonicalProductId,packQuantity)=>({
  shopDomain:SHOP,productGid,variantGid,canonicalProductId,
  unit:"g",packQuantity,active:true
});
const bindings=[
  bind(GINGER_PRODUCT,GINGER_VARIANT,GINGER,125),
  bind(ONION_PRODUCT,ONION_VARIANT,ONION,500)
];
function line(canonicalProductId,variantId,qty,door="apna_order",options={}){
  return {
    canonicalProductId,shopifyVariantGid:variantId,qty,unit:"g",door,
    provenance:{kind:"apna_selection"},...options
  };
}
const IDENTITY={serverAuthenticated:true,phoneVerified:true,
  householdKey:"LAB-FOUNDER-VERIFIED"};
const CYCLE="MON-2026-11-09";
const q=(lines)=>({
  customerReference:IDENTITY.householdKey,cycleCode:CYCLE,
  currency:"PKR",apnaPolicyVersion:verify().policyVersion,lines
});
function verify(options={}){
  return verifyApprovedApnaRelease(sign(),{
    expectedShop:SHOP,signingKey:SECRET,now:NOW,...options});
}
const evaluate=(lines,opts={})=>validateApnaQuoteAgainstRelease({
  quote:q(lines),identity:IDENTITY,cycleCode:CYCLE,shopDomain:SHOP,
  release:verify(),variantBindings:bindings,
  bindingsVerified:true,existingCycleLines:[],historyVerified:true,...opts
});
test("G1: Data Manager compliant founder release signature is verified and strictly scoped",()=>{
  const release=verify();
  assert.equal(release.shop,SHOP);
  assert.equal(release.authorizedBy,"42");
  assert.deepEqual(release.limitsByProduct[GINGER],{
    unit:"g",minQuantity:125,maxQuantity:500,allowedSizes:[125,250,500]});
  assert.equal(release.mappedCanonicalByProduct.get(GINGER_PRODUCT),GINGER);
  assert.match(release.policyVersion,/^apna-signed-[0-9a-f]{24}$/);
});
test("G1: unsigned candidate and forged founder signature are rejected",()=>{
  const unsigned={payload:body()};
  assert.throws(()=>verifyApprovedApnaRelease(unsigned,{
    expectedShop:SHOP,signingKey:SECRET,now:NOW}),/POLICY_ENVELOPE_INVALID/);
  const e=sign();
  e.payload.policies[0].maxQuantity=999;
  assert.throws(()=>verifyApprovedApnaRelease(e,{
    expectedShop:SHOP,signingKey:SECRET,now:NOW}),/POLICY_SIGNATURE_INVALID/);
});
test("G1: stolen signed release cannot be replayed to production or after expiration",()=>{
  assert.throws(()=>verify({expectedShop:"production.myshopify.com"}),
    /POLICY_CROSS_SHOP_REFUSED/);
  assert.throws(()=>verify({now:new Date("2026-11-07T08:00:00.000Z")}),
    /POLICY_RELEASE_EXPIRED_OR_NOT_YET_VALID/);
  assert.throws(()=>verify({now:new Date("2026-11-07T06:59:00.000Z")}),
    /POLICY_RELEASE_EXPIRED_OR_NOT_YET_VALID/);
});
test("G1: malformed but correctly HMAC-signed approval has no effect",()=>{
  const forged=body();
  forged.policies[0].allowedSizes=[40,125,250];
  assert.throws(()=>verifyApprovedApnaRelease(sign(forged),{
    expectedShop:SHOP,signingKey:SECRET,now:NOW}),/POLICY_INVALID_PACK_LADDER/);
  const a=body();a.policies[0].approvedBy="";
  assert.throws(()=>verifyApprovedApnaRelease(sign(a),{
    expectedShop:SHOP,signingKey:SECRET,now:NOW}),/POLICY_INVALID_QUANTITY_OR_APPROVER/);
  const b=body();b.mappings=[b.mappings[0]];
  assert.throws(()=>verifyApprovedApnaRelease(sign(b),{
    expectedShop:SHOP,signingKey:SECRET,now:NOW}),/POLICY_UNMAPPED_CANONICAL/);
});
test("G2: approved onion 500g and ginger 125g pass independent Apna product minimums",()=>{
  const good=evaluate([line(ONION,ONION_VARIANT,500),
    line(GINGER,GINGER_VARIANT,125)]);
  assert.equal(good.allowed,true);
  assert.equal(good.products.length,2);
});
test("G2: 40g ginger cannot exploit Apna while Dish-to-Cart is untouched by Apna caps",()=>{
  const bad=line(GINGER,GINGER_VARIANT,40);
  assert.throws(()=>evaluate([bad]),/APNA_QUOTE_VARIANT_PACK_MISMATCH/);
  const dish=line(GINGER,GINGER_VARIANT,40,"dish_to_cart",
    {provenance:{kind:"recipe",recipeIds:["TEST-ONLY"]}});
  const good=evaluate([dish]);
  assert.equal(good.allowed,true);
  assert.deepEqual(good.products,[]);
});
test("G2: cross-product variant, missing mapping, and unverified history all fail closed",()=>{
  assert.throws(()=>evaluate([line(GINGER,ONION_VARIANT,500)]),
    /APNA_QUOTE_VARIANT_PACK_MISMATCH/);
  assert.throws(()=>evaluate([line(GINGER,"gid://shopify/ProductVariant/999999",125)]),
    /APNA_VARIANT_MISSING_APPROVED_BINDING/);
  assert.throws(()=>evaluate([line(GINGER,GINGER_VARIANT,125)],{historyVerified:false}),
    /APNA_AUTHORITATIVE_SOURCES_REQUIRED/);
  assert.throws(()=>evaluate([line(GINGER,GINGER_VARIANT,125)],{bindingsVerified:false}),
    /APNA_AUTHORITATIVE_SOURCES_REQUIRED/);
});
test("G2: existing committed Apna reservations consume household cap, irrelevant products do not",()=>{
  const old=(productId,qty,status="needs_reconcile",key=IDENTITY.householdKey)=>({
    canonicalProductId:productId,qty,unit:"g",door:"apna_order",
    householdKey:key,cycleCode:CYCLE,status,orderId:"LEGACY-LAB-ORDER"
  });
  const incoming=[line(GINGER,GINGER_VARIANT,125)];
  assert.equal(evaluate(incoming,{existingCycleLines:[old(GINGER,250)]}).allowed,true);
  assert.throws(()=>evaluate(incoming,{existingCycleLines:[old(GINGER,500)]}),
    /APNA_APPROVED_LIMIT_VIOLATION/);
  assert.equal(evaluate(incoming,{existingCycleLines:[old("LEMON",9000,"unknown")]}).allowed,true);
  assert.equal(evaluate(incoming,{existingCycleLines:[old(GINGER,500,"cancelled")]}).allowed,true);
  assert.throws(()=>evaluate(incoming,{existingCycleLines:[old(GINGER,250,"unknown")]}),
    /UNKNOWN_ORDER_STATUS/);
});
test("G3: transaction-gated callback refuses if any other door or history gate is missing",async()=>{
  const noOp=async()=>[];
  assert.throws(()=>createReleasedApnaCheckoutVerifier({
    loadSignedReleaseInTransaction:async()=>sign(),
    loadVariantBindingsInTransaction:noOp
  }),/APNA_REQUIRED_ADAPTER_MISSING/);
  const ctx={db:{query:async()=>({rows:[]})},quote:q([line(GINGER,GINGER_VARIANT,125)]),
    identity:IDENTITY,shopDomain:SHOP};
  const build=(other,history={authoritative:true,lines:[]})=>
    createReleasedApnaCheckoutVerifier({
      expectedShop:SHOP,signingKey:SECRET,now:()=>NOW,
      loadSignedReleaseInTransaction:async()=>({
        state:"active",envelope:sign(),
        verifiedAt:"2026-11-07T07:05:00.000Z",
        activatedAt:"2026-11-07T07:06:00.000Z",
        activatedBy:"42",effectiveDeliveryDate:"2026-11-09",
        policyVersion:verify().policyVersion
      }),
      loadVariantBindingsInTransaction:async()=>bindings,
      loadExistingCycleLinesInTransaction:async()=>history,
      verifyOtherDoorsInTransaction:async()=>other
    });
  await assert.rejects(()=>build({approved:false,policyVersion:"MIXED"})(ctx),
    /NON_APNA_POLICY_NOT_APPROVED/);
  await assert.rejects(()=>build({approved:true,policyVersion:"MIXED"},
    {authoritative:false,lines:[]})(ctx),/APNA_HISTORY_UNVERIFIED/);
  const accepted=await build({approved:true,policyVersion:"MIXED"})(ctx);
  assert.equal(accepted.approved,true);
  assert.match(accepted.policyVersion,/^apna-signed-[0-9a-f]{24}\+MIXED$/);
});
