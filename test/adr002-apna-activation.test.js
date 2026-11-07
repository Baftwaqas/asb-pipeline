// 025: manual independent review -> activation -> fail-closed suspension.
// SCRATCH POSTGRES ONLY. No Shopify network, real staff IDs or production writes.
"use strict";
const {test,before,after}=require("node:test");
const assert=require("node:assert/strict");
const path=require("node:path");
const crypto=require("node:crypto");
const {Pool}=require("pg");
const H=require("./support/harness");
const {canonical}=require("../checkout/quote-crypto-v1");
const {createPgApnaPolicyStager}=require("../checkout/apna-policy-pg-v1");
const {createApnaActivationService,validateDate,digestOfBindings}=
  require("../checkout/apna-policy-activation-v1");

const SHOP="asb-checkout-lab.myshopify.com";
const KEY="FAKE_ONLY_APNA_REVIEW_SIGNING_KEY_DO_NOT_USE_0123456789";
const ID="gid://shopify/Product/15548929015842";
const V1="gid://shopify/ProductVariant/69644382797858";
const V2="gid://shopify/ProductVariant/69644382830626";
const GOODS=()=>[{
  id:ID,title:"ASB LAB Ginger 125g/250g",status:"ACTIVE",
  variants:{nodes:[
    {id:V1,title:"125 g",sku:"LAB-125",price:"35.00"},
    {id:V2,title:"250 g",sku:"LAB-250",price:"70.00"}
  ],pageInfo:{hasNextPage:false}}
}];
let pool,release,reviewed,activation,effective;
const roleIds={
  reviewer:"102",activator:"103",suspender:"104",
  signer:"101",anonymous:null
};
const trusted=async({authContext,requiredRole,shopDomain})=>{
  const id=roleIds[authContext];
  if(!id)return null;
  const required={
    apna_policy_reviewer:"reviewer",
    apna_policy_activator:"activator",
    apna_policy_suspender:"suspender"
  }[requiredRole];
  // Only an allowlisted online Shopify staff app session would reach
  // this boundary in an actual server. Synthetic permission in tests.
  if(authContext!==required&&authContext!=="signer")return null;
  return {source:"shopify_online_staff_session",role:requiredRole,
    staffId:id,shopDomain};
};
function nextDeliveryAfter(days){
  const d=new Date(Date.now()+days*86400000);
  d.setUTCHours(0,0,0,0);
  for(let i=0;i<8;i++){
    if([1,4].includes(d.getUTCDay()))return d.toISOString().slice(0,10);
    d.setUTCDate(d.getUTCDate()+1);
  }
  throw Error("NO_DELIVERY");
}
function makeEnvelope(){
  const ts=new Date(Date.now()-60000);
  const payload={
    schemaVersion:"ASB_APNA_POLICY_RELEASE_V1",
    deploymentState:"FOUNDER_SIGNED_REQUIRES_INDEPENDENT_IMPORT",
    shop:SHOP,issuedAt:ts.toISOString(),
    expiresAt:new Date(ts.getTime()+3600000).toISOString(),
    authorizedBy:"101",
    policies:[{canonicalProductId:"ASB-CANON-GINGER",unit:"g",
      minQuantity:125,maxQuantity:500,allowedSizes:[125,250],
      revision:1,approvedBy:"101",
      approvedAt:new Date(ts.getTime()-3600000).toISOString()}],
    mappings:[{productGid:ID,canonicalProductId:"ASB-CANON-GINGER"}]
  };
  return {payload,signature:"sha256:"+crypto.createHmac("sha256",KEY)
    .update(canonical(payload),"utf8").digest("hex")};
}
function service(over={}){
  return createApnaActivationService({
    pool,shopDomain:SHOP,devDomainAllowlist:[SHOP],
    signingKey:KEY,resolveOnlineStaff:trusted,
    fetchVerifiedShopifyProducts:async()=>GOODS(),
    ...over
  });
}
const readState=async()=>(await pool.query(
  "SELECT state,activated_at,activated_by,effective_delivery_date "+
  "FROM checkout_apna_policy_releases WHERE release_id=$1",
  [release])).rows[0];

before(async()=>{
  const url=await H.createDatabase("asb_test_apna_activation_025",
    path.join(__dirname,".."),{grocery:false});
  pool=new Pool({connectionString:url,max:6});
  const envelope=makeEnvelope();
  const stager=createPgApnaPolicyStager({
    pool,shopDomain:SHOP,devDomainAllowlist:[SHOP],
    signingKey:KEY,now:()=>new Date(),
    fetchVerifiedShopifyProducts:async()=>GOODS()
  });
  const x=await stager.stageSignedRelease({envelope,operatorStaffId:"105"});
  release=x.releaseId;
  effective=nextDeliveryAfter(5);
});
after(async()=>{if(pool)await pool.end();});

