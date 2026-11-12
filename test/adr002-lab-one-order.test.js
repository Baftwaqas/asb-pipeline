// Offline/no-network safety tests for real ASB Checkout Lab demo generation.
"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {nextEligible,buildQuote,preflight}=require("../scripts/lab-one-order-v1");
const {verifyLabFixturePolicyInTransaction,SHOP,VERSION}=
  require("../checkout/lab-fixture-policy-v1");
const {verifySignedQuote}=require("../checkout/quote-crypto-v1");
const {buildOrderCreateInput}=require("../checkout/ordercreate-v1");
const SECRET="LAB_ONLY_LONG_TEST_HMAC_SECRET_NOT_REAL_0123456789";
const DB={query:async()=>{}};
const identity={serverAuthenticated:true,phoneVerified:true,householdKey:"LAB-TEST-HOUSEHOLD-ONLY-A"};
const cycleFor=(now)=>nextEligible(now);
function testQuote(now){
  const cycle=cycleFor(now);
  const quote=buildQuote({cycle,now,secret:SECRET});
  const cycleRow={code:cycle.cycleCode,status:"open",delivery_day:cycle.deliveryDate};
  return {quote,cycle,cycleRow};
}
test("LAB: Sunday cutoff 8pm Karachi is exact and Monday rolls to Thursday",()=>{
  const before=nextEligible(new Date("2026-11-08T14:59:59Z")); // Sun 19:59:59 PKT
  const after=nextEligible(new Date("2026-11-08T15:00:00Z")); // Sun 20:00:00 PKT
  assert.deepEqual([before.cycleCode,after.cycleCode],
    ["MON-2026-11-09","THU-2026-11-12"]);
});
test("LAB: Wednesday cutoff 8pm Karachi is exact and Thursday rolls to Monday",()=>{
  const before=nextEligible(new Date("2026-11-11T14:59:59Z"));
  const after=nextEligible(new Date("2026-11-11T15:00:00Z"));
  assert.deepEqual([before.cycleCode,after.cycleCode],
    ["THU-2026-11-12","MON-2026-11-16"]);
});
test("LAB: exactly three real dev SKU GIDs, 40g ginger, committed Community 10kg",()=>{
  const now=new Date("2026-11-05T15:00:00Z");const {quote,cycle,cycleRow}=testQuote(now);
  assert.equal(verifySignedQuote(quote,SECRET),true);
  assert.equal(quote.quotedTotalPaisa,155620);
  assert.equal(quote.ceilingTotalPaisa,155620);
  assert.equal(quote.lines[1].qty,40);
  assert.equal(quote.lines[2].qty,10000);
  assert.equal(quote.lines[2].quotedLinePaisa,150000);
  assert.equal(quote.communityEligibilityByDoor.community_order.qualifyingCeilingPaisa>=120000,true);
  const status=verifyLabFixturePolicyInTransaction({db:DB,quote,identity,shopDomain:SHOP,
    cycle:cycleRow,dbNow:now});
  assert.deepEqual(status,{approved:true,policyVersion:VERSION});
  const customer={householdKey:identity.householdKey,phone:"923000000000",
    addressVerified:true,firstName:"ASB",lastName:"LAB ONLY",
    shippingAddress:{address1:"LAB ONLY DO NOT DELIVER",city:"Karachi",countryCode:"PK"}};
  const order=buildOrderCreateInput({quote,customer,redemptionKey:"asb-adr002-"+
    "a".repeat(40),taxesDisabledApproved:true});
  assert.equal(order.expectedCodPaisa,155600);
  assert.equal(order.roundingCreditPaisa,20);
  assert.deepEqual(order.variables.order.lineItems.map(x=>x.quantity),[1,1,1]);
  assert.deepEqual(order.variables.order.lineItems.map(x=>x.priceSet.shopMoney.amount),
    ["45.00","11.20","1499.80"]);
  assert.equal(cycle.deliveryDate,"2026-11-09");
});
test("LAB: tampered pack, prices, provenances, Community threshold refused",()=>{
  const now=new Date("2026-11-05T15:00:00Z");const {quote,cycleRow}=testQuote(now);
  const opts={db:DB,identity,shopDomain:SHOP,cycle:cycleRow,dbNow:now};
  const other=(i,change)=>({...quote,lines:quote.lines.map((l,j)=>j===i?{...l,...change}:l)});
  const wrong=[
    other(0,{qty:1000}),other(1,{quotedLinePaisa:1}),
    other(1,{provenance:{kind:"recipe",recipeIds:["FORGED"]}}),
    other(2,{heroTier:null}),other(2,{shopifyVariantGid:quote.lines[0].shopifyVariantGid}),
    {...quote,communityEligibilityByDoor:{
      community_order:{qualifyingCeilingPaisa:119999,eligible:true}}}
  ];
  for(const bad of wrong)
    assert.throws(()=>verifyLabFixturePolicyInTransaction({...opts,quote:bad}),/LAB_/);
});
test("LAB: preflight requires exact dev DB host and explicit approval",()=>{
  const backup={...process.env};
  try{
    Object.assign(process.env,{ASB_LAB_SHOP_DOMAIN:SHOP,ASB_LAB_WRITE_MODE:"disabled",
      ASB_ENV:"development",DATABASE_URL:"postgres://lab:pass@dpg-dbm8v3qjnfac738pc31g-a.internal/asb_checkout_lab_pg18",
      ASB_MUTATION_DB_HOST:"db.lab.internal",
      ASB_MUTATION_DB_NAME:"asb_checkout_lab_pg18",
      ASB_LAB_APP_CLIENT_ID:"TEST-ID-12345",
      ASB_LAB_APP_CLIENT_SECRET:"TEST-SECRET-123456789",
      ASB_QUOTE_SECRET:SECRET,
      ASB_LAB_CLI_APPROVAL:"ASB_LAB_ONLY_ONE_TEST_ORDER"});
    // process.argv from node test has neither --check-only nor an explicit
    // manual --create-single-order command; it MUST fail closed.
    assert.throws(()=>preflight(),/EXPLICIT_MANUAL_SINGLE_ORDER_APPROVAL_REQUIRED/);
    process.env.DATABASE_URL="postgres://lab:pass@neon.production.example/asb_checkout_lab_pg18";
    assert.throws(()=>preflight(),/LAB_MUST_USE_OWN_ISOLATED_RENDER_DATABASE/);
    process.env.DATABASE_URL="postgres://lab:pass@dpg-dbm8v3qjnfac738pc31g-a.internal/asb_checkout_lab_pg18";
    process.env.ASB_LAB_SHOP_DOMAIN="some-other-store.myshopify.com";
    assert.throws(()=>preflight(),/LAB_MODE_OR_DOMAIN_GUARD_REFUSED/);
  }finally{
    // Never alter the CI runner's process env for later tests.
    for(const key of Object.keys(process.env))
      if(!(key in backup))delete process.env[key];
    Object.assign(process.env,backup);
  }
});
