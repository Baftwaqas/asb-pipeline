"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {evaluateApnaCycleLimits} = require("../grocery/apna-limits");

const H = "household-1", C = "MON-2026-11-09";
const limits = {
  ONION: {unit:"g", minQuantity:500, maxQuantity:2000, allowedSizes:[500,1000,2000]},
  GINGER: {unit:"g", minQuantity:125, maxQuantity:500, allowedSizes:[125,250,500]},
  EGG: {unit:"piece", minQuantity:1, maxQuantity:12, stepQuantity:1},
  CORIANDER: {unit:"piece", minQuantity:1, maxQuantity:3, allowedSizes:[1]},
  RICE: {unit:"g", minQuantity:500, maxQuantity:2000, stepQuantity:250}
};
const apna = (id, qty, extras={}) => ({
  canonicalProductId:id, qty, unit:(id==="EGG" || id==="CORIANDER")?"piece":"g",
  door:"apna_order", ...extras
});
const previous = (id, qty, extras={}) => ({
  ...apna(id,qty), householdKey:H, cycleCode:C,
  orderId:"order-1", status:"confirmed", ...extras
});
const check = (incomingLines, existingCycleLines=[], extras={}) =>
  evaluateApnaCycleLimits({householdKey:H,cycleCode:C,incomingLines,
    existingCycleLines,limitsByProduct:limits,...extras});

