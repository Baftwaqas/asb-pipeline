// ASB ADR-002 | Verify a Data Manager FOUNDER-SIGNED Apna policy release.
// This is a strict parser/verifier, NOT a policy activator or Shopify import.
// Only accept releases issued by the app-owned offline signing secret after
// founder permission validation; no arbitrary JSON candidate may activate.
"use strict";
const crypto=require("node:crypto");
const {QuoteError,canonical}=require("./quote-crypto-v1");
const {evaluateApnaCycleLimits}=require("../grocery/apna-limits");

const SHOP_PATTERN=/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
const PRODUCT_GID=/^gid:\/\/shopify\/Product\/[1-9][0-9]*$/;
const VARIANT_GID=/^gid:\/\/shopify\/ProductVariant\/[1-9][0-9]*$/;
const CANONICAL=/^[A-Z0-9][A-Z0-9_-]{2,79}$/;
const SIGNATURE=/^sha256:[0-9a-f]{64}$/;
const ONE_HOUR_MS=60*60*1000;
function check(ok,code){if(!ok)throw new QuoteError(code);}
function safeDate(value,code){
  check(typeof value==="string"&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value),
    code);
  const ts=Date.parse(value);
  check(Number.isFinite(ts)&&new Date(ts).toISOString()===value,code);
  return ts;
}
function positive(n){return Number.isSafeInteger(n)&&n>=1&&n<=999999999;}
function numericId(n){return typeof n==="string"&&/^[1-9][0-9]{0,19}$/.test(n);}
function exactly(obj,keys,code){
  check(obj&&typeof obj==="object"&&!Array.isArray(obj)&&
    Object.keys(obj).sort().join(",")===keys.slice().sort().join(","),code);
}
function verifyApprovedApnaRelease(envelope,{
  expectedShop, signingKey, now=new Date()
}={}){
  check(typeof expectedShop==="string"&&SHOP_PATTERN.test(expectedShop),
    "POLICY_EXPECTED_SHOP_REQUIRED");
  check(typeof signingKey==="string"&&Buffer.byteLength(signingKey,"utf8")>=32,
    "POLICY_VERIFICATION_KEY_REQUIRED");
  check(now instanceof Date&&!Number.isNaN(now.valueOf()),"POLICY_INVALID_CLOCK");
  exactly(envelope,["payload","signature"],"POLICY_ENVELOPE_INVALID");
  const {payload,signature}=envelope;
  check(SIGNATURE.test(signature),"POLICY_SIGNATURE_MALFORMED");
  const expected="sha256:"+crypto.createHmac("sha256",signingKey)
    .update(canonical(payload),"utf8").digest("hex");
  check(crypto.timingSafeEqual(Buffer.from(signature),Buffer.from(expected)),
    "POLICY_SIGNATURE_INVALID");
  exactly(payload,[
    "schemaVersion","deploymentState","shop","issuedAt","expiresAt",
    "authorizedBy","policies","mappings"
  ],"POLICY_PAYLOAD_INVALID");
  check(payload.schemaVersion==="ASB_APNA_POLICY_RELEASE_V1"&&
    payload.deploymentState==="FOUNDER_SIGNED_REQUIRES_INDEPENDENT_IMPORT",
    "POLICY_RELEASE_TYPE_INVALID");
  check(payload.shop===expectedShop,"POLICY_CROSS_SHOP_REFUSED");
  check(numericId(payload.authorizedBy),"POLICY_RELEASE_AUTHORIZER_INVALID");
  const issued=safeDate(payload.issuedAt,"POLICY_ISSUED_AT_INVALID");
  const expires=safeDate(payload.expiresAt,"POLICY_EXPIRES_AT_INVALID");
  check(expires>issued&&expires-issued<=ONE_HOUR_MS&&
    now.valueOf()>=issued&&now.valueOf()<expires,
    "POLICY_RELEASE_EXPIRED_OR_NOT_YET_VALID");
  const ps=payload.policies,ms=payload.mappings;
  check(Array.isArray(ps)&&ps.length>0&&ps.length<=500&&
    Array.isArray(ms)&&ms.length>0&&ms.length<=4000,
    "POLICY_RELEASE_EMPTY_OR_TOO_LARGE");
  const seenIds=new Set(),limitsByProduct=Object.create(null);
  for(const p of ps){
    exactly(p,["canonicalProductId","unit","minQuantity","maxQuantity",
      "allowedSizes","revision","approvedBy","approvedAt"],
      "POLICY_INVALID_APPROVED_ROW");
    check(CANONICAL.test(p.canonicalProductId)&&!seenIds.has(p.canonicalProductId),
      "POLICY_DUPLICATE_CANONICAL");
    seenIds.add(p.canonicalProductId);
    check(["g","piece"].includes(p.unit)&&positive(p.minQuantity)&&
      positive(p.maxQuantity)&&p.minQuantity<=p.maxQuantity&&
      positive(p.revision)&&numericId(p.approvedBy),
      "POLICY_INVALID_QUANTITY_OR_APPROVER");
    check(Array.isArray(p.allowedSizes)&&p.allowedSizes.length>0&&
      p.allowedSizes.length<=32&&p.allowedSizes[0]===p.minQuantity&&
      p.allowedSizes.every((size,i,a)=>positive(size)&&size<=p.maxQuantity&&
        (i===0||size>a[i-1])),
      "POLICY_INVALID_PACK_LADDER");
    check(safeDate(p.approvedAt,"POLICY_APPROVED_AT_INVALID")<=issued,
      "POLICY_FUTURE_APPROVAL");
    limitsByProduct[p.canonicalProductId]={
      unit:p.unit,minQuantity:p.minQuantity,maxQuantity:p.maxQuantity,
      allowedSizes:p.allowedSizes.slice()
    };
  }
  const byProduct=new Map(),linked=new Set();
  for(const m of ms){
    exactly(m,["productGid","canonicalProductId"],"POLICY_INVALID_MAPPING");
    check(PRODUCT_GID.test(m.productGid)&&seenIds.has(m.canonicalProductId)&&
      !byProduct.has(m.productGid),"POLICY_UNAPPROVED_OR_DUPLICATE_MAPPING");
    byProduct.set(m.productGid,m.canonicalProductId);
    linked.add(m.canonicalProductId);
  }
  check(linked.size===seenIds.size,"POLICY_UNMAPPED_CANONICAL");
  const policyVersion="apna-signed-"+crypto.createHash("sha256")
    .update(signature).digest("hex").slice(0,24);
  return {shop:payload.shop,policyVersion,limitsByProduct,
    mappedCanonicalByProduct:byProduct,issuedAt:payload.issuedAt,
    authorizedBy:payload.authorizedBy};
}

