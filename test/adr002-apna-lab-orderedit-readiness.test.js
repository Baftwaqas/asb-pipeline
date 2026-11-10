"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {evaluateLabOrderEditReadiness,SCOPE_QUERY}=
  require("../checkout/apna-lab-orderedit-readiness-v1");
const shop="asb-checkout-lab.myshopify.com";
const order={id:"gid://shopify/Order/1000000001",
  tags:["ASB-ADR002","ASB-COD","ASB-CYCLE-THU-2026-11-12",
    "ASB-LAB-ONLY","NEVER-FULFILL"],
  financialStatus:"PENDING",fulfillmentStatus:"UNFULFILLED",
  currencyCode:"PKR"};
const cycle={code:"THU-2026-11-12",status:"open",verifiedFromDb:true,
  opensAt:"2026-11-09T00:00:00Z",locksAt:"2026-11-11T16:00:00Z",
  deliveryDate:"2026-11-12"};
const full={shopDomain:shop,order,cycle,nowIso:"2026-11-10T06:30:00Z",
  sourceVerified:true,dbClockVerified:true,
  accessScopes:["read_products","read_orders","write_order_edits"],
  scopesVerifiedByTargetApp:true,originalBillVerified:true,
  customerConsentVerified:true,signedAmendmentVerified:true};
function inspect(over={}){return evaluateLabOrderEditReadiness({...full,...over});}
test("read-only lab readiness never authorizes mutation, even when all checks pass",()=>{
  const r=inspect();
  assert.equal(r.status,"READ_ONLY_PRECHECK_ONLY");
  assert.deepEqual(r.blockers,[]);
  assert.equal(r.mayCommit,false);
  assert.equal(r.maySendBill,false);
  assert.equal(r.mayRequestScopes,false);
  assert.match(SCOPE_QUERY,/currentAppInstallation.*accessScopes.*handle/);
});
test("actual lab order context from Nov 9 cycle fails as stale on Nov 10",()=>{
  const actual={...order,tags:[...order.tags.filter(x=>!x.startsWith("ASB-CYCLE-")),
      "ASB-CYCLE-MON-2026-11-09"]};
  const r=inspect({order:actual,cycle:{...cycle,code:"MON-2026-11-09",
    deliveryDate:"2026-11-09",opensAt:"2026-11-06T00:00:00Z",
    locksAt:"2026-11-08T16:00:00Z",status:"locked"}});
  assert.equal(r.status,"BLOCKED");
  assert.ok(r.blockers.includes("BOOKING_CYCLE_NOT_OPEN"));
  assert.ok(r.blockers.includes("BOOKING_CUTOFF_REACHED_OR_UNVERIFIED"));
  assert.ok(r.blockers.includes("DELIVERY_CYCLE_ALREADY_PASSED"));
});
test("only read_products, as declared in the checked-in app config, does not suffice",()=>{
  const r=inspect({accessScopes:["read_products"]});
  assert.equal(r.status,"BLOCKED");
  assert.ok(r.blockers.includes("APP_SCOPE_MISSING_write_order_edits"));
  assert.ok(r.blockers.includes("APP_SCOPE_MISSING_read_orders"));
});
test("another connector's scopes cannot substitute for the target app's verified grants",()=>{
  const r=inspect({scopesVerifiedByTargetApp:false});
  assert.ok(r.blockers.includes("TARGET_APP_GRANTED_SCOPES_NOT_CHECKED"));
});
test("no modifying an untagged, paid, fulfilled, currency-mismatched or other-store order",()=>{
  for(const o of [{order:{...order,tags:[]}},
    {order:{...order,financialStatus:"PAID"}},
    {order:{...order,fulfillmentStatus:"FULFILLED"}},
    {order:{...order,currencyCode:"USD"}},
    {shopDomain:"asb-prod.myshopify.com"}]){
    const r=inspect(o);
    assert.equal(r.status,"BLOCKED");
    assert.equal(r.mayCommit,false);
  }
});
test("fail closed without authoritative database clock, consent, original bill, signed quote",()=>{
  for(const changes of [{dbClockVerified:false},
    {nowIso:"invalid-time"},{originalBillVerified:false},
    {customerConsentVerified:false},{signedAmendmentVerified:false},
    {cycle:{...cycle,verifiedFromDb:false}}]){
    const r=inspect(changes);
    assert.equal(r.status,"BLOCKED");
    assert.equal(r.mayCommit,false);
  }
});
test("orders claiming a different delivery cycle tag cannot be edited",()=>{
  const r=inspect({order:{...order,tags:[
    ...order.tags.filter(x=>!x.startsWith("ASB-CYCLE-")),
    "ASB-CYCLE-MON-2026-11-16"]}});
  assert.ok(r.blockers.includes("ORDER_CYCLE_TAG_MISMATCH"));
});
