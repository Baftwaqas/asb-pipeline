// ASB Phase 4: real PostgreSQL 18 + entirely fake Shopify transport.
// No Shopify credentials, no external HTTP calls, no operational bill sending.
"use strict";
const {before,after,test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const {Pool}=require("pg");
const H=require("./support/harness");
const {canonical}=require("../checkout/quote-crypto-v1");
const {createPgMockShopifyEditCoordinator}=
  require("../checkout/apna-amendment-commit-mock-pg-v1");
const SHOP="asb-checkout-lab.myshopify.com";
const V500="gid://shopify/ProductVariant/55001";
const V1000="gid://shopify/ProductVariant/55002";
const CALC="gid://shopify/CalculatedOrder/123456";
const hash=x=>crypto.createHash("sha256").update(canonical(x),"utf8").digest("hex");
const line=(id,qty,price,variantId)=>({
  lineId:id,door:"apna_order",canonicalProductId:"ASB-CANON-ONION",
  unit:"g",qty,shopifyVariantGid:variantId,
  quotedLinePaisa:price,ceilingLinePaisa:price
});
const first=line("ORIG",500,4500,V500);
const added=line("ADD",1000,9000,V1000);
const originalBill={shopifyOrderGid:"",version:1,state:"sent",
  currency:"PKR",totalPaisa:4500,lines:[first]};
const PKR=v=>({shopMoney:{amount:(v/100).toFixed(2),currencyCode:"PKR"}});
const day=()=>{
  const d=new Date(Date.now()+6*86400000);d.setUTCHours(0,0,0,0);
  while(d.getUTCDay()!==1)d.setUTCDate(d.getUTCDate()+1);
  return d.toISOString().slice(0,10);
};
let pool,cycle,seq=0;
async function fixture(name){
  const n=++seq,householdKey="LAB-EDIT-HH-"+name,quoteId="LAB-EDIT-Q-"+n;
  const order="gid://shopify/Order/"+(901000+n);
  const signed={quoteId,cycleCode:cycle.code,customerReference:householdKey,
    lines:[first]};
  await pool.query(`INSERT INTO checkout_quotes
   (quote_id,version,shop_domain,household_key,cycle_code,delivery_date,
    issued_at,expires_at,signed_quote)
    VALUES($1,1,$2,$3,$4,$5,clock_timestamp()-interval '1 minute',
      clock_timestamp()+interval '2 hours',$6::jsonb)`,
    [quoteId,SHOP,householdKey,cycle.code,cycle.date,JSON.stringify(signed)]);
  const claim=(await pool.query(`INSERT INTO checkout_redemptions
   (quote_id,quote_version,shop_domain,household_key,cycle_code,
    redemption_key,state,policy_version,shopify_order_gid,
    expected_cod_paisa,completed_at)
    VALUES($1,1,$2,$3,$4,$5,'completed','SYNTHETIC-LAB',$6,4500,clock_timestamp())
    RETURNING claim_id`,[quoteId,SHOP,householdKey,cycle.code,
      "asb-adr002-"+n.toString(16).padStart(40,"0"),order])).rows[0];
  const snap={originalQuoteId:quoteId,proposalId:"LAB-P-"+n,
    originalClaimId:claim.claim_id,originalLines:[first],
    proposedLines:[first,added],policyVersion:"SYNTHETIC-LAB"};
  const reservation=(await pool.query(`INSERT INTO checkout_apna_amendment_reservations
    (shop_domain,household_key,cycle_code,original_claim_id,original_quote_id,
     shopify_order_gid,idempotency_key,snapshot_sha256,proposed_snapshot,additional_paisa)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,9000)
     RETURNING reservation_id`,
    [SHOP,householdKey,cycle.code,claim.claim_id,quoteId,order,
      "asb-amendment-"+n.toString(16).padStart(40,"0"),hash(snap),
      JSON.stringify(snap)])).rows[0];
  const rid=reservation.reservation_id;
  const prior={...originalBill,shopifyOrderGid:order};
  const draft={schemaVersion:"ASB_AMENDMENT_BILL_SIMULATION_V1",
    state:"SIMULATION_DRAFT_NOT_SENT",shopDomain:SHOP,
    shopifyOrderGid:order,reservationId:rid,billVersion:2,
    replacesBillVersion:1,previousBillDigest:hash(prior),currency:"PKR",
    totalPaisa:13500,amendmentDeltaPaisa:9000,
    lines:[first,added],groupedByDoor:{apna_order:["ORIG","ADD"]}};
  await pool.query(`INSERT INTO checkout_apna_amendment_bill_simulations
    (reservation_id,shop_domain,shopify_order_gid,original_bill_version,
     draft_bill_version,original_bill_sha256,draft_bill_sha256,
     expected_total_paisa,additional_paisa,draft_json)
    VALUES($1,$2,$3,1,2,$4,$5,13500,9000,$6::jsonb)`,
    [rid,SHOP,order,hash(prior),hash(draft),JSON.stringify(draft)]);
  return {rid,householdKey,quoteId,order,draft};
}
function identity(f){return {householdKey:f.householdKey,
  serverAuthenticated:true,phoneVerified:true};}
function fakeShopify({throwAfterWrite=false,stale=false,
  wrongVariants=false,readThrows=false}={}){
  const state={calls:0,readCalls:0,updated:false,stale,wrongVariants,readThrows};
  const adapter={
    __asbFakeTransport:true,
    async commit(input){
      state.calls++;
      assert.equal(input.notifyCustomer,false);
      assert.equal(input.mockOnly,true);
      assert.equal(input.calculatedOrderId,CALC);
      state.updated=true;
      if(throwAfterWrite)throw new Error("SIMULATED_TRANSPORT_RESPONSE_LOST");
      return {mockMutationAccepted:true};
    },
    async readOrder({shopifyOrderGid}){
      state.readCalls++;
      if(state.readThrows)throw new Error("SIMULATED_READ_UNAVAILABLE");
      const total=state.updated&&!state.stale?13500:4500;
      return {shopifyOrderGid,displayFinancialStatus:"PENDING",
        displayFulfillmentStatus:"UNFULFILLED",
        currentTotalPriceSet:PKR(total),totalOutstandingSet:PKR(total),
        observedAdditions:state.updated?(state.wrongVariants?
          [{variantId:V500,quantity:1}]:[{variantId:V1000,quantity:1}]):[]};
    }
  };
  return {state,adapter};
}
function service(sim,{sourceVerified=true,invalidProof=false}={}){
  return createPgMockShopifyEditCoordinator({
    pool,shopDomain:SHOP,devDomainAllowlist:[SHOP],mockShopify:sim.adapter,
    loadTrustedProofInTransaction:async({reservationId,source})=>{
      const plan={mode:"SIMULATION_ONLY_NOT_AUTHORIZED",
        reservationId,shopifyOrderGid:source.shopify_order_gid,
        previousBillDigest:source.original_bill_sha256,
        expectedFinalPaisa:13500,additionalPaisa:9000,
        additions:[{variantId:V1000,quantity:1}]};
      const preview={state:"precommit_preview_matches_not_committed",
        calculatedOrderId:invalidProof?"INVALID":CALC,
        expectedTotalPaisa:13500};
      return {mockOnly:true,sourceVerified,plan,preview};
    }
  });
}
async function attempts(rid){
  return (await pool.query(
    "SELECT * FROM checkout_apna_edit_commit_attempts WHERE reservation_id=$1",
    [rid])).rows;
}
before(async()=>{
  const url=await H.createDatabase("asb_test_apna_edit_recovery",
    path.join(__dirname,".."),{grocery:false});
  pool=new Pool({connectionString:url,max:12});
  for(const name of ["026_apna_amendment_reservations.sql",
    "027_apna_amendment_bill_simulations.sql",
    "028_apna_edit_commit_intents.sql"])
    await pool.query(fs.readFileSync(
      path.join(__dirname,"..","db","migrations",name),"utf8"));
  const date=day();
  cycle={date,code:"MON-"+date};
  await pool.query(`INSERT INTO cycles
    (code,cycle_date,opens_at,locks_at,delivery_date,status)
    VALUES($1,$2,clock_timestamp()-interval '1 day',
      clock_timestamp()+interval '1 day',$2,'open')`,
    [cycle.code,date]);
});
after(async()=>{if(pool)await pool.end();});

test("single mock commit intent is durable and independently read verified",async()=>{
  const f=await fixture("OK"),sim=fakeShopify(),svc=service(sim);
  const one=await svc.runMockOnce({reservationId:f.rid,identity:identity(f)});
  assert.equal(one.state,"verified_simulation");
  assert.equal(one.commitDispatched,true);
  assert.equal(one.shopifyModified,false);
  assert.equal(one.billSent,false);
  assert.equal(sim.state.calls,1);
  const retry=await svc.runMockOnce({reservationId:f.rid,identity:identity(f)});
  assert.equal(retry.commitDispatched,false);
  assert.equal(retry.recoveryOnly,true);
  assert.equal(sim.state.calls,1);
  const rows=await attempts(f.rid);
  assert.equal(rows.length,1);
  assert.equal(rows[0].state,"verified_simulation");
  assert.deepEqual(rows[0].expected_additions,[{variantId:V1000,quantity:1}]);
  const audit=(await pool.query(
    "SELECT action FROM checkout_apna_edit_attempt_audit WHERE attempt_id=$1 ORDER BY event_id",
    [rows[0].attempt_id])).rows.map(r=>r.action);
  assert.deepEqual(audit,["MOCK_INTENT_RECORDED","MOCK_READ_VERIFIED"]);
});
test("parallel duplicate requests cannot dispatch a second commit",async()=>{
  const f=await fixture("RACE"),sim=fakeShopify(),svc=service(sim);
  const [a,b]=await Promise.all([
    svc.runMockOnce({reservationId:f.rid,identity:identity(f)}),
    svc.runMockOnce({reservationId:f.rid,identity:identity(f)})
  ]);
  assert.equal([a,b].filter(x=>x.commitDispatched).length,1);
  assert.equal(sim.state.calls,1);
  assert.equal((await attempts(f.rid)).length,1);
});
test("lost response after mock commit is recovered by read, never repeated",async()=>{
  const f=await fixture("LOST"),sim=fakeShopify({throwAfterWrite:true});
  const svc=service(sim);
  const one=await svc.runMockOnce({reservationId:f.rid,identity:identity(f)});
  assert.equal(one.state,"verified_simulation");
  assert.equal(one.mockReplyPresent,false);
  assert.equal(sim.state.calls,1);
  await svc.recoverByMockRead({reservationId:f.rid,identity:identity(f)});
  await svc.runMockOnce({reservationId:f.rid,identity:identity(f)});
  assert.equal(sim.state.calls,1);
});
test("uncertain mock outcome is never auto retried; later read-only recovery works",async()=>{
  const f=await fixture("UNCERTAIN"),sim=fakeShopify({readThrows:true});
  const svc=service(sim);
  const one=await svc.runMockOnce({reservationId:f.rid,identity:identity(f)});
  assert.equal(one.state,"needs_reconcile");
  assert.equal(sim.state.calls,1);
  const retry=await svc.runMockOnce({reservationId:f.rid,identity:identity(f)});
  assert.equal(retry.commitDispatched,false);
  assert.equal(sim.state.calls,1);
  sim.state.readThrows=false;
  const verified=await svc.recoverByMockRead({reservationId:f.rid,identity:identity(f)});
  assert.equal(verified.state,"verified_simulation");
  assert.equal(sim.state.calls,1);
});
test("wrong total and wrong variant evidence cannot verify an edit",async()=>{
  for(const opts of [{stale:true},{wrongVariants:true}]){
    const f=await fixture(opts.stale?"PRICE":"VARIANT"),sim=fakeShopify(opts);
    const svc=service(sim);
    const state=await svc.runMockOnce({reservationId:f.rid,identity:identity(f)});
    assert.equal(state.state,"needs_reconcile");
    assert.equal(sim.state.calls,1);
    const retry=await svc.runMockOnce({reservationId:f.rid,identity:identity(f)});
    assert.equal(retry.commitDispatched,false);
  }
});
test("missing trusted proof, wrong household and closed cycle fail before commit",async()=>{
  const f=await fixture("BLOCK"),sim=fakeShopify(),svc=service(sim);
  await assert.rejects(()=>svc.runMockOnce({
    reservationId:f.rid,identity:{...identity(f),householdKey:"OTHER"}
  }),/AMENDMENT_MOCK_RESERVATION_NOT_ELIGIBLE/);
  await assert.rejects(()=>service(sim,{sourceVerified:false}).runMockOnce({
    reservationId:f.rid,identity:identity(f)
  }),/AMENDMENT_MOCK_PROOF_NOT_VERIFIED/);
  assert.equal((await attempts(f.rid)).length,0);
  await pool.query("UPDATE cycles SET status='locked' WHERE code=$1",[cycle.code]);
  try{
    await assert.rejects(()=>svc.runMockOnce({
      reservationId:f.rid,identity:identity(f)
    }),/AMENDMENT_MOCK_CYCLE_CLOSED/);
  }finally{
    await pool.query("UPDATE cycles SET status='open' WHERE code=$1",[cycle.code]);
  }
  assert.equal(sim.state.calls,0);
});
test("no fake client proof means no coordinator, including production shops",()=>{
  assert.throws(()=>createPgMockShopifyEditCoordinator({
    pool,shopDomain:"production.myshopify.com",
    devDomainAllowlist:["production.myshopify.com"],
    loadTrustedProofInTransaction:async()=>({}),
    mockShopify:fakeShopify().adapter
  }),/AMENDMENT_MOCK_LAB_ONLY/);
  assert.throws(()=>createPgMockShopifyEditCoordinator({
    pool,shopDomain:SHOP,devDomainAllowlist:[SHOP],
    loadTrustedProofInTransaction:async()=>({}),
    mockShopify:{commit:async()=>({}),readOrder:async()=>({})}
  }),/AMENDMENT_MOCK_TRANSPORT_REQUIRED/);
});
test("database prevents direct mutation of intent and audit, old COD stays immutable",async()=>{
  const f=await fixture("IMMUTABLE"),sim=fakeShopify();
  await service(sim).runMockOnce({reservationId:f.rid,identity:identity(f)});
  const rows=await attempts(f.rid);
  const attempt=rows[0];
  await assert.rejects(()=>pool.query(
    "UPDATE checkout_apna_edit_commit_attempts SET expected_total_paisa=1 WHERE attempt_id=$1",
    [attempt.attempt_id]),/APNA_EDIT_ATTEMPT_IMMUTABLE_OR_INVALID_TRANSITION/);
  await assert.rejects(()=>pool.query(
    "DELETE FROM checkout_apna_edit_commit_attempts WHERE attempt_id=$1",
    [attempt.attempt_id]),/APNA_EDIT_ATTEMPT_DELETE_FORBIDDEN/);
  await assert.rejects(()=>pool.query(
    "DELETE FROM checkout_apna_edit_attempt_audit WHERE attempt_id=$1",
    [attempt.attempt_id]),/APNA_EDIT_AUDIT_APPEND_ONLY/);
  const initial=(await pool.query(
    "SELECT r.expected_cod_paisa,r.state,r.shopify_order_gid FROM checkout_redemptions r "+
    "WHERE r.quote_id=$1",[f.quoteId])).rows[0];
  assert.equal(Number(initial.expected_cod_paisa),4500);
  assert.equal(initial.state,"completed");
  assert.equal(initial.shopify_order_gid,f.order);
});