test("A0: date can only be future Monday/Thursday with 48-hour lead",()=>{
  assert.throws(()=>validateDate("2026-11-10",new Date("2026-11-07T00:00:00Z")),
    /APNA_EFFECTIVE_MUST_BE_MON_OR_THU/);
  assert.throws(()=>validateDate("2026-11-09",new Date("2026-11-08T16:00:00Z")),
    /APNA_EFFECTIVE_DATE_TOO_SOON/);
  assert.equal(validateDate("2026-11-12",new Date("2026-11-07T00:00:00Z")),"2026-11-12");
});
test("A1: signed candidate is staged, never silently active",async()=>{
  const p=await readState();
  assert.equal(p.state,"staged");
  assert.equal(p.activated_at,null);
  assert.equal((await pool.query("SELECT count(*)::int n FROM checkout_apna_activation_reviews")).rows[0].n,0);
});
test("A1: missing or spoofed staff and self-review all rejected",async()=>{
  const req={releaseId:release,effectiveDeliveryDate:effective,
    reason:"Independent sample catalogue and pack audit complete"};
  await assert.rejects(()=>service().review({...req,authContext:"anonymous"}),
    /APNA_STAFF_SESSION_AND_ROLE_REQUIRED/);
  await assert.rejects(()=>service().review({...req,authContext:"activator"}),
    /APNA_STAFF_SESSION_AND_ROLE_REQUIRED/);
  // Deliberately inject a trusted ID of the founder/signer into reviewer role.
  const pretendFounder=service({
    resolveOnlineStaff:async()=>({
      source:"shopify_online_staff_session",role:"apna_policy_reviewer",
      staffId:"101",shopDomain:SHOP
    })
  });
  await assert.rejects(()=>pretendFounder.review({...req,authContext:"any"}),
    /APNA_REVIEWER_NOT_INDEPENDENT/);
});
test("A1: DRAFT product, changed SKU or missing pack cannot pass independent review",async()=>{
  const req={releaseId:release,authContext:"reviewer",
    effectiveDeliveryDate:effective,
    reason:"Independent Shopify catalogue reviewed with all variants"};
  await assert.rejects(()=>service({
    fetchVerifiedShopifyProducts:async()=>GOODS().map(p=>({...p,status:"DRAFT"}))
  }).review(req),/APNA_INCOMPLETE_OR_INACTIVE_SHOPIFY_PRODUCT/);
  await assert.rejects(()=>service({
    fetchVerifiedShopifyProducts:async()=>{
      const p=GOODS()[0];p.variants.nodes[0].sku="SKU-CHANGED";return [p];
    }
  }).review(req),/APNA_CATALOG_DRIFT_REQUIRES_NEW_RELEASE/);
  await assert.rejects(()=>service({
    fetchVerifiedShopifyProducts:async()=>{
      const p=GOODS()[0];p.variants.nodes.splice(1,1);return [p];
    }
  }).review(req),/APNA_APPROVED_PACK_MISSING_CURRENT_SHOPIFY_VARIANT/);
});
test("A2: independent reviewer records immutable decision, with no activation",async()=>{
  reviewed=await service().review({
    releaseId:release,authContext:"reviewer",
    effectiveDeliveryDate:effective,
    reason:"Current Shopify variants and canonical Apna unit limits verified for staging"
  });
  assert.equal(reviewed.state,"reviewed_not_active");
  assert.equal(reviewed.releaseId,release);
  assert.equal(reviewed.reviewerStaffId,"102");
  assert.match(reviewed.bindingsDigest,/^[a-f0-9]{64}$/);
  const p=await readState();
  assert.equal(p.state,"staged");
  const record=(await pool.query(
    "SELECT state,source_approver_id,reviewer_staff_id,effective_delivery_date "+
    "FROM checkout_apna_activation_reviews")).rows[0];
  assert.equal(record.state,"approved");
  assert.equal(record.source_approver_id,"101");
  assert.equal(record.reviewer_staff_id,"102");
  assert.equal(record.effective_delivery_date.toISOString().slice(0,10),effective);
  const audit=(await pool.query(
    "SELECT action FROM checkout_apna_release_audit ORDER BY id")).rows.map(x=>x.action);
  assert.deepEqual(audit,["SIGNED_CANDIDATE_STAGED","INDEPENDENT_REVIEW_APPROVED"]);
});
test("A2: signer/reviewer ID, effective day and catalog digest cannot be edited after review",async()=>{
  await assert.rejects(()=>pool.query(
    "UPDATE checkout_apna_activation_reviews SET reviewer_staff_id='999' WHERE release_id=$1",
    [release]),/APNA_REVIEW_IMMUTABLE/);
  await assert.rejects(()=>pool.query(
    "UPDATE checkout_apna_activation_reviews SET bindings_sha256=$2 WHERE release_id=$1",
    [release,"b".repeat(64)]),/APNA_REVIEW_IMMUTABLE/);
  const row=(await pool.query(
    "SELECT reviewer_staff_id,bindings_sha256 FROM checkout_apna_activation_reviews WHERE release_id=$1",
    [release])).rows[0];
  assert.equal(row.reviewer_staff_id,"102");
  assert.equal(row.bindings_sha256,reviewed.bindingsDigest);
});
test("A2: replay review cannot bypass a unique independent approval",async()=>{
  await assert.rejects(()=>service().review({
    releaseId:release,authContext:"reviewer",effectiveDeliveryDate:effective,
    reason:"Repeating the exact independent reviewed decision"
  }),/APNA_ALREADY_REVIEWED/);
});
test("A3: activate refuses missing review digest, signer, unapproved replacement and catalog drift",async()=>{
  await assert.rejects(()=>service().activate({
    releaseId:release,authContext:"activator"
  }),/APNA_ACTIVATION_APPROVED_DIGEST_REQUIRED/);
  const noIndependent=service({
    resolveOnlineStaff:async()=>({
      source:"shopify_online_staff_session",role:"apna_policy_activator",
      staffId:"101",shopDomain:SHOP
    })
  });
  await assert.rejects(()=>noIndependent.activate({
    releaseId:release,authContext:"any",
    reviewedBindingsDigest:reviewed.bindingsDigest
  }),/APNA_ACTIVATOR_NOT_INDEPENDENT/);
  await assert.rejects(()=>service().activate({
    releaseId:release,authContext:"activator",
    reviewedBindingsDigest:"a".repeat(64)
  }),/APNA_ACTIVATION_CATALOG_DIGEST_MISMATCH/);
});
test("A4: activation requires review, commits one active and exact effective date",async()=>{
  activation=await service().activate({
    releaseId:release,authContext:"activator",
    reviewedBindingsDigest:reviewed.bindingsDigest,
    replaceActiveReleaseId:null
  });
  assert.equal(activation.state,"active");
  assert.equal(activation.effectiveDeliveryDate,effective);
  const p=await readState();
  assert.equal(p.state,"active");
  assert.equal(p.activated_by,"103");
  assert.equal(p.effective_delivery_date.toISOString().slice(0,10),effective);
  assert.equal((await pool.query(
    "SELECT count(*)::int n FROM checkout_apna_policy_releases WHERE state='active'")).rows[0].n,1);
  const review=(await pool.query(
    "SELECT state,consumed_at FROM checkout_apna_activation_reviews")).rows[0];
  assert.equal(review.state,"consumed");
  assert.ok(review.consumed_at);
});
test("A5: replay activation cannot create a second activation or audit event",async()=>{
  await assert.rejects(()=>service().activate({
    releaseId:release,authContext:"activator",
    reviewedBindingsDigest:reviewed.bindingsDigest,
    replaceActiveReleaseId:null
  }),/APNA_RELEASE_NOT_STAGED/);
  const a=(await pool.query(
    "SELECT action FROM checkout_apna_release_audit WHERE action='ACTIVATED'")).rows;
  assert.equal(a.length,1);
});
test("A5: audit cannot be deleted or rewritten in PostgreSQL",async()=>{
  await assert.rejects(()=>pool.query(
    "UPDATE checkout_apna_release_audit SET actor_id='999' WHERE id=(SELECT min(id) FROM checkout_apna_release_audit)"
  ),/APNA_AUDIT_APPEND_ONLY/);
  await assert.rejects(()=>pool.query(
    "DELETE FROM checkout_apna_activation_reviews WHERE release_id=$1",[release]
  ),/APNA_REVIEW_DELETE_FORBIDDEN/);
});
test("A6: emergency suspension requires exact active release and verified independent staff",async()=>{
  await assert.rejects(()=>service().emergencySuspend({
    expectedActiveReleaseId:"apna-signed-"+"b".repeat(24),
    authContext:"suspender",reason:"Security operator emergency policy suspension confirmed"
  }),/APNA_ACTIVE_RELEASE_CHANGED/);
  await assert.rejects(()=>service().emergencySuspend({
    expectedActiveReleaseId:release,authContext:"signer",
    reason:"Signer tries to independently suspend policy with fake role"
  }),/APNA_SUSPENDER_NOT_INDEPENDENT/);
  const stopped=await service().emergencySuspend({
    expectedActiveReleaseId:release,authContext:"suspender",
    reason:"Synthetic emergency drill; fail-closed checkout and require new founder approval"
  });
  assert.equal(stopped.state,"revoked_no_fallback");
  assert.equal((await readState()).state,"revoked");
  assert.equal((await pool.query(
    "SELECT count(*)::int n FROM checkout_apna_policy_releases WHERE state='active'")).rows[0].n,0);
  assert.equal((await pool.query(
    "SELECT count(*)::int n FROM checkout_apna_release_audit WHERE action='REVOKED'")).rows[0].n,1);
});
test("A6: after suspension, no auto-reactivation or second suspension",async()=>{
  await assert.rejects(()=>service().emergencySuspend({
    expectedActiveReleaseId:release,authContext:"suspender",
    reason:"Repeated emergency suspension cannot silently revive old policy"
  }),/APNA_ACTIVE_RELEASE_CHANGED/);
  assert.equal((await readState()).state,"revoked");
});
