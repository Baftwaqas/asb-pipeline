"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const {nextMondayCycle,buildQuote,preflight}=require("../scripts/lab-apna-onion-order-v1");
const {verifyLabApnaOnionOnlyInTransaction,SHOP,CANONICAL}=
  require("../checkout/lab-apna-onion-only-policy-v1");
const {buildOrderCreateInput}=require("../checkout/ordercreate-v1");
const secret="LAB_FAKE_QUOTE_SECRET_0123456789_0123456789";
const monday=nextMondayCycle(new Date("2026-11-12T05:35:00.000Z"));
function quote(){return buildQuote(monday,new Date("2026-11-12T05:35:00.000Z"),secret);}
function verdict(q=quote()){
  return verifyLabApnaOnionOnlyInTransaction({
    db:{query:async()=>({rows:[]})},quote:q,shopDomain:SHOP,
    identity:{serverAuthenticated:true,phoneVerified:true,
      householdKey:q.customerReference},
    cycle:{code:q.cycleCode,status:"open",delivery_day:q.deliveryDate},
    dbNow:new Date("2026-11-12T05:35:00.000Z")
  });
}
test("Thursday after 9am delivery cutoff selects Monday Nov 16; Sunday 9pm cutoff",()=>{
  assert.equal(monday.cycleCode,"MON-2026-11-16");
  assert.equal(monday.cutoff.toISOString(),"2026-11-15T16:00:00.000Z");
});
test("exact 500g/PKR45 single Apna line canonical mapping passes",()=>{
  const q=quote();assert.equal(verdict(q).approved,true);
  assert.equal(q.lines.length,1);
  assert.equal(q.lines[0].canonicalProductId,CANONICAL);
  assert.equal(q.lines[0].door,"apna_order");
  assert.equal(q.quotedTotalPaisa,4500);
  assert.equal(q.communityEligibilityByDoor.community_order.eligible,false);
});
test("server bill and Shopify creation adapter preserve correct Rs45 synthetic variant",()=>{
  const q=quote();
  const customer={householdKey:q.customerReference,phone:"923000000000",
    addressVerified:true,firstName:"ASB",lastName:"TEST",
    shippingAddress:{address1:"ASB TEST NEVER DELIVER",city:"Karachi",countryCode:"PK"}};
  const payload=buildOrderCreateInput({
    quote:q,customer,redemptionKey:"asb-adr002-"+"a".repeat(40),
    taxesDisabledApproved:true
  });
  assert.equal(payload.expectedCodPaisa,4500);
  assert.equal(payload.variables.order.lineItems.length,1);
  assert.equal(payload.variables.order.lineItems[0].quantity,1);
  assert.equal(payload.variables.order.lineItems[0].priceSet.shopMoney.amount,"45.00");
  assert.equal(payload.variables.options.sendReceipt,false);
  assert.equal(payload.variables.options.sendFulfillmentReceipt,false);
  assert.equal(payload.variables.options.inventoryBehaviour,"BYPASS");
});
test("Community pack, altered canonical/price, or unexpected second line is denied",()=>{
  const q=quote();
  assert.throws(()=>verdict({...q,lines:[...q.lines,{...q.lines[0]}]}),
    /LAB_APNA_SINGLE_LINE_REQUIRED/);
  assert.throws(()=>verdict({...q,lines:[{...q.lines[0],door:"community_order"}]}),
    /LAB_APNA_DOOR_OR_PACK_MISMATCH/);
  assert.throws(()=>verdict({...q,lines:[{...q.lines[0],canonicalProductId:"ASB-LAB-ONION"}]}),
    /LAB_APNA_CANONICAL_VARIANT_MISMATCH/);
  assert.throws(()=>verdict({...q,lines:[{...q.lines[0],quotedLinePaisa:85000}]}),
    /LAB_APNA_PRICE_MISMATCH/);
});
test("wrong household, cycle or missing Community isolation is denied",()=>{
  const q=quote();
  assert.throws(()=>verdict({...q,customerReference:"ANOTHER"}),/LAB_APNA_IDENTITY_REQUIRED/);
  assert.throws(()=>verdict({...q,cycleCode:"THU-2026-11-12"}),/LAB_APNA_CYCLE_NOT_OPEN/);
  assert.throws(()=>verdict({...q,communityEligibilityByDoor:{
    community_order:{eligible:true}
  }}),/LAB_APNA_CROSS_DOOR_FORBIDDEN/);
});
test("cannot invoke order creation without exact lab shop, DB and operator approval",()=>{
  const hold={...process.env};
  try{
    delete process.env.ASB_LAB_SHOP_DOMAIN;
    assert.throws(preflight,/LAB_APNA_SHOP_OR_WRITE_MODE_UNSAFE/);
  }finally{process.env=hold;}
});
