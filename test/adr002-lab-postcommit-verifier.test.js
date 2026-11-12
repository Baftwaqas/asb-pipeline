"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const {postCommitEvidence,syntheticUnsentBillVersions}=
  require("../checkout/lab-apna-postcommit-verifier-v1");
const {ORDER,CYCLE}=require("../checkout/lab-apna-signed-amendment-pg-v1");
const PKR=p=>({shopMoney:{amount:(p/100).toFixed(2),currencyCode:"PKR"}});
const o=()=>({
  id:ORDER,test:true,edited:true,
  tags:["ASB-LAB-ONLY","NEVER-FULFILL","ASB-ADR002",
    "ASB-APNA-AMENDMENT-TARGET","ASB-CYCLE-"+CYCLE],
  currencyCode:"PKR",displayFinancialStatus:"PENDING",
  displayFulfillmentStatus:"UNFULFILLED",
  currentTotalPriceSet:PKR(13500),totalOutstandingSet:PKR(13500),
  currentSubtotalPriceSet:PKR(13500),currentTotalTaxSet:PKR(0),
  currentTotalDiscountsSet:PKR(0),currentShippingPriceSet:PKR(0),
  totalReceivedSet:PKR(0),
  lineItems:{pageInfo:{hasNextPage:false},nodes:[
    {id:"gid://shopify/LineItem/1",quantity:1,unfulfilledQuantity:1,
      variant:{id:"gid://shopify/ProductVariant/69644381683746"},
      customAttributes:[
        {key:"_asb_door",value:"apna_order"},
        {key:"_asb_product",value:"ASB-CANON-ONION"},
        {key:"_asb_qty",value:"500"},
        {key:"_asb_line_id",value:"LAB-APNA-ONION-500"}
      ]},
    {id:"gid://shopify/LineItem/2",quantity:1,unfulfilledQuantity:1,
      variant:{id:"gid://shopify/ProductVariant/69644381716514"},
      customAttributes:[]}
  ]}
});
test("strict independent Shopify readback recognizes exactly 500g + 1kg, Rs135 due",()=>{
  const evidence=postCommitEvidence(o());
  assert.equal(evidence.fact.orderTotalPaisa,13500);
  assert.equal(evidence.fact.outstandingPaisa,13500);
  assert.equal(evidence.fact.variants.length,2);
  assert.match(evidence.digest,/^[a-f0-9]{64}$/);
});
test("wrong total, tax, fee, discounts, payments or missing edits block reconciliation",()=>{
  for(const change of [
    {currentTotalPriceSet:PKR(14000)},
    {totalOutstandingSet:PKR(9000)},
    {currentTotalTaxSet:PKR(100)},
    {currentShippingPriceSet:PKR(100)},
    {currentTotalDiscountsSet:PKR(50)},
    {totalReceivedSet:PKR(4500)},
    {edited:false},
    {test:false},
    {displayFinancialStatus:"PAID"},
    {displayFulfillmentStatus:"FULFILLED"}
  ])assert.throws(()=>postCommitEvidence({...o(),...change}),
    /LAB_COMMIT_/);
});
test("missing line, duplicate variant, wrong SKU variant or partial fulfillment blocks",()=>{
  for(const updated of [
    {lineItems:{...o().lineItems,nodes:[o().lineItems.nodes[0]]}},
    {lineItems:{...o().lineItems,pageInfo:{hasNextPage:true}}},
    {lineItems:{...o().lineItems,nodes:[
      o().lineItems.nodes[0],{...o().lineItems.nodes[0],id:"gid://shopify/LineItem/3"}]}},
    {lineItems:{...o().lineItems,nodes:[
      o().lineItems.nodes[0],{...o().lineItems.nodes[1],unfulfilledQuantity:0}]}},
    {lineItems:{...o().lineItems,nodes:[
      o().lineItems.nodes[0],{...o().lineItems.nodes[1],
        variant:{id:"gid://shopify/ProductVariant/999"}}]}}
  ])assert.throws(()=>postCommitEvidence({...o(),...updated}),/LAB_COMMIT_/);
});
test("original 500g provenance cannot disappear after Shopify commit",()=>{
  const line={...o().lineItems.nodes[0],customAttributes:[]};
  assert.throws(()=>postCommitEvidence({...o(),lineItems:{
    ...o().lineItems,nodes:[line,o().lineItems.nodes[1]]
  }}),/LAB_COMMIT_ORIGINAL_LINE_PROVENANCE_CHANGED/);
});
test("two immutable synthetic bill versions are UNSENT, preserve provenance and previous digest",()=>{
  const evidence=postCommitEvidence(o());
  const first={lineId:"LAB-APNA-ONION-500",door:"apna_order",
    qty:500,quotedLinePaisa:4500};
  const second={lineId:"LAB-APNA-ONION-1KG-ADDITION",door:"apna_order",
    qty:1000,quotedLinePaisa:9000};
  const packet={schemaVersion:"ASB_LAB_SYNTHETIC_AUTH_ONLY_V1",
    consentMode:"SYNTHETIC_OPERATOR_LAB_ONLY",realCustomerConsent:false,
    customerNotificationApproved:false,originalTotalPaisa:4500,
    additionalPaisa:9000,proposedTotalPaisa:13500,
    shopifyOrderGid:ORDER,originalLines:[first],proposedLines:[first,second]};
  const bills=syntheticUnsentBillVersions({
    attemptId:"00000000-0000-0000-0000-000000000123",
    packet,evidence,originalQuoteDigest:"a".repeat(64)
  }).versions;
  assert.deepEqual(bills.map(x=>[x.version,x.totalPaisa,x.state]),[
    [1,4500,"source_checkout_not_sent"],
    [2,13500,"reconciled_draft_not_sent"]
  ]);
  assert.equal(bills[1].snapshot.customerNotified,false);
  assert.equal(bills[1].snapshot.sendAuthorized,false);
  assert.equal(bills[1].snapshot.supersedesDigest,bills[0].sha256);
  assert.deepEqual(bills[1].snapshot.groupedByDoor,
    {apna_order:["LAB-APNA-ONION-500","LAB-APNA-ONION-1KG-ADDITION"]});
});
