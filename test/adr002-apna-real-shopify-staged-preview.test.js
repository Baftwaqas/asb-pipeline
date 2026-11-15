"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const {createDevCredentialsShopifyClient}=
  require("../checkout/dev-shopify-credentials-v1");
const SHOP="asb-checkout-lab.myshopify.com";
const ID="gid://shopify/Order/19011998580770";
const C="gid://shopify/CalculatedOrder/800001";
const TOKEN="shpat_FAKE_PREVIEW_TOKEN_123456789000000000";
function money(n){return {shopMoney:{amount:n,currencyCode:"PKR"}};}
function setup({addAmount="135.00",testOrder=true,beginUserErrors=[],
  wrongVariant=false,shopifyScope="read_products,write_orders,write_order_edits"}={}){
  const calls={token:0,shop:0,order:0,scopes:0,begin:0,add:0,commit:0};
  const fetchImpl=async(url,opt)=>{
    if(url.endsWith("/admin/oauth/access_token")){
      calls.token++;
      return {ok:true,json:async()=>({
        access_token:TOKEN,scope:shopifyScope,expires_in:3600
      })};
    }
    assert.equal(url,"https://"+SHOP+"/admin/api/2026-10/graphql.json");
    const q=JSON.parse(opt.body);
    if(q.query.includes("ASBDevVerify")){
      calls.shop++;
      return {ok:true,json:async()=>({data:{shop:{
        myshopifyDomain:SHOP,currencyCode:"PKR",ianaTimezone:"Asia/Karachi"}}})};
    }
    if(q.query.includes("ASBReadLabOrderForAmendment")){
      calls.order++;return {ok:true,json:async()=>({data:{order:{
        id:ID,test:testOrder,tags:["ASB-LAB-ONLY","NEVER-FULFILL",
          "ASB-ADR002","ASB-APNA-AMENDMENT-TARGET","ASB-CYCLE-MON-2026-11-16"],
        createdAt:"2026-11-12T06:08:00Z",currencyCode:"PKR",
        displayFinancialStatus:"PENDING",displayFulfillmentStatus:"UNFULFILLED",
        currentTotalPriceSet:money("45.00"),totalOutstandingSet:money("45.00"),
        lineItems:{nodes:[{id:"gid://shopify/LineItem/1001",
          quantity:1,unfulfilledQuantity:1,
          variant:{id:wrongVariant?"gid://shopify/ProductVariant/999":
            "gid://shopify/ProductVariant/69644381683746",sku:"ASB-LAB-ONION-500G"},
          customAttributes:[{key:"_asb_door",value:"apna_order"},
            {key:"_asb_product",value:"ASB-CANON-ONION"}]}],
          pageInfo:{hasNextPage:false}}
      }}})};
    }
    if(q.query.includes("currentAppInstallation")){
      calls.scopes++;return {ok:true,json:async()=>({
        data:{currentAppInstallation:{accessScopes:[
          "read_products","write_orders","write_order_edits"
        ].map(handle=>({handle}))}}
      })};
    }
    if(q.query.includes("orderEditBegin(")){
      calls.begin++;
      assert.equal(q.variables.id,ID);
      return {ok:true,json:async()=>({data:{orderEditBegin:{
        calculatedOrder:{id:C,totalPriceSet:money("45.00"),
          totalOutstandingSet:money("45.00")},
        userErrors:beginUserErrors
      }}})};
    }
    if(q.query.includes("orderEditAddVariant(")){
      calls.add++;
      assert.deepEqual(q.variables,{id:C,
        variantId:"gid://shopify/ProductVariant/69644381716514",quantity:1});
      assert.match(q.query,/allowDuplicates:false/);
      return {ok:true,json:async()=>({data:{orderEditAddVariant:{
        calculatedOrder:{id:C,totalPriceSet:money(addAmount),
          totalOutstandingSet:money(addAmount)},userErrors:[]
      }}})};
    }
    if(q.query.includes("orderEditCommit(")){
      calls.commit++;throw Error("NEVER_COMMIT_IN_PREVIEW");
    }
    throw Error("UNREVIEWED_SHOPIFY_OPERATION");
  };
  const cli=createDevCredentialsShopifyClient({
    shopDomain:SHOP,devDomainAllowlist:[SHOP],
    clientId:"FAKE-BRIDGE-CLIENT-ID",
    clientSecret:"FAKE-BRIDGE-CLIENT-SECRET",fetchImpl
  });
  return {cli,calls};
}
function request(){return {orderGid:ID,
  operatorApproval:"ASB_LAB_APNA_ONION_STAGE_ONLY",
  previewMode:"STAGE_WITHOUT_COMMIT"};}
test("staging exact existing 500g + new 1kg returns Rs135 without any commit",async()=>{
  const x=setup();const r=await x.cli.previewLabApnaOnionUncommitted(request());
  assert.equal(r.state,"STAGED_ONLY_NOT_COMMITTED");
  assert.equal(r.originalPaisa,4500);
  assert.equal(r.additionalPaisa,9000);
  assert.equal(r.expectedFinalPaisa,13500);
  assert.equal(r.explicitNoCommit,true);
  assert.equal(r.orderModified,false);
  assert.equal(r.billSent,false);
  assert.equal(x.calls.begin,1);
  assert.equal(x.calls.add,1);
  assert.equal(x.calls.commit,0);
});
test("wrong founder gate or different order cannot even start a session",async()=>{
  const x=setup();
  for(const r of [{...request(),orderGid:"gid://shopify/Order/18999612604450"},
    {...request(),operatorApproval:"WRONG"},
    {...request(),previewMode:"COMMIT"}])
    await assert.rejects(()=>x.cli.previewLabApnaOnionUncommitted(r),
      /LAB_APNA_PREVIEW_NOT_ARMED/);
  assert.equal(x.calls.token,0);
  assert.equal(x.calls.begin,0);
  assert.equal(x.calls.commit,0);
});
test("Shopify contextual price drift is refused; never commit",async()=>{
  const x=setup({addAmount:"140.00"});
  await assert.rejects(()=>x.cli.previewLabApnaOnionUncommitted(request()),
    /LAB_APNA_PREVIEW_FINAL_MONEY_MISMATCH/);
  assert.equal(x.calls.begin,1);
  assert.equal(x.calls.add,1);
  assert.equal(x.calls.commit,0);
});
test("non-test order, wrong variant and missing actual scope cannot stage",async()=>{
  for(const cfg of [{testOrder:false},{wrongVariant:true},
    {shopifyScope:"read_products,write_orders"}]){
    const x=setup(cfg);
    await assert.rejects(()=>x.cli.previewLabApnaOnionUncommitted(request()),
      /LAB_ORDER_EDIT_NOT_SYNTHETIC_TEST_ORDER|LAB_APNA_PREVIEW_SOURCE_NOT_ELIGIBLE|LAB_ORDER_EDIT_SCOPE_NOT_GRANTED/);
    assert.equal(x.calls.begin,0);
    assert.equal(x.calls.commit,0);
  }
});
test("Shopify begin user errors stop before AddVariant and Commit",async()=>{
  const x=setup({beginUserErrors:[{field:["id"],message:"not editable"}]});
  await assert.rejects(()=>x.cli.previewLabApnaOnionUncommitted(request()),
    /LAB_APNA_PREVIEW_SHOPIFY_REJECTED/);
  assert.equal(x.calls.begin,1);
  assert.equal(x.calls.add,0);
  assert.equal(x.calls.commit,0);
});
