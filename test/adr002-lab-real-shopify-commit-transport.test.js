"use strict";
// Test the ACTUAL fixed Shopify orderEditCommit GraphQL transport using a fake
// fetch function. No Shopify credentials, real HTTP, order or customer contact.
const {test}=require("node:test"),assert=require("node:assert/strict");
const {createDevCredentialsShopifyClient}=
  require("../checkout/dev-shopify-credentials-v1");
const SHOP="asb-checkout-lab.myshopify.com";
const ORDER="gid://shopify/Order/19011998580770";
const CALC="gid://shopify/CalculatedOrder/288822";
const TOKEN="shpat_SIMULATED_TEST_TOKEN_00000000000000001";
const flags=async fn=>{
  const previous={a:process.env.ASB_LAB_REAL_COMMIT,
    b:process.env.ASB_LAB_WRITE_MODE};
  process.env.ASB_LAB_REAL_COMMIT="REVIEWED_ONE_SHOT_ONLY";
  process.env.ASB_LAB_WRITE_MODE="lab-commit-single-attempt";
  try{return await fn();}finally{
    if(previous.a===undefined)delete process.env.ASB_LAB_REAL_COMMIT;
    else process.env.ASB_LAB_REAL_COMMIT=previous.a;
    if(previous.b===undefined)delete process.env.ASB_LAB_WRITE_MODE;
    else process.env.ASB_LAB_WRITE_MODE=previous.b;
  }
};
function fake({errors=false,lostResponse=false,paid=false}={}){
  const counts={token:0,identity:0,scopes:0,commit:0,read:0};
  const fetchImpl=async(url,options)=>{
    if(url.endsWith("/admin/oauth/access_token")){
      counts.token++;
      return {ok:true,json:async()=>({access_token:TOKEN,
        scope:"read_products,write_orders,write_order_edits",expires_in:3600})};
    }
    assert.equal(url,"https://"+SHOP+"/admin/api/2026-10/graphql.json");
    assert.equal(options.headers["X-Shopify-Access-Token"],TOKEN);
    const b=JSON.parse(options.body);
    if(b.query.includes("ASBDevVerify")){
      counts.identity++;
      return {ok:true,json:async()=>({data:{shop:{
        myshopifyDomain:SHOP,currencyCode:"PKR",ianaTimezone:"Asia/Karachi"
      }}})};
    }
    if(b.query.includes("ASBBridgeScopeAudit")){
      counts.scopes++;
      return {ok:true,json:async()=>({data:{currentAppInstallation:{
        accessScopes:["read_products","write_orders","write_order_edits"]
          .map(handle=>({handle}))
      }}})};
    }
    if(b.query.includes("ASBLabCommitOnce")){
      counts.commit++;
      assert.equal(b.variables.id,CALC);
      assert.match(b.query,/orderEditCommit/);
      assert.match(b.query,/notifyCustomer:false/);
      assert.doesNotMatch(b.query,/notifyCustomer:true/);
      if(lostResponse)throw Error("LOST_NETWORK_RESPONSE");
      return {ok:true,json:async()=>({data:{orderEditCommit:{
        order:errors?null:{id:ORDER},
        userErrors:errors?[{message:"Payment block"}]:[],
        successMessages:errors?[]:["test"]
      }}})};
    }
    if(b.query.includes("ASBLabCommitReadback")){
      counts.read++;
      assert.deepEqual(b.variables,{id:ORDER});
      return {ok:true,json:async()=>({data:{order:{
        id:ORDER,test:true,edited:!paid,
        tags:["ASB-LAB-ONLY","NEVER-FULFILL","ASB-ADR002",
          "ASB-APNA-AMENDMENT-TARGET","ASB-CYCLE-MON-2026-11-16"],
        currencyCode:"PKR",displayFinancialStatus:"PENDING",
        displayFulfillmentStatus:"UNFULFILLED",
        currentTotalPriceSet:{shopMoney:{amount:"135.00",currencyCode:"PKR"}},
        totalOutstandingSet:{shopMoney:{amount:"135.00",currencyCode:"PKR"}},
        currentSubtotalPriceSet:{shopMoney:{amount:"135.00",currencyCode:"PKR"}},
        currentTotalTaxSet:{shopMoney:{amount:"0.00",currencyCode:"PKR"}},
        currentTotalDiscountsSet:{shopMoney:{amount:"0.00",currencyCode:"PKR"}},
        currentShippingPriceSet:{shopMoney:{amount:"0.00",currencyCode:"PKR"}},
        totalReceivedSet:{shopMoney:{amount:"0.00",currencyCode:"PKR"}},
        lineItems:{pageInfo:{hasNextPage:false},nodes:[]}
      }}})};
    }
    throw Error("UNREVIEWED_QUERY_IN_COMMIT_TRANSPORT_TEST");
  };
  const cli=createDevCredentialsShopifyClient({
    shopDomain:SHOP,devDomainAllowlist:[SHOP],
    clientId:"TEST_LAB_BRIDGE_CLIENT_ID",
    clientSecret:"TEST_LAB_BRIDGE_CLIENT_SECRET",
    fetchImpl
  });
  return {cli,counts};
}
const opts=()=>({shopifyOrderGid:ORDER,calculatedOrderGid:CALC,
  durableIntentRecorded:true,operatorGate:"DURABLE_LAB_COMMIT_INTENT_VERIFIED"});
