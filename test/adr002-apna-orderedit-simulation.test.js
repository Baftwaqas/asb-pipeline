"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const crypto=require("node:crypto");
const {canonical}=require("../checkout/quote-crypto-v1");
const {validateReservedProposal,validateSimulatedPreview,
  simulateBillReconciliation,GRAPHQL}=
  require("../checkout/apna-amendment-orderedit-simulation-v1");
const SHOP="asb-checkout-lab.myshopify.com";
const ORDER="gid://shopify/Order/900123";
const V500="gid://shopify/ProductVariant/55001";
const V1000="gid://shopify/ProductVariant/55002";
const CALC="gid://shopify/CalculatedOrder/12345";
const ORIGINAL={lineId:"L-ORIG",door:"apna_order",
  canonicalProductId:"ASB-CANON-ONION",unit:"g",qty:500,
  shopifyVariantGid:V500,quotedLinePaisa:4500,ceilingLinePaisa:4500};
const ADDED={...ORIGINAL,lineId:"L-ADDED",qty:1000,
  shopifyVariantGid:V1000,quotedLinePaisa:9000,ceilingLinePaisa:9000};
const snapshot={originalQuoteId:"Q1",proposalId:"P1",
  originalClaimId:"11111111-1111-1111-1111-111111111111",
  originalLines:[ORIGINAL],proposedLines:[ORIGINAL,ADDED],
  policyVersion:"signed-policy-lab-only"};
const digest=x=>crypto.createHash("sha256").update(canonical(x),"utf8").digest("hex");
const reservation={state:"reserved_preflight",shopDomain:SHOP,
  reservationId:"22222222-2222-2222-2222-222222222222",
  shopifyOrderGid:ORDER,originalQuoteId:"Q1",
  additionalPaisa:9000,proposedSnapshot:snapshot,
  snapshotSha256:digest(snapshot)};
const rupees=p=>(p/100).toFixed(2);
const bag=p=>({shopMoney:{amount:rupees(p),currencyCode:"PKR"}});
const existingBill={shopifyOrderGid:ORDER,version:1,state:"sent",currency:"PKR",
  totalPaisa:4500,lines:[ORIGINAL]};
const order={id:ORDER,displayFinancialStatus:"PENDING",
  displayFulfillmentStatus:"UNFULFILLED",
  currentTotalPriceSet:bag(4500),totalOutstandingSet:bag(4500)};
const bindings=[{shopDomain:SHOP,variantGid:V500,
  canonicalProductId:"ASB-CANON-ONION",unit:"g",packQuantity:500,
  pricePaisa:4500,active:true},
  {shopDomain:SHOP,variantGid:V1000,
  canonicalProductId:"ASB-CANON-ONION",unit:"g",packQuantity:1000,
  pricePaisa:9000,active:true}];
const ctx={reservation,originalOrder:order,variantBindings:bindings,
  existingBill,shopifyVerified:true,bindingsVerified:true,policyVerified:true};
function plan(over={}){return validateReservedProposal({...ctx,...over});}
function preview(p,amount=13500){return validateSimulatedPreview({
  plan:p,calculatedOrder:{id:CALC,totalPriceSet:bag(amount)},simulationOnly:true});
}
function commitPayload(total=13500){return {userErrors:[],order:{
  ...order,currentTotalPriceSet:bag(total),totalOutstandingSet:bag(total)}};}
