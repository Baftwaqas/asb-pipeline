// ASB Checkout Lab REAL commit coordinator with FAKE Shopify transport.
// Disposable PostgreSQL 18 only. No Shopify credentials or HTTP requests.
"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path"),crypto=require("node:crypto");
const {Pool}=require("pg");
const H=require("./support/harness");
const {canonical}=require("../checkout/quote-crypto-v1");
const {buildQuote}=require("../scripts/lab-apna-onion-order-v1");
const {makeSignedSyntheticPacket,SHOP,ORDER,QUOTE,CYCLE}=
  require("../checkout/lab-apna-signed-amendment-pg-v1");
const {makeLabCommitCoordinator}=
  require("../checkout/lab-apna-real-commit-pg-v1");
const fixture=require("../checkout/fixtures/asb-checkout-lab.json");
const F500=fixture.products[0].variants[0],F1000=fixture.products[0].variants[1];
const SECRET="SCRATCH_POSTGRES_ONLY_SECRET_0123456789_ABCDEFGHIJKLMN";
const CALC="gid://shopify/CalculatedOrder/828281";
const hash=v=>crypto.createHash("sha256").update(canonical(v),"utf8").digest("hex");
const cash=p=>({shopMoney:{amount:(p/100).toFixed(2),currencyCode:"PKR"}});
let counter=0;
function originalShopifyOrder(){
  return {
    id:ORDER,test:true,edited:false,currencyCode:"PKR",
    tags:["ASB-LAB-ONLY","NEVER-FULFILL","ASB-ADR002",
      "ASB-APNA-AMENDMENT-TARGET","ASB-CYCLE-"+CYCLE],
    displayFinancialStatus:"PENDING",displayFulfillmentStatus:"UNFULFILLED",
    currentTotalPriceSet:cash(4500),totalOutstandingSet:cash(4500),
    lineItems:{pageInfo:{hasNextPage:false},nodes:[{
      id:"gid://shopify/LineItem/123",quantity:1,unfulfilledQuantity:1,
      variant:{id:F500.gid,sku:F500.sku},
      customAttributes:[
        {key:"_asb_door",value:"apna_order"},
        {key:"_asb_product",value:"ASB-CANON-ONION"},
        {key:"_asb_qty",value:"500"},
        {key:"_asb_line_id",value:"LAB-APNA-ONION-500"}
      ]
    }]}
  };
}
function updatedShopifyOrder({wrongTotal=false,wrongVariant=false}={}){
  const original=originalShopifyOrder();
  const n=wrongTotal?14000:13500;
  return {...original,edited:true,
    currentTotalPriceSet:cash(n),totalOutstandingSet:cash(n),
    currentSubtotalPriceSet:cash(n),currentTotalTaxSet:cash(0),
    currentTotalDiscountsSet:cash(0),currentShippingPriceSet:cash(0),
    totalReceivedSet:cash(0),
    lineItems:{pageInfo:{hasNextPage:false},nodes:[
      original.lineItems.nodes[0],
      {id:"gid://shopify/LineItem/124",quantity:1,unfulfilledQuantity:1,
        variant:{id:wrongVariant?"gid://shopify/ProductVariant/99999":F1000.gid,
          sku:F1000.sku},customAttributes:[]}
    ]}
  };
}
function fakeShopify({lostResponse=false,wrongTotal=false,
  wrongVariant=false,commitFailsBeforeWrite=false,readUnavailable=false}={}){
  const state={stageCount:0,commitCount:0,readCount:0,committed:false,
    readUnavailable,wrongTotal,wrongVariant};
  const client={
    async readGrantedScopesForLab(){return {shopDomain:SHOP,ready:true};},
    async readLabOrderForAmendment({orderGid}){
      assert.equal(orderGid,ORDER);return originalShopifyOrder();
    },
    async previewLabApnaOnionUncommitted({orderGid,operatorApproval,previewMode}){
      state.stageCount++;
      assert.equal(orderGid,ORDER);
      assert.equal(operatorApproval,"ASB_LAB_APNA_ONION_STAGE_ONLY");
      assert.equal(previewMode,"STAGE_WITHOUT_COMMIT");
      return {state:"STAGED_ONLY_NOT_COMMITTED",explicitNoCommit:true,
        calculatedOrderId:CALC,originalPaisa:4500,
        additionalPaisa:9000,expectedFinalPaisa:13500};
    },
    async commitLabStagedOrderEdit({shopifyOrderGid,calculatedOrderGid,
      durableIntentRecorded,operatorGate}){
      state.commitCount++;
      assert.equal(shopifyOrderGid,ORDER);
      assert.equal(calculatedOrderGid,CALC);
      assert.equal(durableIntentRecorded,true);
      assert.equal(operatorGate,"DURABLE_LAB_COMMIT_INTENT_VERIFIED");
      if(commitFailsBeforeWrite)throw Error("SIMULATED_COMMIT_NETWORK_DOWN");
      state.committed=true;
      if(lostResponse)throw Error("SIMULATED_RESPONSE_LOST_AFTER_WRITE");
      return {state:"mutation_acknowledged_needs_readback"};
    },
    async readLabOrderForCommitReconcile({orderGid}){
      state.readCount++;
      assert.equal(orderGid,ORDER);
      if(state.readUnavailable)throw Error("SIMULATED_READ_TIMEOUT");
      if(!state.committed)return originalShopifyOrder();
      return updatedShopifyOrder(state);
    }
  };
  return {client,state};
}
async function setup(t){
  const n=++counter;
  const url=await H.createDatabase("asb_test_real_commit_"+n,
    path.join(__dirname,".."),{grocery:false});
  const pool=new Pool({connectionString:url,max:12});
  t.after(async()=>pool.end());
  for(const name of [
    "029_lab_signed_apna_amendments.sql",
    "030_lab_apna_commit_and_bill_history.sql"
  ])await pool.query(fs.readFileSync(path.join(
    __dirname,"..","db","migrations",name),"utf8"));
  const ref={cycleCode:CYCLE,deliveryDate:"2026-11-16",
    cutoff:new Date("2026-11-15T16:00:00Z")};
  const original=buildQuote(ref,new Date("2026-11-12T06:08:00Z"),SECRET);
  const household=original.customerReference;
  await pool.query(
    "INSERT INTO cycles(code,cycle_date,delivery_date,opens_at,locks_at,status)"+
    " VALUES($1,'2026-11-16','2026-11-16',"+
    " clock_timestamp()-interval '1 hour',clock_timestamp()+interval '1 day','open')",
    [CYCLE]);
  await pool.query(
    "INSERT INTO checkout_quotes(quote_id,version,shop_domain,household_key,"+
    "cycle_code,delivery_date,issued_at,expires_at,signed_quote)"+
    " VALUES($1,1,$2,$3,$4,'2026-11-16',$5,$6,$7::jsonb)",
    [QUOTE,SHOP,household,CYCLE,original.issuedAt,original.expiresAt,
      JSON.stringify(original)]);
  const claim=(await pool.query(
    "INSERT INTO checkout_redemptions("+
    "quote_id,quote_version,shop_domain,household_key,cycle_code,"+
    "redemption_key,state,policy_version,expected_cod_paisa,shopify_order_gid,"+
    "completed_at) VALUES($1,1,$2,$3,$4,$5,'completed','SYNTHETIC',4500,$6,"+
    "clock_timestamp()) RETURNING claim_id",
    [QUOTE,SHOP,household,CYCLE,
      "asb-adr002-"+n.toString(16).padStart(40,"0"),ORDER])).rows[0];
  const packet=makeSignedSyntheticPacket({originalQuote:original,
    order:originalShopifyOrder(),secret:SECRET});
  const row=(await pool.query(
    "INSERT INTO checkout_lab_apna_signed_amendments("+
    "original_claim_id,original_quote_id,shop_domain,household_key,cycle_code,"+
    "shopify_order_gid,signed_amendment,payload_sha256)"+
    " VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING authorization_id",
    [claim.claim_id,QUOTE,SHOP,household,CYCLE,ORDER,
      JSON.stringify(packet),hash(packet)])).rows[0];
  const authorizationId=row.authorization_id;
  return {
    pool,authorizationId,
    coordinator(client,secret=SECRET){
      return makeLabCommitCoordinator({
        pool,shopDomain:SHOP,devDomainAllowlist:[SHOP],
        quoteSecret:secret,shopifyClient:client
      });
    }
  };
}
async function withPermit(fn){
  const old={real:process.env.ASB_LAB_REAL_COMMIT,
    write:process.env.ASB_LAB_WRITE_MODE};
  process.env.ASB_LAB_REAL_COMMIT="REVIEWED_ONE_SHOT_ONLY";
  process.env.ASB_LAB_WRITE_MODE="lab-commit-single-attempt";
  try{return await fn();}
  finally{
    if(old.real===undefined)delete process.env.ASB_LAB_REAL_COMMIT;
    else process.env.ASB_LAB_REAL_COMMIT=old.real;
    if(old.write===undefined)delete process.env.ASB_LAB_WRITE_MODE;
    else process.env.ASB_LAB_WRITE_MODE=old.write;
  }
}
const args=id=>({authorizationId:id,operatorGate:"REVIEWED_LAB_ONE_SHOT_COMMIT"});
async function rows(pool){
  return (await pool.query("SELECT * FROM checkout_lab_apna_real_commit_attempts")).rows;
}
test("one real-transport mock call: independently read back + immutable TWO unsent bill versions",async t=>{
  const f=await setup(t),mock=fakeShopify(),co=f.coordinator(mock.client);
  const result=await withPermit(()=>co.executeOnce(args(f.authorizationId)));
  assert.equal(result.state,"verified");
  assert.equal(result.commitDispatched,true);
  assert.equal(result.mutationAcknowledged,true);
  assert.equal(result.totalPaisa,13500);
  assert.equal(result.billSent,false);
  assert.equal(mock.state.commitCount,1);
  const all=await rows(f.pool);
  assert.equal(all.length,1);assert.equal(all[0].state,"verified");
  const bills=(await f.pool.query(
    "SELECT version,state,total_paisa,snapshot_json FROM checkout_lab_apna_bill_history"+
    " ORDER BY version")).rows;
  assert.deepEqual(bills.map(x=>[x.version,x.state,Number(x.total_paisa)]),[
    [1,"source_checkout_not_sent",4500],
    [2,"reconciled_draft_not_sent",13500]
  ]);
  assert.equal(bills[1].snapshot_json.sendAuthorized,false);
  const before=(await f.pool.query(
    "SELECT state,expected_cod_paisa FROM checkout_redemptions WHERE quote_id=$1",
    [QUOTE])).rows[0];
  assert.equal(before.state,"completed");
  assert.equal(Number(before.expected_cod_paisa),4500);
  const retry=await withPermit(()=>co.executeOnce(args(f.authorizationId)));
  assert.equal(retry.commitDispatched,false);
  assert.equal(mock.state.commitCount,1);
});
test("two concurrent requests share one durable intent; exactly one commit dispatch",async t=>{
  const f=await setup(t),mock=fakeShopify(),co=f.coordinator(mock.client);
  const [a,b]=await withPermit(()=>Promise.all([
    co.executeOnce(args(f.authorizationId)),
    co.executeOnce(args(f.authorizationId))
  ]));
  assert.equal([a,b].filter(x=>x.commitDispatched).length,1);
  assert.equal(mock.state.commitCount,1);
  assert.equal((await rows(f.pool)).length,1);
  assert.equal((await f.pool.query(
    "SELECT count(*)::int AS n FROM checkout_lab_apna_bill_history")).rows[0].n,2);
});
test("lost response after mock Shopify commit is recovered by independent read, not replayed",async t=>{
  const f=await setup(t),mock=fakeShopify({lostResponse:true});
  const co=f.coordinator(mock.client);
  const first=await withPermit(()=>co.executeOnce(args(f.authorizationId)));
  assert.equal(first.state,"verified");
  assert.equal(first.mutationAcknowledged,false);
  await co.recoverByReadOnly({authorizationId:f.authorizationId});
  const twice=await withPermit(()=>co.executeOnce(args(f.authorizationId)));
  assert.equal(twice.commitDispatched,false);
  assert.equal(mock.state.commitCount,1);
});
test("unknown readback stays needs_reconcile, later READ ONLY recovery fixes billing",async t=>{
  const f=await setup(t),mock=fakeShopify({readUnavailable:true});
  const co=f.coordinator(mock.client);
  const first=await withPermit(()=>co.executeOnce(args(f.authorizationId)));
  assert.equal(first.state,"needs_reconcile");
  assert.equal(first.mayRetryCommit,false);
  assert.equal(mock.state.commitCount,1);
  assert.equal((await f.pool.query(
    "SELECT count(*)::int AS n FROM checkout_lab_apna_bill_history")).rows[0].n,0);
  await withPermit(()=>co.executeOnce(args(f.authorizationId)));
  assert.equal(mock.state.commitCount,1);
  mock.state.readUnavailable=false;
  const final=await co.recoverByReadOnly({authorizationId:f.authorizationId});
  assert.equal(final.state,"verified");
  assert.equal(mock.state.commitCount,1);
  assert.equal((await f.pool.query(
    "SELECT count(*)::int AS n FROM checkout_lab_apna_bill_history")).rows[0].n,2);
});
test("failed Shopify commit before write never retries even when original order still Rs45",async t=>{
  const f=await setup(t),mock=fakeShopify({commitFailsBeforeWrite:true});
  const co=f.coordinator(mock.client);
  const first=await withPermit(()=>co.executeOnce(args(f.authorizationId)));
  assert.equal(first.state,"needs_reconcile");
  assert.equal(mock.state.commitCount,1);
  await co.recoverByReadOnly({authorizationId:f.authorizationId});
  const second=await withPermit(()=>co.executeOnce(args(f.authorizationId)));
  assert.equal(second.commitDispatched,false);
  assert.equal(mock.state.commitCount,1);
});
test("wrong postcommit price and wrong variant never produce a bill",async t=>{
  const f=await setup(t),mock=fakeShopify({wrongVariant:true});
  const co=f.coordinator(mock.client);
  const x=await withPermit(()=>co.executeOnce(args(f.authorizationId)));
  assert.equal(x.state,"needs_reconcile");
  assert.equal(mock.state.commitCount,1);
  assert.equal((await f.pool.query(
    "SELECT count(*)::int AS n FROM checkout_lab_apna_bill_history")).rows[0].n,0);
});
test("closed cycle and bad signature stop BEFORE durable commit or Shopify write",async t=>{
  const f=await setup(t),mock=fakeShopify();
  const co=f.coordinator(mock.client);
  await f.pool.query("UPDATE cycles SET status='locked' WHERE code=$1",[CYCLE]);
  await assert.rejects(()=>withPermit(()=>co.executeOnce(args(f.authorizationId))),
    /LAB_REAL_COMMIT_DELIVERY_CUTOFF_CLOSED/);
  assert.equal(mock.state.commitCount,0);
  assert.equal((await rows(f.pool)).length,0);
  await f.pool.query("UPDATE cycles SET status='open' WHERE code=$1",[CYCLE]);
  const bad=f.coordinator(mock.client,"WRONG_SYNTHETIC_HMAC_SECRET_0123456789");
  await assert.rejects(()=>withPermit(()=>bad.executeOnce(args(f.authorizationId))),
    /LAB_AMENDMENT_ORIGINAL_SIGNATURE_OR_QUOTE_INVALID|LAB_REAL_COMMIT_SIGNED_PACKET_INVALID/);
  assert.equal(mock.state.commitCount,0);
  assert.equal((await rows(f.pool)).length,0);
});
test("operator flags absent refuse stage, database write and Shopify commit",async t=>{
  const f=await setup(t),mock=fakeShopify();
  const c=f.coordinator(mock.client);
  delete process.env.ASB_LAB_REAL_COMMIT;
  delete process.env.ASB_LAB_WRITE_MODE;
  await assert.rejects(()=>c.executeOnce(args(f.authorizationId)),
    /LAB_REAL_COMMIT_OPERATOR_DISABLED/);
  assert.equal(mock.state.stageCount,0);
  assert.equal(mock.state.commitCount,0);
  assert.equal((await rows(f.pool)).length,0);
});
test("no mutation/deletion of durable intent, audit, or bill history",async t=>{
  const f=await setup(t),mock=fakeShopify();
  await withPermit(()=>f.coordinator(mock.client).executeOnce(args(f.authorizationId)));
  const id=(await rows(f.pool))[0].attempt_id;
  await assert.rejects(()=>f.pool.query(
    "UPDATE checkout_lab_apna_real_commit_attempts SET expected_paisa=1 WHERE attempt_id=$1",
    [id]),/LAB_COMMIT_ATTEMPT_IMMUTABLE_OR_BAD_TRANSITION/);
  await assert.rejects(()=>f.pool.query(
    "DELETE FROM checkout_lab_apna_real_commit_attempts WHERE attempt_id=$1",[id]),
    /LAB_COMMIT_ATTEMPT_DELETE_FORBIDDEN/);
  await assert.rejects(()=>f.pool.query(
    "UPDATE checkout_lab_apna_bill_history SET total_paisa=1 WHERE attempt_id=$1",[id]),
    /LAB_APPEND_ONLY_AUDIT_OR_BILL|check constraint/i);
  await assert.rejects(()=>f.pool.query(
    "DELETE FROM checkout_lab_apna_commit_audit WHERE attempt_id=$1",[id]),
    /LAB_APPEND_ONLY_AUDIT_OR_BILL/);
});