test("without explicit lab flags, no commit and no token is requested",async()=>{
  const x=fake();
  delete process.env.ASB_LAB_REAL_COMMIT;
  delete process.env.ASB_LAB_WRITE_MODE;
  await assert.rejects(()=>x.cli.commitLabStagedOrderEdit(opts()),
    /LAB_REAL_COMMIT_NOT_AUTHORIZED/);
  assert.equal(x.counts.commit,0);
  assert.equal(x.counts.token,0);
});
test("one documented Shopify mutation only; staff note and notifyCustomer false",async()=>{
  const x=fake();
  const r=await flags(()=>x.cli.commitLabStagedOrderEdit(opts()));
  assert.equal(r.state,"mutation_acknowledged_needs_readback");
  assert.equal(r.notified,false);
  assert.equal(r.reconciled,false);
  assert.equal(x.counts.commit,1);
  assert.equal(x.counts.scopes,1);
});
test("userErrors or lost network response must never be called success",async()=>{
  for(const config of [{errors:true},{lostResponse:true}]){
    const x=fake(config);
    await assert.rejects(()=>flags(()=>x.cli.commitLabStagedOrderEdit(opts())),
      /LAB_REAL_COMMIT_OUTCOME_UNCERTAIN/);
    assert.equal(x.counts.commit,1);
  }
});
test("wrong order, invalid calculated GID or forged durable proof cannot commit",async()=>{
  for(const changed of [
    {shopifyOrderGid:"gid://shopify/Order/999999"},
    {calculatedOrderGid:"gid://shopify/Order/19011998580770"},
    {durableIntentRecorded:false},
    {operatorGate:"WRONG"}
  ]){
    const x=fake();
    await assert.rejects(()=>flags(()=>x.cli.commitLabStagedOrderEdit({
      ...opts(),...changed
    })),/LAB_REAL_COMMIT_NOT_AUTHORIZED/);
    assert.equal(x.counts.token,0);
    assert.equal(x.counts.commit,0);
  }
});
test("readback endpoint queries only specific order without customer secrets",async()=>{
  const x=fake();
  const r=await x.cli.readLabOrderForCommitReconcile({orderGid:ORDER});
  assert.equal(r.id,ORDER);
  assert.equal(r.currencyCode,"PKR");
  assert.equal(x.counts.read,1);
  assert.equal(x.counts.commit,0);
  assert.equal(JSON.stringify(r).includes(TOKEN),false);
});