// This validator MUST be called inside the SAME PG household+cycle locked
// transaction as checkout_redemptions insertion. All bindings/history MUST
// be resolved by authoritative SERVER code, never browser-provided.
function validateApnaQuoteAgainstRelease({
  quote,identity,cycleCode,shopDomain,release,variantBindings,
  bindingsVerified,existingCycleLines,historyVerified
}={}){
  check(release?.shop===shopDomain&&release?.policyVersion,
    "APNA_RELEASE_SHOP_MISMATCH");
  check(identity?.serverAuthenticated===true&&identity.phoneVerified===true&&
    quote?.customerReference===identity.householdKey&&quote?.cycleCode===cycleCode,
    "APNA_CUSTOMER_OR_CYCLE_MISMATCH");
  check(bindingsVerified===true&&historyVerified===true&&
    Array.isArray(variantBindings)&&Array.isArray(existingCycleLines)&&
    Array.isArray(quote.lines),"APNA_AUTHORITATIVE_SOURCES_REQUIRED");
  const bindings=new Map();
  for(const b of variantBindings){
    check(b?.shopDomain===shopDomain&&VARIANT_GID.test(b.variantGid)&&
      PRODUCT_GID.test(b.productGid)&&positive(b.packQuantity)&&
      (b.unit==="g"||b.unit==="piece")&&
      b.active===true&&!bindings.has(b.variantGid),
      "APNA_INVALID_VARIANT_BINDING");
    const canonicalId=release.mappedCanonicalByProduct.get(b.productGid);
    check(canonicalId===b.canonicalProductId&&
      release.limitsByProduct[canonicalId]?.unit===b.unit,
      "APNA_VARIANT_NOT_FOUNDER_APPROVED");
    check(release.limitsByProduct[canonicalId].allowedSizes.includes(b.packQuantity),
      "APNA_VARIANT_PACK_NOT_APPROVED");
    bindings.set(b.variantGid,b);
  }
  if(quote.lines.some(line=>line.door==="apna_order"))
    check(quote.apnaPolicyVersion===release.policyVersion,
      "APNA_QUOTE_RELEASE_VERSION_MISMATCH");
  for(const line of quote.lines){
    if(line.door!=="apna_order")continue;
    const b=bindings.get(line.shopifyVariantGid);
    check(Boolean(b),"APNA_VARIANT_MISSING_APPROVED_BINDING");
    check(line.canonicalProductId===b.canonicalProductId&&
      line.qty===b.packQuantity&&line.unit===b.unit&&
      line.provenance?.kind==="apna_selection",
      "APNA_QUOTE_VARIANT_PACK_MISMATCH");
  }
  const evaluated=evaluateApnaCycleLimits({
    householdKey:identity.householdKey,cycleCode,
    incomingLines:quote.lines,existingCycleLines,
    limitsByProduct:release.limitsByProduct
  });
  check(evaluated.allowed,"APNA_APPROVED_LIMIT_VIOLATION");
  return {...evaluated,policyVersion:release.policyVersion};
}