test("allows quantity exactly at Apna cap",()=>{
  assert.equal(check([apna("ONION",2000)]).allowed,true);
});
test("blocks quantity above cap",()=>{
  const r=check([apna("ONION",2500)]);
  assert.equal(r.violations[0].code,"APNA_CYCLE_MAX_EXCEEDED");
});
test("aggregates different Shopify variants under canonical product ID",()=>{
  const r=check([
    apna("ONION",1500,{shopifyVariantGid:"gid://shopify/ProductVariant/1"}),
    apna("ONION",1000,{shopifyVariantGid:"gid://shopify/ProductVariant/2"})
  ]);
  assert.equal(r.violations.find(v=>v.code==="APNA_CYCLE_MAX_EXCEEDED").totalQuantity,2500);
});
test("blocks split orders within the same household and cycle",()=>{
  assert.equal(check([apna("ONION",1000)],[previous("ONION",1500)]).allowed,false);
});
test("other households do not consume cap",()=>{
  assert.equal(check([apna("ONION",1000)],
    [previous("ONION",1500,{householdKey:"other"})]).allowed,true);
});
test("Monday and Thursday are separate cycles",()=>{
  assert.equal(check([apna("ONION",1000)],
    [previous("ONION",1500,{cycleCode:"THU-2026-11-12"})]).allowed,true);
});
test("cancelled orders release cap",()=>{
  assert.equal(check([apna("ONION",1000)],
    [previous("ONION",1500,{status:"cancelled"})]).allowed,true);
});
test("CX3: status is case-insensitive, so Cancelled releases cap",()=>{
  assert.equal(check([apna("ONION",1000)],
    [previous("ONION",1500,{status:"Cancelled"})]).allowed,true);
});
test("unknown status fails visibly instead of silently releasing capacity",()=>{
  assert.throws(()=>check([apna("ONION",1000)],
    [previous("ONION",1500,{status:"MysteryStatus"})]),/UNKNOWN_ORDER_STATUS/);
});
test("pending reservations consume cap against split-order race",()=>{
  assert.equal(check([apna("ONION",1000)],
    [previous("ONION",1500,{status:"pending"})]).allowed,false);
});
test("editing order excludes replaced order's previous lines",()=>{
  assert.equal(check([apna("ONION",2000)],[previous("ONION",1500)],
    {editingOrderId:"order-1"}).allowed,true);
});
test("editing order still counts other orders",()=>{
  assert.equal(check([apna("ONION",2000)],
    [previous("ONION",1500,{orderId:"order-2"})],
    {editingOrderId:"order-1"}).allowed,false);
});
test("Dish-to-Cart 3 kg independent of Apna's 2 kg onion maximum",()=>{
  assert.equal(check([apna("ONION",2000),apna("ONION",3000,{door:"dish_to_cart"})]).allowed,true);
});
test("Dish-to-Cart 40 g ginger allowed when Apna minimum is 125 g",()=>{
  assert.deepEqual(check([apna("GINGER",40,{door:"dish_to_cart"})]),
    {allowed:true,violations:[],products:[]});
});
test("CX1: Apna 40 g ginger rejected below product minimum",()=>{
  const r=check([apna("GINGER",40)]);
  assert.equal(r.allowed,false);
  assert.equal(r.violations[0].code,"APNA_BELOW_PRODUCT_MINIMUM");
});
test("no minimum basket TOTAL: an individual 125 g Apna pack passes",()=>{
  assert.equal(check([apna("GINGER",125)]).allowed,true);
});
test("combining 125 g + 250 g approved packs permits 375 g",()=>{
  assert.equal(check([apna("GINGER",375)]).allowed,true);
});
test("onion 750 g cannot be assembled from approved 500/1000/2000 g packs",()=>{
  const r=check([apna("ONION",750)]);
  assert.equal(r.allowed,false);
  assert.equal(r.violations[0].code,"APNA_NOT_AN_APPROVED_SIZE");
});
test("any quantity at a configured Apna step within limits is permitted",()=>{
  assert.equal(check([apna("RICE",750)]).allowed,true);
  assert.equal(check([apna("RICE",800)]).violations[0].code,"APNA_NOT_AN_APPROVED_SIZE");
});
test("piece units work end to end for eggs",()=>{
  assert.equal(check([apna("EGG",2)],[previous("EGG",11)]).allowed,false);
  assert.equal(check([apna("EGG",12)]).allowed,true);
});
test("CX2: accepted contract uses 'piece', not 'pcs'",()=>{
  assert.equal(check([apna("CORIANDER",1)]).allowed,true);
  assert.throws(()=>check([apna("EGG",1,{unit:"pcs"})]),/UNIT_MISMATCH/);
});
test("invalid units are rejected against trusted product rule",()=>{
  assert.throws(()=>check([apna("ONION",1000,{unit:"kg"})]),/UNIT_MISMATCH/);
});
test("unknown product rule fails closed",()=>{
  assert.throws(()=>check([apna("UNKNOWN",1)]),/MISSING_APNA_LIMIT/);
});
test("missing minimum or ladder fails closed",()=>{
  assert.throws(()=>check([apna("GINGER",125)],[],{limitsByProduct:{
    ...limits,GINGER:{unit:"g",maxQuantity:500,allowedSizes:[125,250]}
  }}),/positive safe integer/);
  assert.throws(()=>check([apna("GINGER",125)],[],{limitsByProduct:{
    ...limits,GINGER:{unit:"g",minQuantity:125,maxQuantity:500}
  }}),/APNA_LADDER_REQUIRED/);
});
test("invalid quantities fail closed",()=>{
  for(const n of [0,-1,0.25,NaN]) {
    assert.throws(()=>check([apna("ONION",n)]),/positive safe integer/);
  }
});
test("duplicate and out-of-range allowed pack sizes are validated",()=>{
  assert.equal(check([apna("GINGER",375)],[],{limitsByProduct:{
    ...limits,GINGER:{unit:"g",minQuantity:125,maxQuantity:500,allowedSizes:[250,125,125,500]}
  }}).allowed,true);
  assert.throws(()=>check([apna("GINGER",125)],[],{limitsByProduct:{
    ...limits,GINGER:{unit:"g",minQuantity:125,maxQuantity:500,allowedSizes:[250,500]}
  }}),/allowedSizes must include minimum/);
});
test("large sums overflow instead of wrapping",()=>{
  const huge={...limits,ONION:{unit:"g",minQuantity:1,
    maxQuantity:Number.MAX_SAFE_INTEGER,stepQuantity:1}};
  assert.throws(()=>check([apna("ONION",Number.MAX_SAFE_INTEGER),
    apna("ONION",1)],[],{limitsByProduct:huge}),/quantity overflow/);
});
test("empty Apna selection does not invent a basket minimum",()=>{
  assert.deepEqual(check([apna("GINGER",40,{door:"dish_to_cart"})]),
    {allowed:true,violations:[],products:[]});
});
