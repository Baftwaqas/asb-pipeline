// Lab-only mapping for exactly one 500g Apna Onion synthetic test order.
// This is not a product policy release, does not approve production quantities,
// and cannot substitute for an authoritative active Apna policy in production.
"use strict";
const {QuoteError}=require("./quote-crypto-v1");
const fixture=require("./fixtures/asb-checkout-lab.json");
const SHOP="asb-checkout-lab.myshopify.com";
const VERSION="LAB-APNA-ONION-500G-20261112-V1";
const CANONICAL="ASB-CANON-ONION";
function need(ok,code){if(!ok)throw new QuoteError(code);}
function verifyLabApnaOnionOnlyInTransaction({db,quote,identity,shopDomain,cycle,dbNow}={}){
  need(db&&typeof db.query==="function","LAB_APNA_DB_REQUIRED");
  need(shopDomain===SHOP&&fixture.shopDomain===SHOP,"LAB_APNA_WRONG_SHOP");
  need(identity?.serverAuthenticated===true&&identity.phoneVerified===true&&
    identity.householdKey===quote?.customerReference,"LAB_APNA_IDENTITY_REQUIRED");
  need(cycle?.status==="open"&&cycle.code===quote?.cycleCode&&
    cycle.delivery_day===quote.deliveryDate,"LAB_APNA_CYCLE_NOT_OPEN");
  need(dbNow instanceof Date&&!Number.isNaN(dbNow.getTime()),"LAB_APNA_DB_CLOCK_REQUIRED");
  need(quote?.currency==="PKR"&&Array.isArray(quote.lines)&&quote.lines.length===1,
    "LAB_APNA_SINGLE_LINE_REQUIRED");
  const line=quote.lines[0],variant=fixture.products[0].variants[0];
  need(line?.lineId==="LAB-APNA-ONION-500"&&line?.door==="apna_order"&&
    line.merchandiseKind==="grocery"&&line.unit==="g"&&line.qty===500&&
    line.provenance?.kind==="apna_selection"&&!line.heroTier,
    "LAB_APNA_DOOR_OR_PACK_MISMATCH");
  // Intentional lab-only mapping: historical fixture product ASB-LAB-ONION
  // corresponds to the Data Manager's ASB-CANON-ONION.
  need(fixture.products[0].canonicalProductId==="ASB-LAB-ONION"&&
    line.canonicalProductId===CANONICAL&&line.shopifyVariantGid===variant.gid&&
    line.sku===variant.sku,"LAB_APNA_CANONICAL_VARIANT_MISMATCH");
  need(variant.quantityGrams===500&&variant.pricePaisa===4500&&
    line.quotedLinePaisa===4500&&line.ceilingLinePaisa===4500&&
    quote.quotedTotalPaisa===4500&&quote.ceilingTotalPaisa===4500,
    "LAB_APNA_PRICE_MISMATCH");
  need(quote.communityEligibilityByDoor?.community_order?.eligible===false,
    "LAB_APNA_CROSS_DOOR_FORBIDDEN");
  return {approved:true,policyVersion:VERSION};
}
module.exports={verifyLabApnaOnionOnlyInTransaction,SHOP,CANONICAL,VERSION};