// Integration entry point for createPgRedemptionLedger.verifyPolicyInTransaction.
// Caller MUST supply all four independent trusted server-side adapters.
// The non-Apna verifier is mandatory to prevent mixed-door bypasses.
function createReleasedApnaCheckoutVerifier({
  loadSignedReleaseInTransaction,loadVariantBindingsInTransaction,
  loadExistingCycleLinesInTransaction,verifyOtherDoorsInTransaction,
  signingKey,expectedShop,now=()=>new Date()
}={}){
  for(const [name,fn] of Object.entries({
    loadSignedReleaseInTransaction,loadVariantBindingsInTransaction,
    loadExistingCycleLinesInTransaction,verifyOtherDoorsInTransaction
  }))check(typeof fn==="function","APNA_REQUIRED_ADAPTER_MISSING_"+name);
  return async function verifyPolicyInTransaction(ctx){
    check(ctx?.db&&typeof ctx.db.query==="function","APNA_DATABASE_TRANSACTION_REQUIRED");
    check(ctx.shopDomain===expectedShop,"POLICY_CROSS_SHOP_REFUSED");
    const record=await loadSignedReleaseInTransaction(ctx);
    // The signed export is valid for ONLY one hour at STAGING time. After
    // a separately authorized activation, it remains independently verifiable
    // using the trusted immutable DB verified_at, not today's checkout clock.
    check(record?.state==="active"&&record.envelope&&record.verifiedAt &&
      record.policyVersion && record.activatedAt && record.activatedBy &&
      typeof record.effectiveDeliveryDate==="string" &&
      /^\d{4}-\d\d-\d\d$/.test(record.effectiveDeliveryDate) &&
      ctx.quote.deliveryDate>=record.effectiveDeliveryDate,
      "APNA_NO_ACTIVE_REVIEWED_RELEASE");
    const release=verifyApprovedApnaRelease(record.envelope,{
      expectedShop,signingKey,now:new Date(record.verifiedAt)
    });
    check(release.policyVersion===record.policyVersion,
      "APNA_RELEASE_DB_INTEGRITY_MISMATCH");
    const variantBindings=await loadVariantBindingsInTransaction({...ctx,release});
    const historical=await loadExistingCycleLinesInTransaction({...ctx,release});
    check(historical?.authoritative===true&&Array.isArray(historical.lines),
      "APNA_HISTORY_UNVERIFIED");
    const apna=validateApnaQuoteAgainstRelease({
      quote:ctx.quote,identity:ctx.identity,cycleCode:ctx.quote.cycleCode,
      shopDomain:ctx.shopDomain,release,variantBindings,
      bindingsVerified:true,existingCycleLines:historical.lines,
      historyVerified:true
    });
    const other=await verifyOtherDoorsInTransaction({...ctx,release,apna});
    check(other?.approved===true&&typeof other.policyVersion==="string"&&
      other.policyVersion.length>0,"NON_APNA_POLICY_NOT_APPROVED");
    return {approved:true,policyVersion:release.policyVersion+"+"+other.policyVersion};
  };
}
module.exports={
  verifyApprovedApnaRelease,validateApnaQuoteAgainstRelease,
  createReleasedApnaCheckoutVerifier
};
