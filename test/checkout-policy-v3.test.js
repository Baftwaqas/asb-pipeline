"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const {evaluate,COMMUNITY_MIN_PAISA}=require("../checkout/policy-v3");
const g=(unitPricePaisa,extra={})=>({productId:"P"+unitPricePaisa,variantId:"V"+unitPricePaisa,kind:"grocery",quantity:1,unitPricePaisa,...extra});
const c=(productId,variantId,price,extra={})=>({productId,variantId,kind:"community",quantity:1,unitPricePaisa:price,allowedVariantIds:["5kg","10kg"],...extra});
test("Apna Order and Dish-to-Cart have no Rs 1200 restriction and always free delivery",()=>{
 for(const feature of ["apna_order","dish_to_cart"]){
  const v=evaluate({feature,items:[g(14500)]});
  assert.equal(v.allowed,true);assert.equal(v.payablePaisa,14500);assert.equal(v.deliveryPaisa,0);assert.equal(v.minimumPaisa,0);
 }
});
test("Community below minimum receives a gentle, exact shortfall nudge",()=>{
 const v=evaluate({feature:"community_bulk_buying",items:[c("onion","5kg",95000)]});
 assert.equal(COMMUNITY_MIN_PAISA,120000);assert.equal(v.allowed,false);
 assert.equal(v.code,"MINIMUM_NOT_REACHED");assert.equal(v.shortfallPaisa,25000);
 assert.match(v.nudgeRomanUrdu,/Rs 250/);assert.match(v.nudgeRomanUrdu,/FREE/);
 const success=evaluate({feature:"community_bulk_buying",items:[c("onion","5kg",95000),c("potato","10kg",25000)]});
 assert.equal(success.allowed,true);assert.equal(success.payablePaisa,120000);assert.equal(success.deliveryPaisa,0);
});
test("Community is one offered pack per product, with no 5+5 or 10+10 workaround",()=>{
 const base={feature:"community_bulk_buying"};
 assert.equal(evaluate({...base,items:[c("onion","5kg",120000,{quantity:2})]}).code,"COMMUNITY_ONE_PACK_PER_PRODUCT");
 assert.equal(evaluate({...base,items:[c("onion","5kg",70000),c("onion","5kg",70000)]}).code,"COMMUNITY_ONE_PACK_PER_PRODUCT");
 assert.equal(evaluate({...base,items:[c("onion","5kg",70000),c("onion","10kg",70000)]}).code,"COMMUNITY_ONE_PACK_PER_PRODUCT");
 assert.equal(evaluate({...base,items:[c("onion","20kg",150000)]}).code,"COMMUNITY_UNOFFERED_PACK");
 assert.equal(evaluate({...base,items:[c("onion","5kg",150000,{allowedVariantIds:[]})]}).code,"COMMUNITY_UNOFFERED_PACK");
});
test("Community post-discount basket value—not pre-discount—must clear minimum",()=>{
 const v=evaluate({feature:"community_bulk_buying",items:[c("onion","10kg",125000)],discountPaisa:10000});
 assert.equal(v.code,"MINIMUM_NOT_REACHED");assert.equal(v.shortfallPaisa,5000);
 assert.equal(v.payablePaisa,115000);
});
test("Budget tiers are UNAPPROVED until owner sets tiers AND a minimum qualifying spend",()=>{
 const v=evaluate({feature:"budget_to_cart",items:[g(150000)]});
 assert.equal(v.code,"BUDGET_TIERS_NOT_APPROVED");assert.equal(v.allowed,false);
 assert.equal(evaluate({feature:"budget_to_cart",items:[g(150000)],
  approvedWeeklyTiersPaisa:[120000],budgetTierPaisa:120000,budgetMinimumSpendPaisa:120000}).allowed,false);
});
test("Configured Budget-to-Cart requires a valid tier >1200, minimum and maximum guard",()=>{
 const cfg={feature:"budget_to_cart",approvedWeeklyTiersPaisa:[160000,250000],
  budgetTierPaisa:160000,budgetMinimumSpendPaisa:130000};
 assert.equal(evaluate({...cfg,items:[g(125000)]}).code,"MINIMUM_NOT_REACHED");
 const ok=evaluate({...cfg,items:[g(155000)]});
 assert.equal(ok.allowed,true);assert.equal(ok.payablePaisa,155000);assert.equal(ok.deliveryPaisa,0);
 const over=evaluate({...cfg,items:[g(180000)]});
 assert.equal(over.code,"BUDGET_EXCEEDED");assert.match(over.nudgeRomanUrdu,/Rs 200/);
});
test("Bhao Tao NON-GROCERY cannot inherit free grocery policies",()=>{
 assert.equal(evaluate({feature:"bhao_tao",items:[g(14500)]}).code,"NON_GROCERY_POLICY_PENDING");
 assert.equal(evaluate({feature:"other",items:[g(14500)]}).code,"UNKNOWN_FEATURE");
});
test("Malformed/untrusted basket values are refused instead of rounding, guessing, or charging",()=>{
 assert.throws(()=>evaluate({feature:"apna_order",items:[g(145.5)]}),/paisa/);
 assert.throws(()=>evaluate({feature:"apna_order",items:[g(-500)]}),/paisa/);
 assert.equal(evaluate({feature:"apna_order",items:[g(14500)],discountPaisa:15500}).code,"INVALID_DISCOUNT");
 assert.equal(evaluate({feature:"apna_order",items:[]}).code,"EMPTY_CART");
 assert.equal(evaluate({feature:"community_bulk_buying",items:[g(120000)]}).code,"WRONG_FEATURE_CART");
 assert.throws(()=>evaluate({feature:"apna_order",items:[g(100,{quantity:0})]}),/invalid cart line/);
});
