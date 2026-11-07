// ASB Apna policy: PostgreSQL adapter for founder-signed ACTIVE release.
// The signed source was verified at staging. This code checks stored activation,
// current variant pack identity, prior checkout commitments under the lock.
// ONLY DEV STORE. External legacy history and other doors are mandatory guards.
"use strict";
const {QuoteError}=require("./quote-crypto-v1");
const {createReleasedApnaCheckoutVerifier}=
  require("./apna-approved-policy-v1");
const {loadActiveApnaPolicyFromPgTransaction}=
  require("./apna-policy-pg-v1");
const SHOP="asb-checkout-lab.myshopify.com";
function check(x,code){if(!x)throw new QuoteError(code);}
async function readExistingCheckoutApnaLines({db,shopDomain,householdKey,cycleCode}={}){
  check(db&&typeof db.query==="function"&&shopDomain===SHOP&&
    typeof householdKey==="string"&&typeof cycleCode==="string",
    "APNA_PRIOR_CLAIMS_QUERY_REFUSED");
  const rows=(await db.query(
    "SELECT r.quote_id,r.state,q.signed_quote->'lines' AS lines "+
    "FROM checkout_redemptions r "+
    "JOIN checkout_quotes q ON q.quote_id=r.quote_id "+
    "WHERE r.shop_domain=$1 AND r.household_key=$2 AND r.cycle_code=$3 "+
    "AND r.state IN ('creating','needs_reconcile','completed')",
    [shopDomain,householdKey,cycleCode])).rows;
  check(rows.length<=10000,"APNA_COMMITMENT_HISTORY_TOO_LARGE");
  const lines=[];
  for(const r of rows){
    check(Array.isArray(r.lines),"APNA_CORRUPT_SIGNED_QUOTE_HISTORY");
    for(const line of r.lines){
      if(line?.door!=="apna_order")continue;
      check(Number.isSafeInteger(line.qty)&&line.qty>0&&
        typeof line.canonicalProductId==="string"&&
        (line.unit==="g"||line.unit==="piece"),
        "APNA_CORRUPT_COMMITTED_LINE");
      lines.push({
        door:"apna_order",canonicalProductId:line.canonicalProductId,
        unit:line.unit,qty:line.qty,
        householdKey,cycleCode,orderId:r.quote_id,status:r.state
      });
    }
  }
  return lines;
}
function createPgReleasedApnaCheckoutVerifier({
  shopDomain,signingKey,verifyExternalHistoryInTransaction,
  verifyOtherDoorsInTransaction
}={}){
  check(shopDomain===SHOP,"APNA_DEV_SHOP_REQUIRED");
  check(typeof signingKey==="string"&&Buffer.byteLength(signingKey,"utf8")>=32,
    "APNA_RELEASE_SIGNING_KEY_REQUIRED");
  check(typeof verifyExternalHistoryInTransaction==="function"&&
    typeof verifyOtherDoorsInTransaction==="function",
    "APNA_EXTERNAL_HISTORY_AND_OTHER_DOORS_REQUIRED");
  return async ctx=>{
    check(ctx?.db&&typeof ctx.db.query==="function"&&
      ctx.shopDomain===SHOP&&ctx.quote?.deliveryDate&&
      ctx.identity?.serverAuthenticated===true&&ctx.identity?.phoneVerified===true,
      "APNA_TRANSACTION_AND_IDENTITY_REQUIRED");
    const record=await loadActiveApnaPolicyFromPgTransaction({
      db:ctx.db,shopDomain,deliveryDate:ctx.quote.deliveryDate
    });
    const wrapped=createReleasedApnaCheckoutVerifier({
      expectedShop:SHOP,signingKey,
      loadSignedReleaseInTransaction:async()=>record,
      loadVariantBindingsInTransaction:async()=>record.variantBindings,
      loadExistingCycleLinesInTransaction:async()=> {
        const checkoutLines=await readExistingCheckoutApnaLines({
          db:ctx.db,shopDomain,
          householdKey:ctx.identity.householdKey,cycleCode:ctx.quote.cycleCode
        });
        const external=await verifyExternalHistoryInTransaction(ctx);
        check(external?.authoritative===true&&Array.isArray(external.lines),
          "APNA_LEGACY_ORDERS_NOT_VERIFIED");
        return {authoritative:true,lines:[...checkoutLines,...external.lines]};
      },
      verifyOtherDoorsInTransaction
    });
    return wrapped(ctx);
  };
}
// For the totally isolated ASB Checkout Lab only: refuse if any legacy ASB
// order exists. This is NOT usable on the live ASB store with historical orders.
async function verifyEmptyLegacyOrdersInLab(ctx){
  check(ctx.shopDomain===SHOP,"APNA_LAB_ONLY");
  const r=(await ctx.db.query("SELECT count(*)::bigint AS count FROM orders")).rows[0];
  check(String(r?.count)==="0","APNA_LAB_LEGACY_ORDER_SOURCE_NOT_EMPTY");
  return {authoritative:true,lines:[]};
}
module.exports={readExistingCheckoutApnaLines,
  createPgReleasedApnaCheckoutVerifier,verifyEmptyLegacyOrdersInLab};
