// ASB signed founder Apna policy: isolated DEVELOPMENT staging only.
// No activation is ever performed here. Product bindings come from Shopify
// Admin's server-side catalogue, not a caller's request or CSV.
"use strict";
const {QuoteError,canonical}=require("./quote-crypto-v1");
const {verifyApprovedApnaRelease}=require("./apna-approved-policy-v1");
const {prepareApprovedApnaBindings}=require("./apna-shopify-pack-bindings-v1");
const SHOP="asb-checkout-lab.myshopify.com";
function ok(x,code){if(!x)throw new QuoteError(code);}
const id=x=>typeof x==="string"&&/^[1-9][0-9]{0,19}$/.test(x);
async function tx(pool,action){
  const db=await pool.connect();let started=false;
  try{
    await db.query("BEGIN");started=true;
    const result=await action(db);
    await db.query("COMMIT");started=false;return result;
  }catch(e){
    if(started)try{await db.query("ROLLBACK");}catch{}
    throw e;
  }finally{db.release();}
}
function createPgApnaPolicyStager({pool,shopDomain,devDomainAllowlist=[],
  signingKey,fetchVerifiedShopifyProducts,now=()=>new Date()
}={}){
  ok(pool&&typeof pool.connect==="function","APNA_STAGE_PG_REQUIRED");
  ok(shopDomain===SHOP&&devDomainAllowlist.includes(SHOP),
    "APNA_STAGE_DEV_SHOP_REQUIRED");
  ok(typeof fetchVerifiedShopifyProducts==="function",
    "APNA_CATALOG_SERVER_READER_REQUIRED");
  ok(typeof signingKey==="string"&&Buffer.byteLength(signingKey,"utf8")>=32,
    "APNA_RELEASE_KEY_REQUIRED");
  async function stageSignedRelease({envelope,operatorStaffId}={}){
    ok(id(operatorStaffId),"APNA_OPERATOR_ID_REQUIRED");
    const release=verifyApprovedApnaRelease(envelope,{
      expectedShop:shopDomain,signingKey,now:now()
    });
    const products=await fetchVerifiedShopifyProducts({
      shopDomain,productGids:[...release.mappedCanonicalByProduct.keys()],
      serverOnly:true
    });
    const prepared=prepareApprovedApnaBindings({
      release,shopDomain,verifiedProducts:products,serverCatalogVerified:true
    });
    return tx(pool,async db=>{
      const result=await db.query(
        "SELECT release_id,shop_domain,signed_envelope,state "+
        "FROM checkout_apna_policy_releases WHERE release_id=$1 FOR UPDATE",
        [release.policyVersion]);
      const priorRelease=result.rows[0];
      if(priorRelease){
        ok(priorRelease.shop_domain===shopDomain&&
          canonical(priorRelease.signed_envelope)===canonical(envelope),
          "APNA_EXISTING_RELEASE_INTEGRITY_CONFLICT");
        const existing=(await db.query(
          "SELECT variant_gid,product_gid,canonical_product_id,unit,pack_quantity,sku "+
          "FROM checkout_apna_variant_bindings WHERE release_id=$1 ORDER BY variant_gid",
          [release.policyVersion])).rows;
        const normalize=x=>({
          variantGid:x.variant_gid,productGid:x.product_gid,
          canonicalProductId:x.canonical_product_id,unit:x.unit,
          packQuantity:x.pack_quantity,sku:x.sku
        });
        const proposed=prepared.bindings.map(x=>({
          variantGid:x.variantGid,productGid:x.productGid,
          canonicalProductId:x.canonicalProductId,unit:x.unit,
          packQuantity:x.packQuantity,sku:x.sku
        }));
        ok(canonical(existing.map(normalize))===canonical(proposed),
          "APNA_STAGED_VARIANT_DRIFT_REQUIRES_NEW_RELEASE");
        return {state:priorRelease.state,releaseId:release.policyVersion,
          bindingCount:existing.length,changed:false};
      }
      await db.query(
        "INSERT INTO checkout_apna_policy_releases "+
        "(release_id,shop_domain,signed_envelope,authorized_by,issued_at,"+
        "source_expires_at,verified_at,state) "+
        "VALUES ($1,$2,$3::jsonb,$4,$5,$6,clock_timestamp(),'staged')",
        [release.policyVersion,shopDomain,JSON.stringify(envelope),
          release.authorizedBy,envelope.payload.issuedAt,envelope.payload.expiresAt]
      );
      for(const b of prepared.bindings){
        await db.query(
          "INSERT INTO checkout_apna_variant_bindings "+
          "(release_id,variant_gid,product_gid,canonical_product_id,unit,"+
          "pack_quantity,sku) VALUES($1,$2,$3,$4,$5,$6,$7)",
          [release.policyVersion,b.variantGid,b.productGid,
            b.canonicalProductId,b.unit,b.packQuantity,b.sku]
        );
      }
      await db.query(
        "INSERT INTO checkout_apna_release_audit "+
        "(release_id,actor_id,action,evidence_json) "+
        "VALUES ($1,$2,'SIGNED_CANDIDATE_STAGED',$3::jsonb)",
        [release.policyVersion,operatorStaffId,
          JSON.stringify({shopDomain,variantCount:prepared.bindings.length,
            approvedPolicyCount:envelope.payload.policies.length,
            activationPerformed:false})]
      );
      return {state:"staged",releaseId:release.policyVersion,
        bindingCount:prepared.bindings.length,changed:true};
    });
  }
  return {stageSignedRelease};
}
// An ACTIVE release is readable only after independent reviewed activation.
async function loadActiveApnaPolicyFromPgTransaction({db,shopDomain,deliveryDate}={}){
  ok(db&&typeof db.query==="function","APNA_ACTIVE_PG_REQUIRED");
  ok(shopDomain===SHOP,"APNA_ACTIVE_DEV_SHOP_REQUIRED");
  ok(typeof deliveryDate==="string"&&/^\d{4}-\d\d-\d\d$/.test(deliveryDate),
    "APNA_ACTIVE_DELIVERY_REQUIRED");
  const r=(await db.query(
    "SELECT release_id,signed_envelope,state,verified_at,activated_at,"+
    "activated_by,effective_delivery_date::text AS effective_day "+
    "FROM checkout_apna_policy_releases WHERE shop_domain=$1 AND state='active' "+
    "AND effective_delivery_date <= $2::date FOR SHARE",
    [shopDomain,deliveryDate])).rows;
  ok(r.length===1&&r[0].activated_at&&r[0].activated_by,
    "APNA_NO_ACTIVE_REVIEWED_RELEASE");
  const x=r[0],b=(await db.query(
    "SELECT variant_gid,product_gid,canonical_product_id,unit,pack_quantity,sku "+
    "FROM checkout_apna_variant_bindings WHERE release_id=$1",
    [x.release_id])).rows;
  ok(b.length>0,"APNA_ACTIVE_VARIANTS_MISSING");
  return {
    state:x.state,policyVersion:x.release_id,envelope:x.signed_envelope,
    verifiedAt:new Date(x.verified_at).toISOString(),
    activatedAt:new Date(x.activated_at).toISOString(),
    activatedBy:x.activated_by,effectiveDeliveryDate:x.effective_day,
    variantBindings:b.map(v=>({
      shopDomain,variantGid:v.variant_gid,productGid:v.product_gid,
      canonicalProductId:v.canonical_product_id,unit:v.unit,
      packQuantity:v.pack_quantity,sku:v.sku,active:true
    }))
  };
}
module.exports={createPgApnaPolicyStager,loadActiveApnaPolicyFromPgTransaction};
