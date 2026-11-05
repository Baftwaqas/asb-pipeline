"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const {evaluateApnaCycleLimits} = require("../grocery/apna-limits");

const H = "household-1", C = "MON-2026-11-09";
const limits = {ONION:{unit:"g",maxQuantity:2000},GINGER:{unit:"g",maxQuantity:500},
  EGG:{unit:"pcs",maxQuantity:12}};
const apna = (id, qty, extras={}) => ({productId:id, quantityBaseUnits:qty,
  unit:id==="EGG"?"pcs":"g", door:"apna_order", ...extras});
const previous = (id, qty, extras={}) => ({...apna(id,qty), householdKey:H, cycleCode:C,
  orderId:"order-1", status:"confirmed", ...extras});
const check = (incomingLines, existingCycleLines=[], extras={}) =>
  evaluateApnaCycleLimits({householdKey:H,cycleCode:C,incomingLines,existingCycleLines,
    limitsByProduct:limits,...extras});

test("allows quantity exactly at cap",()=>assert.equal(check([apna("ONION",2000)]).allowed,true));
test("blocks a quantity above cap",()=>assert.equal(check([apna("ONION",2001)]).violations[0].code,"APNA_CYCLE_MAX_EXCEEDED"));
test("aggregates separate Shopify variants by canonical product ID",()=>{
  const r=check([apna("ONION",1250,{variantId:"a"}),apna("ONION",800,{variantId:"b"})]);
  assert.equal(r.violations[0].totalQuantity,2050);
});
test("blocks splitting purchases into multiple orders in one cycle",()=>{
  assert.equal(check([apna("ONION",750)],[previous("ONION",1500)]).allowed,false);
});
test("other households do not share the cap",()=>{
  assert.equal(check([apna("ONION",750)],[previous("ONION",1500,{householdKey:"other"})]).allowed,true);
});
test("Monday and Thursday are different cycles",()=>{
  assert.equal(check([apna("ONION",750)],[previous("ONION",1500,{cycleCode:"THU-2026-11-12"})]).allowed,true);
});
test("cancelled orders do not consume cap",()=>{
  assert.equal(check([apna("ONION",750)],[previous("ONION",1500,{status:"cancelled"})]).allowed,true);
});
test("pending orders consume cap, to avoid split-order race",()=>{
  assert.equal(check([apna("ONION",750)],[previous("ONION",1500,{status:"pending"})]).allowed,false);
});
test("edits exclude prior version of same order",()=>{
  assert.equal(check([apna("ONION",2000)],[previous("ONION",1500)],{editingOrderId:"order-1"}).allowed,true);
});
test("edits still include other active orders",()=>{
  assert.equal(check([apna("ONION",2000)],[previous("ONION",1500,{orderId:"order-2"})],{editingOrderId:"order-1"}).allowed,false);
});
test("Dish-to-Cart can have 3kg when Apna is limited to 2kg",()=>{
  const r=check([apna("ONION",2000),apna("ONION",3000,{door:"dish_to_cart"})]);
  assert.equal(r.allowed,true);
});
test("no Apna line means no Apna restriction, regardless of other doors",()=>{
  assert.deepEqual(check([apna("ONION",3000,{door:"dish_to_cart"})]),{allowed:true,violations:[],products:[]});
});
test("pieces enforce piece caps",()=>{
  assert.equal(check([apna("EGG",2)],[previous("EGG",11)]).allowed,false);
});
test("rejects mismatched measurement units",()=>{
  assert.throws(()=>check([apna("ONION",2,{unit:"kg"})]),/UNIT_MISMATCH/);
});
test("unknown/unconfigured SKU fails closed",()=>{
  assert.throws(()=>check([apna("UNKNOWN",1)]),/MISSING_APNA_LIMIT/);
});
test("rejects invalid quantities",()=>{
  for(const n of [0,-1,0.25,NaN]) assert.throws(()=>check([apna("ONION",n)]),/positive safe integer/);
});
test("no minimum order or small quantity floor is imposed here",()=>{
  assert.equal(check([apna("GINGER",40)]).allowed,true);
});
test("overflow fails closed",()=>{
  const huge={...limits, ONION:{unit:"g",maxQuantity:Number.MAX_SAFE_INTEGER}};
  assert.throws(()=>check([apna("ONION",Number.MAX_SAFE_INTEGER),apna("ONION",1)],[],{limitsByProduct:huge}),/overflow/);
});
