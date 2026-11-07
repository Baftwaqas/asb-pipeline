// PostgreSQL 18 synthetic staging tests; NO Shopify network or real staff.
"use strict";
const {test,before,after}=require("node:test");
const assert=require("node:assert/strict");
const path=require("node:path");
const crypto=require("node:crypto");
const {Pool}=require("pg");
const H=require("./support/harness");
const {canonical}=require("../checkout/quote-crypto-v1");
const {verifyApprovedApnaRelease}=require("../checkout/apna-approved-policy-v1");
const {parseShopifyPack,prepareApprovedApnaBindings}=
  require("../checkout/apna-shopify-pack-bindings-v1");
const {createPgApnaPolicyStager,loadActiveApnaPolicyFromPgTransaction}=
  require("../checkout/apna-policy-pg-v1");

const SHOP="asb-checkout-lab.myshopify.com";
const SECRET="ASB_DEV_FOUNDER_SIGNED_POLICY_TEST_KEY_0123456789";
const PRODUCT="gid://shopify/Product/15548929015842";
const variants=[
  {id:"gid://shopify/ProductVariant/69644382797858",title:"125 g",sku:"LAB-GINGER-125"},
  {id:"gid://shopify/ProductVariant/69644382830626",title:"250 g",sku:"LAB-GINGER-250"}
];
let pool,now,envelope;
const product=(options={})=>({
  id:PRODUCT,title:"ASB Lab Ginger",status:"ACTIVE",
  variants:{nodes:variants,pageInfo:{hasNextPage:false}},
  ...options
});
function signed(payload){
  return {payload,signature:"sha256:"+crypto.createHmac("sha256",SECRET)
    .update(canonical(payload),"utf8").digest("hex")};
}
function build(){
  const issued=new Date(now.getTime()-60000).toISOString();
  return signed({
    schemaVersion:"ASB_APNA_POLICY_RELEASE_V1",
    deploymentState:"FOUNDER_SIGNED_REQUIRES_INDEPENDENT_IMPORT",
    shop:SHOP,issuedAt:issued,
    expiresAt:new Date(now.getTime()+3540000).toISOString(),
    authorizedBy:"42",
    policies:[{
      canonicalProductId:"ASB-CANON-GINGER",unit:"g",
      minQuantity:125,maxQuantity:500,allowedSizes:[125,250],
      revision:1,approvedBy:"42",
      approvedAt:new Date(now.getTime()-3600000).toISOString()
    }],
    mappings:[{productGid:PRODUCT,canonicalProductId:"ASB-CANON-GINGER"}]
  });
}
function stager(reader=async()=>[product()]){
  return createPgApnaPolicyStager({
    pool,shopDomain:SHOP,devDomainAllowlist:[SHOP],
    signingKey:SECRET,now:()=>now,fetchVerifiedShopifyProducts:reader
  });
}
before(async()=>{
  const url=await H.createDatabase("asb_test_apna_signed_import",
    path.join(__dirname,".."),{grocery:false});
  pool=new Pool({connectionString:url,max:4});
  now=new Date();envelope=build();
});
after(async()=>{if(pool)await pool.end();});
test("G4: Shopify title parsing agrees with Data Manager gram and piece format",()=>{
  assert.deepEqual(parseShopifyPack("125 g","Ginger"),{unit:"g",qty:125});
  assert.deepEqual(parseShopifyPack("1 kg","Onion"),{unit:"g",qty:1000});
  assert.deepEqual(parseShopifyPack("Default Title","Eggs 1 dozen"),
    {unit:"piece",qty:12});
  assert.equal(parseShopifyPack("125g and 250g","Ginger"),null);
});
test("G4: source must be signed, same shop and verified live Shopify pack coverage",()=>{
  const release=verifyApprovedApnaRelease(envelope,{
    expectedShop:SHOP,signingKey:SECRET,now});
  const expected=prepareApprovedApnaBindings({
    release,shopDomain:SHOP,verifiedProducts:[product()],
    serverCatalogVerified:true});
  assert.equal(expected.bindings.length,2);
  assert.deepEqual(expected.bindings.map(x=>x.packQuantity),[125,250]);
  assert.throws(()=>prepareApprovedApnaBindings({
    release,shopDomain:SHOP,verifiedProducts:[product()],
    serverCatalogVerified:false}),/APNA_SHOPIFY_CATALOG_NOT_VERIFIED/);
  assert.throws(()=>prepareApprovedApnaBindings({
    release,shopDomain:SHOP,
    verifiedProducts:[product({status:"DRAFT"})],serverCatalogVerified:true
  }),/APNA_INCOMPLETE_OR_INACTIVE_SHOPIFY_PRODUCT/);
  assert.throws(()=>prepareApprovedApnaBindings({
    release,shopDomain:SHOP,
    verifiedProducts:[product({variants:{
      nodes:[variants[0]],pageInfo:{hasNextPage:false}}})],
    serverCatalogVerified:true
  }),/APNA_APPROVED_PACK_MISSING_CURRENT_SHOPIFY_VARIANT/);
});
test("G4: signed founder candidate stages atomically, NEVER becomes active",async()=>{
  const created=await stager().stageSignedRelease({
    envelope,operatorStaffId:"63"});
  assert.equal(created.state,"staged");
  assert.equal(created.changed,true);
  assert.equal(created.bindingCount,2);
  const query=await pool.query(
    "SELECT release_id,state,activated_at FROM checkout_apna_policy_releases");
  assert.equal(query.rows.length,1);
  assert.equal(query.rows[0].state,"staged");
  assert.equal(query.rows[0].activated_at,null);
  const audit=await pool.query(
    "SELECT action,evidence_json FROM checkout_apna_release_audit");
  assert.equal(audit.rows.length,1);
  assert.equal(audit.rows[0].action,"SIGNED_CANDIDATE_STAGED");
  assert.equal(audit.rows[0].evidence_json.activationPerformed,false);
  await assert.rejects(()=>loadActiveApnaPolicyFromPgTransaction({
    db:pool,shopDomain:SHOP,deliveryDate:"2026-11-09"
  }),/APNA_NO_ACTIVE_REVIEWED_RELEASE/);
});
test("G4: repeat staging is idempotent, cannot mutate an existing signed snapshot",async()=>{
  const r=await stager().stageSignedRelease({
    envelope,operatorStaffId:"63"});
  assert.equal(r.changed,false);
  assert.equal(r.state,"staged");
  assert.equal((await pool.query("SELECT count(*)::int c FROM checkout_apna_release_audit")).rows[0].c,1);
  const changed=product({variants:{
    nodes:[{...variants[0],sku:"CHANGED-SKU"},variants[1]],
    pageInfo:{hasNextPage:false}}});
  await assert.rejects(()=>stager(async()=>[changed]).stageSignedRelease({
    envelope,operatorStaffId:"63"
  }),/APNA_STAGED_VARIANT_DRIFT_REQUIRES_NEW_RELEASE/);
});
test("G4: invalid signature, spoofed operator and mismatched Shopify source fail before DB write",async()=>{
  const tampered=structuredClone(envelope);
  tampered.payload.policies[0].maxQuantity=999;
  await assert.rejects(()=>stager().stageSignedRelease({
    envelope:tampered,operatorStaffId:"63"}),/POLICY_SIGNATURE_INVALID/);
  await assert.rejects(()=>stager().stageSignedRelease({
    envelope,operatorStaffId:"anonymous"}),/APNA_OPERATOR_ID_REQUIRED/);
  await assert.rejects(()=>stager(async()=>[product({status:"DRAFT"})]).stageSignedRelease({
    envelope,operatorStaffId:"63"
  }),/APNA_INCOMPLETE_OR_INACTIVE_SHOPIFY_PRODUCT/);
  assert.equal((await pool.query("SELECT count(*)::int c FROM checkout_apna_policy_releases")).rows[0].c,1);
});
