// ASB Phase 3 PostgreSQL 18 scratch test. Never touches Neon or Shopify.
"use strict";
const {before,after,test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const {Pool}=require("pg");
const H=require("./support/harness");
const {canonical}=require("../checkout/quote-crypto-v1");
const {createPgAmendmentBillSimulation}=
  require("../checkout/apna-amendment-bill-simulation-pg-v1");
const {validateReservedProposal,validateSimulatedPreview,
  simulateBillReconciliation}=
  require("../checkout/apna-amendment-orderedit-simulation-v1");

const SHOP="asb-checkout-lab.myshopify.com";
const ORDER="gid://shopify/Order/900123";
const V500="gid://shopify/ProductVariant/55001";
const V1000="gid://shopify/ProductVariant/55002";
const sha=x=>crypto.createHash("sha256").update(canonical(x),"utf8").digest("hex");
const bag=amount=>({shopMoney:{currencyCode:"PKR",amount}});
const old={lineId:"L-ORIG",door:"apna_order",canonicalProductId:"ASB-CANON-ONION",
  unit:"g",qty:500,shopifyVariantGid:V500,
  quotedLinePaisa:4500,ceilingLinePaisa:4500};
const added={...old,lineId:"L-NEW",shopifyVariantGid:V1000,qty:1000,
  quotedLinePaisa:9000,ceilingLinePaisa:9000};
const originalBill={shopifyOrderGid:ORDER,version:1,state:"sent",
  currency:"PKR",totalPaisa:4500,lines:[old]};
const sourceOrder={id:ORDER,displayFinancialStatus:"PENDING",
  displayFulfillmentStatus:"UNFULFILLED",
  currentTotalPriceSet:bag("45.00"),totalOutstandingSet:bag("45.00")};
const bindings=[{shopDomain:SHOP,variantGid:V1000,
  canonicalProductId:"ASB-CANON-ONION",unit:"g",packQuantity:1000,
  pricePaisa:9000,active:true}];
let pool,id,quoteId,reservation,snapshot;
function productDay(){
  const d=new Date(Date.now()+6*86400000);
  d.setUTCHours(0,0,0,0);
  while(d.getUTCDay()!==1)d.setUTCDate(d.getUTCDate()+1);
  return d.toISOString().slice(0,10);
}
function service(){return createPgAmendmentBillSimulation({
  pool,shopDomain:SHOP,devDomainAllowlist:[SHOP]});}
function simulated(){
  const plan=validateReservedProposal({
    reservation,originalOrder:sourceOrder,variantBindings:bindings,
    existingBill:originalBill,shopifyVerified:true,bindingsVerified:true,policyVerified:true
  });
  const preview=validateSimulatedPreview({
    plan,calculatedOrder:{id:"gid://shopify/CalculatedOrder/901",
      totalPriceSet:bag("135.00")},simulationOnly:true
  });
  return simulateBillReconciliation({
    plan,preview,shopifyCommitPayload:{userErrors:[],order:{
      ...sourceOrder,currentTotalPriceSet:bag("135.00"),
      totalOutstandingSet:bag("135.00")}},
    existingBill:originalBill,simulationOnly:true
  });
}
before(async()=>{
  const url=await H.createDatabase("asb_test_apna_amendment_bill_sim",
    path.join(__dirname,".."),{grocery:false});
  pool=new Pool({connectionString:url,max:8});
  // Both migrations are held in real environments; apply explicitly ONLY
  // in this newly created disposable PostgreSQL database.
  for(const name of ["026_apna_amendment_reservations.sql",
    "027_apna_amendment_bill_simulations.sql"])
    await pool.query(fs.readFileSync(path.join(__dirname,"..","db","migrations",name),"utf8"));
  const day=productDay(),cycle="MON-"+day;
  quoteId="LAB-AMEND-SIM-QUOTE";
  snapshot={originalQuoteId:quoteId,proposalId:"LAB-AMEND-SIM-PROPOSAL",
    originalClaimId:"",originalLines:[old],proposedLines:[old,added],
    policyVersion:"SYNTHETIC-SIGNED-POLICY"};
  await pool.query(
    "INSERT INTO checkout_quotes"+
    " (quote_id,version,shop_domain,household_key,cycle_code,delivery_date,"+
    " issued_at,expires_at,signed_quote)"+
    " VALUES($1,1,$2,$3,$4,$5,clock_timestamp()-interval '1 minute',"+
    " clock_timestamp()+interval '1 hour',$6::jsonb)",
    [quoteId,SHOP,"LAB-SIM-HOUSEHOLD",cycle,day,JSON.stringify({quoteId})]);
  const claim=(await pool.query(
    "INSERT INTO checkout_redemptions"+
    " (quote_id,quote_version,shop_domain,household_key,cycle_code,"+
    " redemption_key,state,policy_version,shopify_order_gid,"+
    " expected_cod_paisa,completed_at)"+
    " VALUES($1,1,$2,$3,$4,$5,'completed','SYNTHETIC',$6,4500,clock_timestamp())"+
    " RETURNING claim_id",
    [quoteId,SHOP,"LAB-SIM-HOUSEHOLD",cycle,
      "asb-adr002-"+"a".repeat(40),ORDER])).rows[0];
  snapshot.originalClaimId=claim.claim_id;
  const inserted=(await pool.query(
    "INSERT INTO checkout_apna_amendment_reservations"+
    " (shop_domain,household_key,cycle_code,original_claim_id,"+
    " original_quote_id,shopify_order_gid,idempotency_key,snapshot_sha256,"+
    " proposed_snapshot,additional_paisa)"+
    " VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,9000) RETURNING reservation_id",
    [SHOP,"LAB-SIM-HOUSEHOLD",cycle,claim.claim_id,quoteId,ORDER,
      "asb-amendment-"+"b".repeat(40),sha(snapshot),JSON.stringify(snapshot)])).rows[0];
  id=inserted.reservation_id;
  reservation={state:"reserved_preflight",shopDomain:SHOP,
    reservationId:id,shopifyOrderGid:ORDER,originalQuoteId:quoteId,
    additionalPaisa:9000,proposedSnapshot:snapshot,snapshotSha256:sha(snapshot)};
});
after(async()=>{if(pool)await pool.end();});
test("synthetic reconciliation produces one durable version-2 bill simulation",async()=>{
  const response=await service().record({reservationId:id,reconciliation:simulated()});
  assert.equal(response.state,"simulation_only");
  assert.equal(response.idempotent,false);
  assert.equal(response.shopifyModified,false);
  assert.equal(response.billSent,false);
  const rows=(await pool.query(
    "SELECT state,original_bill_version,draft_bill_version,expected_total_paisa,"+
    " additional_paisa,draft_json FROM checkout_apna_amendment_bill_simulations")).rows;
  assert.equal(rows.length,1);
  assert.equal(rows[0].state,"simulation_only");
  assert.equal(rows[0].draft_bill_version,2);
  assert.equal(Number(rows[0].expected_total_paisa),13500);
  assert.equal(Number(rows[0].additional_paisa),9000);
  assert.equal(rows[0].draft_json.lines.length,2);
  assert.equal(rows[0].draft_json.state,"SIMULATION_DRAFT_NOT_SENT");
});
test("parallel identical retries converge to same durable synthetic record",async()=>{
  const r=simulated(),svc=service();
  const [a,b]=await Promise.all([
    svc.record({reservationId:id,reconciliation:r}),
    svc.record({reservationId:id,reconciliation:r})
  ]);
  assert.equal(a.simulationId,b.simulationId);
  assert.equal(a.idempotent,true);
  assert.equal(b.idempotent,true);
  assert.equal((await pool.query(
    "SELECT count(*)::int n FROM checkout_apna_amendment_bill_simulations")).rows[0].n,1);
});
test("tampered simulated bill, stale version and amount mismatch are denied",async()=>{
  const base=simulated();
  for(const changed of [
    {...base,draft:{...base.draft,totalPaisa:1}},
    {...base,draft:{...base.draft,billVersion:3}},
    {...base,draft:{...base.draft,lines:[old]}}
  ]){
    await assert.rejects(()=>service().record({reservationId:id,reconciliation:changed}),
      /AMENDMENT_BILL_SIMULATION_EVIDENCE_REQUIRED|AMENDMENT_BILL_INVALID_REVISION|AMENDMENT_BILL_SNAPSHOT_OR_COD_MISMATCH/);
  }
});
test("original checkout state and COD amount are never overwritten",async()=>{
  const rows=(await pool.query(
    "SELECT state,shopify_order_gid,expected_cod_paisa FROM checkout_redemptions WHERE quote_id=$1",
    [quoteId])).rows;
  assert.equal(rows.length,1);
  assert.equal(rows[0].state,"completed");
  assert.equal(rows[0].shopify_order_gid,ORDER);
  assert.equal(Number(rows[0].expected_cod_paisa),4500);
});
test("database prevents mutation or deletion of simulated evidence",async()=>{
  await assert.rejects(()=>pool.query(
    "UPDATE checkout_apna_amendment_bill_simulations SET expected_total_paisa=1"),
    /APNA_BILL_SIMULATION_IMMUTABLE/);
  await assert.rejects(()=>pool.query(
    "DELETE FROM checkout_apna_amendment_bill_simulations"),
    /APNA_BILL_SIMULATION_IMMUTABLE/);
});
test("different shop is never authorized",()=>{
  assert.throws(()=>createPgAmendmentBillSimulation({
    pool,shopDomain:"asb-production.myshopify.com",
    devDomainAllowlist:["asb-production.myshopify.com"]
  }),/AMENDMENT_BILL_LAB_ONLY/);
});
