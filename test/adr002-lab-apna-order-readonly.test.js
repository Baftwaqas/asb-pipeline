"use strict";
const {test}=require("node:test"),assert=require("node:assert/strict");
const {createDevCredentialsShopifyClient}=
  require("../checkout/dev-shopify-credentials-v1");
const SHOP="asb-checkout-lab.myshopify.com";
const ID="gid://shopify/Order/18999612604450";
const TOKEN="shpat_FAKE_TEST_SCOPE_TOKEN_01234567890123";
function fake({testOrder=true,tags=["ASB-LAB-ONLY","NEVER-FULFILL","ASB-ADR002"],
  returnedId=ID,lineCount=1,hasNextPage=false,scope="read_products,write_orders,write_order_edits",
  financial="PENDING",fulfillment="UNFULFILLED"}={}){
  const calls={token:0,shop:0,order:0,mutation:0};
  const order={id:returnedId,test:testOrder,tags,createdAt:"2026-11-12T06:30:00Z",
    currencyCode:"PKR",displayFinancialStatus:financial,
    displayFulfillmentStatus:fulfillment,
    currentTotalPriceSet:{shopMoney:{amount:"45.00",currencyCode:"PKR"}},
    totalOutstandingSet:{shopMoney:{amount:"45.00",currencyCode:"PKR"}},
    lineItems:{nodes:Array.from({length:lineCount},(_,i)=>({
      id:"gid://shopify/LineItem/"+(700+i),quantity:1,unfulfilledQuantity:1,
      variant:{id:"gid://shopify/ProductVariant/69644381683746",
        sku:"ASB-LAB-ONION-500G"},
      customAttributes:[{key:"_asb_door",value:"apna_order"}]
    })),pageInfo:{hasNextPage}}
  };
  const fetchImpl=async(url,options)=>{
    if(url.endsWith("/admin/oauth/access_token")){
      calls.token++;return {ok:true,json:async()=>({access_token:TOKEN,scope,expires_in:3600})};
    }
    const body=JSON.parse(options.body);
    if(body.query.includes("ASBDevVerify")){
      calls.shop++;return {ok:true,json:async()=>({data:{shop:{
        myshopifyDomain:SHOP,currencyCode:"PKR",ianaTimezone:"Asia/Karachi"}}})};
    }
    if(body.query.includes("ASBReadLabOrderForAmendment")){
      calls.order++;
      assert.deepEqual(body.variables,{id:ID});
      return {ok:true,json:async()=>({data:{order}})};
    }
    calls.mutation++;throw Error("UNEXPECTED_MUTATION_IN_READ_ONLY_ORDER_AUDIT");
  };
  const client=createDevCredentialsShopifyClient({
    shopDomain:SHOP,devDomainAllowlist:[SHOP],
    clientId:"BRIDGE-LAB-CLIENT-ID",clientSecret:"BRIDGE-LAB-CLIENT-SECRET",
    fetchImpl
  });
  return {calls,client};
}
test("read exact synthetic, pending and unfulfilled order without ever writing",async()=>{
  const f=fake();const result=await f.client.readLabOrderForAmendment({orderGid:ID});
  assert.equal(result.id,ID);assert.equal(result.test,true);
  assert.deepEqual(f.calls,{token:1,shop:1,order:1,mutation:0});
  assert.equal(JSON.stringify(result).includes(TOKEN),false);
});
test("non-test, missing NEVER-FULFILL, wrong order id or truncated lines fail closed",async()=>{
  for(const o of [{testOrder:false},{tags:["ASB-LAB-ONLY"]},
    {returnedId:"gid://shopify/Order/999"},
    {hasNextPage:true}]){
    const f=fake(o);
    await assert.rejects(()=>f.client.readLabOrderForAmendment({orderGid:ID}),
      /LAB_ORDER_EDIT_NOT_SYNTHETIC_TEST_ORDER|LAB_ORDER_EDIT_READ_INVALID_RESPONSE/);
    assert.equal(f.calls.mutation,0);
  }
});
test("paid, fulfilled or missing write_order_edits denies read",async()=>{
  for(const o of [{financial:"PAID"},{fulfillment:"FULFILLED"},
    {scope:"read_products,write_orders"}]){
    const f=fake(o);
    await assert.rejects(()=>f.client.readLabOrderForAmendment({orderGid:ID}),
      /LAB_ORDER_EDIT_NOT_PENDING_UNFULFILLED|LAB_ORDER_EDIT_SCOPE_NOT_GRANTED/);
    assert.equal(f.calls.mutation,0);
  }
});
test("cannot pass invalid order GID into Bridge API",async()=>{
  const f=fake();
  await assert.rejects(()=>f.client.readLabOrderForAmendment({
    orderGid:"gid://shopify/Order/100?evil=1"
  }),/LAB_ORDER_EDIT_INVALID_ORDER_GID/);
  assert.deepEqual(f.calls,{token:0,shop:0,order:0,mutation:0});
});
test("unfulfilled line validation rejects partially fulfilled order",async()=>{
  const f=fake();const orig=f.client;
  const r=await orig.readLabOrderForAmendment({orderGid:ID});
  assert.equal(r.lineItems.nodes[0].unfulfilledQuantity,1);
});
