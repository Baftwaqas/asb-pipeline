// ASB Apna Policy Activation V1 — independent review, explicit activation,
// emergency fail-closed suspension. DEV STORE ONLY; NO HTTP API.
// Never accept request-supplied staff IDs/role booleans as proof.
// Callers MUST supply real Shopify online staff authorization and server-only
// current catalogue retrieval; these adapters have NO permissive defaults.
"use strict";
const crypto=require("node:crypto");
const {QuoteError,canonical}=require("./quote-crypto-v1");
const {verifyApprovedApnaRelease}=require("./apna-approved-policy-v1");
const {prepareApprovedApnaBindings}=require("./apna-shopify-pack-bindings-v1");

const SHOP="asb-checkout-lab.myshopify.com";
const RELEASE=/^apna-signed-[0-9a-f]{24}$/;
const DIGEST=/^[a-f0-9]{64}$/;
const STAFF=/^[1-9][0-9]{0,19}$/;
const DATE=/^\d{4}-\d{2}-\d{2}$/;
const REVIEW_WINDOW_MS=24*60*60*1000;
const MIN_LEAD_MS=48*60*60*1000;
function insist(x,code){if(!x)throw new QuoteError(code);}
function asTime(t){
  insist(t instanceof Date&&!Number.isNaN(t.valueOf()),"APNA_INVALID_CLOCK");
  return t;
}
function validateDate(date,now){
  insist(typeof date==="string"&&DATE.test(date),"APNA_INVALID_EFFECTIVE_DATE");
  const d=new Date(date+"T00:00:00.000Z");
  insist(Number.isFinite(d.getTime())&&d.toISOString().slice(0,10)===date,
    "APNA_INVALID_EFFECTIVE_DATE");
  insist([1,4].includes(d.getUTCDay()),"APNA_EFFECTIVE_MUST_BE_MON_OR_THU");
  // Karachi does not currently apply DST; local midnight is 19:00 UTC
  // on the preceding civil day. Use >=48h to prevent mid-window activation.
  const karachiStart=d.getTime()-5*60*60*1000;
  insist(karachiStart-now.getTime()>=MIN_LEAD_MS,
    "APNA_EFFECTIVE_DATE_TOO_SOON");
  return date;
}
function normalized(b){
  return {variantGid:b.variantGid,productGid:b.productGid,
    canonicalProductId:b.canonicalProductId,
    unit:b.unit,packQuantity:b.packQuantity,sku:b.sku??null};
}
function digestOfBindings(bindings){
  insist(Array.isArray(bindings)&&bindings.length>0,"APNA_BINDINGS_REQUIRED");
  const list=bindings.map(normalized).sort((a,b)=>
    a.variantGid.localeCompare(b.variantGid,"en"));
  const seen=new Set();
  for(const x of list){
    insist(typeof x.variantGid==="string"&&!seen.has(x.variantGid),
      "APNA_DUPLICATE_BINDING");
    seen.add(x.variantGid);
  }
  return crypto.createHash("sha256").update(canonical(list),"utf8").digest("hex");
}
function dbBindings(rows){
  insist(Array.isArray(rows),"APNA_BINDINGS_REQUIRED");
  return rows.map(x=>normalized({
    variantGid:x.variant_gid,productGid:x.product_gid,
    canonicalProductId:x.canonical_product_id,
    unit:x.unit,packQuantity:x.pack_quantity,sku:x.sku
  }));
}
async function transaction(pool,fn){
  const db=await pool.connect();
  let began=false;
  try{
    await db.query("BEGIN");began=true;
    const x=await fn(db);
    await db.query("COMMIT");began=false;
    return x;
  }catch(e){
    if(began)try{await db.query("ROLLBACK");}catch{}
    throw e;
  }finally{db.release();}
}
function unwrapSignedRelease(row,signingKey){
  insist(row?.shop_domain===SHOP&&RELEASE.test(row.release_id)&&
    row.signed_envelope&&row.verified_at,"APNA_RELEASE_ROW_INVALID");
  const validated=verifyApprovedApnaRelease(row.signed_envelope,{
    expectedShop:SHOP,signingKey,now:new Date(row.verified_at)
  });
  insist(validated.policyVersion===row.release_id &&
    validated.authorizedBy===row.authorized_by,"APNA_RELEASE_ROW_INTEGRITY_MISMATCH");
  return validated;
}
function createApnaActivationService({pool,shopDomain,devDomainAllowlist=[],
  signingKey,resolveOnlineStaff,fetchVerifiedShopifyProducts,
  now=()=>new Date()
}={}){
  insist(pool&&typeof pool.connect==="function","APNA_ACTIVATION_PG_REQUIRED");
  insist(shopDomain===SHOP&&devDomainAllowlist.includes(SHOP),
    "APNA_ACTIVATION_DEV_SHOP_ONLY");
  insist(typeof signingKey==="string"&&Buffer.byteLength(signingKey,"utf8")>=32,
    "APNA_ACTIVATION_SIGNING_KEY_REQUIRED");
  insist(typeof resolveOnlineStaff==="function"&&
    typeof fetchVerifiedShopifyProducts==="function",
    "APNA_ACTIVATION_TRUSTED_ADAPTERS_REQUIRED");

  async function authenticate(authContext,role){
    const who=await resolveOnlineStaff({authContext,requiredRole:role,shopDomain:SHOP});
    insist(who?.shopDomain===SHOP&&who?.source==="shopify_online_staff_session"&&
      who?.role===role&&STAFF.test(who?.staffId),
      "APNA_STAFF_SESSION_AND_ROLE_REQUIRED");
    return who.staffId;
  }
  async function fetchCurrentBindings(release){
    const products=await fetchVerifiedShopifyProducts({
      shopDomain:SHOP,productGids:[...release.mappedCanonicalByProduct.keys()],
      serverOnly:true
    });
    return prepareApprovedApnaBindings({
      release,shopDomain:SHOP,verifiedProducts:products,
      serverCatalogVerified:true
    }).bindings;
  }
  async function candidate(id){
    insist(RELEASE.test(id||""),"APNA_RELEASE_ID_INVALID");
    const result=await pool.query(
      "SELECT release_id,shop_domain,state,signed_envelope,authorized_by,verified_at "+
      "FROM checkout_apna_policy_releases WHERE release_id=$1 AND shop_domain=$2",
      [id,SHOP]);
    insist(result.rows.length===1,"APNA_RELEASE_NOT_STAGED");
    const row=result.rows[0];
    insist(row.state==="staged","APNA_RELEASE_NOT_STAGED");
    return unwrapSignedRelease(row,signingKey);
  }

  async function review({releaseId,authContext,effectiveDeliveryDate,reason}={}){
    const reviewer=await authenticate(authContext,"apna_policy_reviewer");
    const timestamp=asTime(now());
    validateDate(effectiveDeliveryDate,timestamp);
    insist(typeof reason==="string"&&reason.trim().length>=24&&
      reason.trim().length<=1000,"APNA_REVIEW_REASON_REQUIRED");
    const release=await candidate(releaseId);
    const independentIds=new Set([
      release.authorizedBy,
      ...release.policiesApprovers??[]
    ]);
    // All founder approvals are in the immutable signed envelope.
    const signedRow=await pool.query(
      "SELECT signed_envelope FROM checkout_apna_policy_releases WHERE release_id=$1",
      [releaseId]);
    for(const p of signedRow.rows[0].signed_envelope.payload.policies)
      independentIds.add(p.approvedBy);
    insist(!independentIds.has(reviewer),"APNA_REVIEWER_NOT_INDEPENDENT");
    const fresh=await fetchCurrentBindings(release);
    const digest=digestOfBindings(fresh);
    return transaction(pool,async db=>{
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))",[SHOP]);
      const row=(await db.query(
        "SELECT release_id,shop_domain,state,signed_envelope,authorized_by,verified_at "+
        "FROM checkout_apna_policy_releases WHERE release_id=$1 FOR UPDATE",
        [releaseId])).rows[0];
      insist(row?.state==="staged","APNA_RELEASE_NOT_STAGED");
      const checked=unwrapSignedRelease(row,signingKey);
      insist(checked.policyVersion===release.policyVersion,
        "APNA_RELEASE_CHANGED_DURING_REVIEW");
      const current=(await db.query(
        "SELECT variant_gid,product_gid,canonical_product_id,unit,pack_quantity,sku "+
        "FROM checkout_apna_variant_bindings WHERE release_id=$1 ORDER BY variant_gid",
        [releaseId])).rows;
      insist(digestOfBindings(dbBindings(current))===digest,
        "APNA_CATALOG_DRIFT_REQUIRES_NEW_RELEASE");
      const prior=(await db.query(
        "SELECT release_id FROM checkout_apna_activation_reviews WHERE release_id=$1",
        [releaseId])).rows;
      insist(prior.length===0,"APNA_ALREADY_REVIEWED");
      await db.query(
        "INSERT INTO checkout_apna_activation_reviews "+
        "(release_id,shop_domain,reviewer_staff_id,source_approver_id,"+
        "effective_delivery_date,bindings_sha256,evidence_json) "+
        "VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)",
        [releaseId,SHOP,reviewer,release.authorizedBy,
          effectiveDeliveryDate,digest,
          JSON.stringify({reason:reason.trim(),catalogue:'CURRENT_SHOPIFY_ADMIN',
            approvedRuleCount:row.signed_envelope.payload.policies.length})]);
      await db.query(
        "INSERT INTO checkout_apna_release_audit "+
        "(release_id,actor_id,action,evidence_json) "+
        "VALUES($1,$2,'INDEPENDENT_REVIEW_APPROVED',$3::jsonb)",
        [releaseId,reviewer,JSON.stringify({
          effectiveDeliveryDate,bindingsDigest:digest,
          founderSigner:release.authorizedBy,reason:reason.trim(),
          activationPerformed:false})]);
      return {state:"reviewed_not_active",releaseId,
        reviewerStaffId:reviewer,effectiveDeliveryDate,
        bindingsDigest:digest};
    });
  }

  async function activate({releaseId,authContext,reviewedBindingsDigest,
    replaceActiveReleaseId=null}={}){
    const activator=await authenticate(authContext,"apna_policy_activator");
    const timestamp=asTime(now());
    insist(RELEASE.test(releaseId||"")&&DIGEST.test(reviewedBindingsDigest||""),
      "APNA_ACTIVATION_APPROVED_DIGEST_REQUIRED");
    const release=await candidate(releaseId);
    insist(activator!==release.authorizedBy,"APNA_ACTIVATOR_NOT_INDEPENDENT");
    const fresh=await fetchCurrentBindings(release);
    const digest=digestOfBindings(fresh);
    insist(digest===reviewedBindingsDigest,"APNA_ACTIVATION_CATALOG_DIGEST_MISMATCH");
    return transaction(pool,async db=>{
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))",[SHOP]);
      const reviewed=(await db.query(
        "SELECT * FROM checkout_apna_activation_reviews "+
        "WHERE release_id=$1 FOR UPDATE",[releaseId])).rows[0];
      insist(reviewed?.state==="approved"&&reviewed.shop_domain===SHOP &&
        reviewed.bindings_sha256===digest,
        "APNA_NO_VALID_INDEPENDENT_REVIEW");
      const delivery=new Date(reviewed.effective_delivery_date).toISOString().slice(0,10);
      validateDate(delivery,timestamp);
      insist(new Date(reviewed.reviewed_at).getTime()<=timestamp.getTime()&&
        timestamp.getTime()-new Date(reviewed.reviewed_at).getTime()<=REVIEW_WINDOW_MS,
        "APNA_REVIEW_TOO_OLD");
      insist(activator!==reviewed.source_approver_id,
        "APNA_ACTIVATOR_NOT_INDEPENDENT");
      const source=(await db.query(
        "SELECT release_id,shop_domain,state,signed_envelope,authorized_by,verified_at "+
        "FROM checkout_apna_policy_releases WHERE release_id=$1 FOR UPDATE",
        [releaseId])).rows[0];
      insist(source?.state==="staged","APNA_RELEASE_NOT_STAGED");
      const latest=unwrapSignedRelease(source,signingKey);
      insist(latest.policyVersion===release.policyVersion,
        "APNA_RELEASE_CHANGED_DURING_ACTIVATION");
      const persisted=(await db.query(
        "SELECT variant_gid,product_gid,canonical_product_id,unit,pack_quantity,sku "+
        "FROM checkout_apna_variant_bindings WHERE release_id=$1 ORDER BY variant_gid",
        [releaseId])).rows;
      insist(digestOfBindings(dbBindings(persisted))===digest,
        "APNA_STAGED_PACKS_CHANGED");
      const active=(await db.query(
        "SELECT release_id FROM checkout_apna_policy_releases "+
        "WHERE shop_domain=$1 AND state='active' FOR UPDATE",
        [SHOP])).rows;
      insist(active.length<=1,"APNA_MULTIPLE_ACTIVE_RELEASES");
      const previous=active[0]?.release_id??null;
      insist(previous===replaceActiveReleaseId,
        "APNA_REPLACEMENT_REQUIRES_EXPLICIT_OLD_RELEASE_ID");
      // Existing unresolved or committed orders for a cycle on/after the
      // activation date may have used another immutable policy. Block switch.
      const outstanding=(await db.query(
        "SELECT count(*)::int AS n FROM checkout_redemptions r "+
        "JOIN checkout_quotes q ON q.quote_id=r.quote_id "+
        "WHERE r.shop_domain=$1 AND q.delivery_date >= $2::date "+
        "AND r.state IN ('creating','needs_reconcile','completed')",
        [SHOP,delivery])).rows[0].n;
      insist(outstanding===0,"APNA_FUTURE_COMMITMENTS_REQUIRE_REVIEW");
      if(previous){
        await db.query(
          "UPDATE checkout_apna_policy_releases "+
          "SET state='revoked' WHERE release_id=$1 AND state='active'",
          [previous]);
        await db.query(
          "INSERT INTO checkout_apna_release_audit "+
          "(release_id,actor_id,action,evidence_json) "+
          "VALUES($1,$2,'REVOKED',$3::jsonb)",
          [previous,activator,JSON.stringify({
            reason:"explicit_replaced_by_reviewed_release",
            successor:releaseId,priorActivationStopped:true})]);
      }
      await db.query(
        "UPDATE checkout_apna_policy_releases SET state='active',"+
        "activated_at=clock_timestamp(),activated_by=$2,"+
        "effective_delivery_date=$3::date WHERE release_id=$1 AND state='staged'",
        [releaseId,activator,delivery]);
      await db.query(
        "UPDATE checkout_apna_activation_reviews "+
        "SET state='consumed',consumed_at=clock_timestamp() "+
        "WHERE release_id=$1 AND state='approved'",[releaseId]);
      await db.query(
        "INSERT INTO checkout_apna_release_audit "+
        "(release_id,actor_id,action,evidence_json) "+
        "VALUES($1,$2,'ACTIVATED',$3::jsonb)",
        [releaseId,activator,JSON.stringify({
          reviewedBy:reviewed.reviewer_staff_id,
          effectiveDeliveryDate:delivery,bindingsDigest:digest,
          predecessor:previous,founderSigner:release.authorizedBy})]);
      return {state:"active",releaseId,
        effectiveDeliveryDate:delivery,replacedReleaseId:previous};
    });
  }

  async function emergencySuspend({expectedActiveReleaseId,authContext,reason}={}){
    const suspender=await authenticate(authContext,"apna_policy_suspender");
    insist(RELEASE.test(expectedActiveReleaseId||"")&&
      typeof reason==="string"&&reason.trim().length>=24&&
      reason.trim().length<=1000,"APNA_SUSPENSION_REASON_REQUIRED");
    return transaction(pool,async db=>{
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))",[SHOP]);
      const active=(await db.query(
        "SELECT release_id,authorized_by FROM checkout_apna_policy_releases "+
        "WHERE shop_domain=$1 AND state='active' FOR UPDATE",
        [SHOP])).rows;
      insist(active.length===1&&active[0].release_id===expectedActiveReleaseId,
        "APNA_ACTIVE_RELEASE_CHANGED");
      insist(suspender!==active[0].authorized_by,
        "APNA_SUSPENDER_NOT_INDEPENDENT");
      await db.query(
        "UPDATE checkout_apna_policy_releases SET state='revoked' "+
        "WHERE release_id=$1 AND state='active'",[expectedActiveReleaseId]);
      await db.query(
        "INSERT INTO checkout_apna_release_audit "+
        "(release_id,actor_id,action,evidence_json) "+
        "VALUES($1,$2,'REVOKED',$3::jsonb)",
        [expectedActiveReleaseId,suspender,
          JSON.stringify({reason:reason.trim(),emergency:true,
            fallbackActivated:false})]);
      // Deliberately NO implicit fallback to a previously revoked rule.
      return {state:"revoked_no_fallback",releaseId:expectedActiveReleaseId};
    });
  }
  return {review,activate,emergencySuspend};
}
module.exports={
  createApnaActivationService,digestOfBindings,validateDate
};