function reconciled(p,v,payload=commitPayload(),bill=existingBill){
  return simulateBillReconciliation({plan:p,preview:v,
    shopifyCommitPayload:payload,existingBill:bill,simulationOnly:true});
}
test("valid approved 500g+1kg Apna Onion plan generates Shopify count=1, never grams",()=>{
  const p=plan();
  assert.equal(p.mode,"SIMULATION_ONLY_NOT_AUTHORIZED");
  assert.deepEqual(p.additions,[{lineId:"L-ADDED",variantId:V1000,
    quantity:1,gramsOrPieces:1000,expectedPricePaisa:9000}]);
  assert.equal(p.expectedFinalPaisa,13500);
  assert.equal(p.commitVariables.notifyCustomer,false);
  assert.match(GRAPHQL.BEGIN,/orderEditBegin/);
  assert.match(GRAPHQL.ADD,/orderEditAddVariant/);
  assert.match(GRAPHQL.COMMIT,/orderEditCommit/);
});
test("Shopify variant counts may be multiple packs, but quoted money must match",()=>{
  const extra={...ADDED,shopifyVariantGid:V500};
  const snap={...snapshot,proposedLines:[ORIGINAL,extra]};
  const r={...reservation,proposedSnapshot:snap,snapshotSha256:digest(snap)};
  const p=plan({reservation:r});
  assert.equal(p.additions[0].quantity,2);
});
test("precommit preview at exact PKR amount returns no commit authorization",()=>{
  const p=plan(),v=preview(p);
  assert.equal(v.state,"precommit_preview_matches_not_committed");
  assert.equal(v.expectedTotalPaisa,13500);
  assert.throws(()=>preview(p,13600),/AMENDMENT_CALCULATED_TOTAL_MISMATCH/);
  assert.throws(()=>validateSimulatedPreview({plan:p,
    calculatedOrder:{id:CALC,totalPriceSet:bag(13500)}}),/AMENDMENT_SIMULATION_ONLY/);
});
test("simulated reconciled bill retains original lines, version and door provenance",()=>{
  const p=plan(),v=preview(p),result=reconciled(p,v);
  assert.equal(result.state,"SIMULATED_RECONCILED_NOT_COMMITTED_NOT_SENT");
  assert.equal(result.shopifyModified,false);
  assert.equal(result.billSent,false);
  assert.equal(result.draft.billVersion,2);
  assert.equal(result.draft.replacesBillVersion,1);
  assert.equal(result.draft.totalPaisa,13500);
  assert.deepEqual(result.draft.lines,[ORIGINAL,ADDED]);
  assert.deepEqual(result.draft.groupedByDoor,{apna_order:["L-ORIG","L-ADDED"]});
  assert.equal(existingBill.totalPaisa,4500);
});
test("tampered immutable reserved snapshot is rejected",()=>{
  const tampered=structuredClone(reservation);
  tampered.proposedSnapshot.proposedLines[1].quotedLinePaisa=10000;
  assert.throws(()=>plan({reservation:tampered}),/AMENDMENT_RESERVATION_INTEGRITY_ERROR/);
});
test("untrusted catalog, Shopify verification or policy denies plan",()=>{
  assert.throws(()=>plan({bindingsVerified:false}),/AMENDMENT_TRUSTED_SOURCES_REQUIRED/);
  assert.throws(()=>plan({shopifyVerified:false}),/AMENDMENT_TRUSTED_SOURCES_REQUIRED/);
  assert.throws(()=>plan({policyVerified:false}),/AMENDMENT_TRUSTED_SOURCES_REQUIRED/);
});
test("closed, paid, fulfilled and incomplete COD orders are not eligible",()=>{
  for(const changed of [
    {displayFinancialStatus:"PAID"},{displayFulfillmentStatus:"FULFILLED"},
    {totalOutstandingSet:bag(0)},{currentTotalPriceSet:bag(4600)}
  ]) assert.throws(()=>plan({originalOrder:{...order,...changed}}),
    /AMENDMENT_SHOPIFY_ORDER_NOT_ELIGIBLE|AMENDMENT_SHOPIFY_OUTSTANDING_DRIFT|AMENDMENT_ORIGINAL_BILL_MISMATCH/);
});
test("changed original line, missing line and stale existing bill all fail",()=>{
  const change=(lines)=>{
    const s={...snapshot,proposedLines:lines};
    return {...reservation,proposedSnapshot:s,snapshotSha256:digest(s)};
  };
  assert.throws(()=>plan({reservation:change([ADDED])}),
    /AMENDMENT_ORIGINAL_LINE_MUTATION/);
  assert.throws(()=>plan({reservation:change([{...ORIGINAL,qty:1000},ADDED])}),
    /AMENDMENT_ORIGINAL_LINE_MUTATION/);
  assert.throws(()=>plan({existingBill:{...existingBill,version:0}}),
    /AMENDMENT_ORIGINAL_BILL_MISMATCH/);
});
test("cross-door additions, unverified packs and price drift fail before any edit",()=>{
  const change=(x)=>{
    const s={...snapshot,proposedLines:[ORIGINAL,x]};
    return {...reservation,proposedSnapshot:s,snapshotSha256:digest(s)};
  };
  assert.throws(()=>plan({reservation:change({...ADDED,door:"community_order"})}),
    /AMENDMENT_ADDITION_NOT_APNA/);
  assert.throws(()=>plan({variantBindings:bindings.filter(x=>x.variantGid!==V1000)}),
    /AMENDMENT_VARIANT_PACK_MISMATCH/);
  assert.throws(()=>plan({variantBindings:bindings.map(x=>x.variantGid===V1000?
    {...x,pricePaisa:9500}:x)}),/AMENDMENT_SHOPIFY_VARIANT_PRICE_DRIFT/);
});
test("commit response user errors, wrong order, outstanding drift all block revised bill",()=>{
  const p=plan(),v=preview(p);
  assert.throws(()=>reconciled(p,v,{...commitPayload(),userErrors:[{message:"stock"}]}),
    /AMENDMENT_COMMIT_OUTCOME_UNCERTAIN/);
  assert.throws(()=>reconciled(p,v,{...commitPayload(),order:{...commitPayload().order,
    id:"gid://shopify/Order/999"}}),/AMENDMENT_COMMIT_ORDER_STATE_MISMATCH/);
  assert.throws(()=>reconciled(p,v,{...commitPayload(),order:{...commitPayload().order,
    totalOutstandingSet:bag(14000)}}),/AMENDMENT_COMMIT_TOTAL_MISMATCH/);
  assert.throws(()=>reconciled(p,v,commitPayload(),{...existingBill,version:2}),
    /AMENDMENT_STALE_BILL_VERSION/);
});
test("no production store, no bill send and no authorization by default",()=>{
  assert.throws(()=>plan({reservation:{...reservation,shopDomain:
    "apnasastabazaar.myshopify.com"}}),/AMENDMENT_INVALID_RESERVATION/);
  assert.throws(()=>simulateBillReconciliation({plan:plan(),preview:preview(plan()),
    shopifyCommitPayload:commitPayload(),existingBill}),/AMENDMENT_SIMULATION_ONLY/);
});
