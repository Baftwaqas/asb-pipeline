// ASB Checkout Lab v1 — exact synthetic test fixture pricing verifier.
// This is NOT a production pricing engine, rate meter or founder approval.
// No fuzzy SKU resolution; ONLY exact Shopify variant GIDs in fixtures.
"use strict";
const {QuoteError}=require("./quote-crypto-v1");
const fixture=require("./fixtures/asb-checkout-lab.json");
const SHOP="asb-checkout-lab.myshopify.com";
const VERSION="LAB-FIXTURE-POLICY-20261105-V1";
function refuse(test,code){if(!test)throw new QuoteError(code);}
function verifyLabFixturePolicyInTransaction({db,quote,identity,shopDomain,cycle,dbNow}={}){
  // This function is intentionally tiny, exact and conspicuously LAB-ONLY.
  refuse(db&&typeof db.query==="function","DB_POLICY_TX_REQUIRED");
  refuse(shopDomain===SHOP && fixture.shopDomain===SHOP,"WRONG_LAB_SHOP");
  refuse(identity?.serverAuthenticated===true&&identity?.phoneVerified===true&&
    identity.householdKey===quote?.customerReference,"LAB_HOUSEHOLD_NOT_VERIFIED");
  refuse(cycle?.status==="open"&&cycle?.code===quote.cycleCode,"LAB_CYCLE_NOT_OPEN");
  refuse(dbNow instanceof Date && !Number.isNaN(dbNow.valueOf()),"LAB_DB_CLOCK_REQUIRED");
  refuse(quote?.currency==="PKR"&&Array.isArray(quote.lines)&&quote.lines.length===3,
    "LAB_FIXTURE_LINES_REQUIRED");
  refuse(quote.deliveryDate===cycle.delivery_day,"LAB_CYCLE_DATE_MISMATCH");
  const p=fixture.products;
  const onion=p[0].variants[0],ginger=p[1].variants[0],hero=p[2].variants[1];
  const demands=[
    {gid:onion.gid,canonical:p[0].canonicalProductId,door:"apna_order",
      qty:500,price:onion.pricePaisa,kind:"apna_selection",hero:false},
    {gid:ginger.gid,canonical:p[1].canonicalProductId,door:"dish_to_cart",
      qty:40,price:1120,kind:"recipe",hero:false},
    {gid:hero.gid,canonical:p[2].canonicalProductId,door:"community_order",
      qty:10000,price:hero.pricePaisa,kind:"community_pack",hero:true}
  ];
  let total=0,ceiling=0;
  for(let i=0;i<demands.length;i++){
    const x=quote.lines[i],e=demands[i];
    refuse(x?.lineId==="L"+(i+1),"LAB_LINE_ID_MISMATCH");
    refuse(x.door===e.door && x.merchandiseKind==="grocery" && x.unit==="g",
      "LAB_DOOR_MISMATCH");
    refuse(x.shopifyVariantGid===e.gid && x.canonicalProductId===e.canonical,
      "LAB_VARIANT_MISMATCH");
    refuse(x.qty===e.qty && x.quotedLinePaisa===e.price &&
      x.ceilingLinePaisa===e.price,"LAB_PRICE_OR_PACK_MISMATCH");
    refuse(x.provenance?.kind===e.kind,"LAB_PROVENANCE_MISMATCH");
    if(e.door==="dish_to_cart")refuse(
      Array.isArray(x.provenance.recipeIds)&&
      x.provenance.recipeIds.length===1&&x.provenance.recipeIds[0]==="LAB-RECIPE-001",
      "LAB_RECIPE_ID_REQUIRED");
    if(e.hero)refuse(x.heroTier?.heroWeekId==="LAB-WEEK-20261109"&&
      x.heroTier?.tierId==="LAB-ONION-10KG" && e.price>=120000,
      "LAB_HERO_TIER_MISMATCH");
    else refuse(x.heroTier==null,"LAB_HERO_TIER_FORBIDDEN");
    total+=x.quotedLinePaisa;
    ceiling+=x.ceilingLinePaisa;
  }
  refuse(total===155620 && quote.quotedTotalPaisa===total &&
         quote.ceilingTotalPaisa===ceiling,"LAB_QUOTE_TOTAL_MISMATCH");
  refuse(quote.communityEligibilityByDoor?.community_order?.eligible===true&&
         quote.communityEligibilityByDoor.community_order.qualifyingCeilingPaisa===150000,
    "LAB_COMMUNITY_MINIMUM_OR_TIER");
  return {approved:true,policyVersion:VERSION};
}
module.exports={verifyLabFixturePolicyInTransaction,VERSION,SHOP};
