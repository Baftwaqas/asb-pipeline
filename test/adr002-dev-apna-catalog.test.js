// Exact Shopify Dev store's offline-token product/variant policy read path.
"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createDevCredentialsShopifyClient}=
  require("../checkout/dev-shopify-credentials-v1");
const {prepareApprovedApnaBindings}=
  require("../checkout/apna-shopify-pack-bindings-v1");

const SHOP="asb-checkout-lab.myshopify.com";
const PRODUCT="gid://shopify/Product/15548929015842";
const P2="gid://shopify/Product/15548928753698";
const V1="gid://shopify/ProductVariant/69644382797858";
const V2="gid://shopify/ProductVariant/69644382830626";
const FAKETOKEN="TEST_ONLY_OFFLINE_TOKEN_NOT_REAL_0123456789";
function sample(p=PRODUCT){
  return {__typename:"Product",id:p,title:"ASB Lab Test Ginger",
    status:"DRAFT",variants:{
      nodes:[
        {id:V1,title:"125 g",sku:"ASB-LAB-GINGER-125G",price:"35.00"},
        {id:V2,title:"250 g",sku:"ASB-LAB-GINGER-250G",price:"70.00"}
      ],pageInfo:{hasNextPage:false}}};
}
function fake({scope="read_products,write_orders",badNode=false,missing=false,
  badShop=false}={}){
  const calls={token:0,shop:0,catalog:0,mutations:0,batches:[]};
  const fetchImpl=async(url,init)=>{
    assert.ok(url.startsWith("https://"+SHOP+"/admin/"));
    if(url.endsWith("/admin/oauth/access_token")){
      calls.token++;
      return {ok:true,json:async()=>({
        access_token:FAKETOKEN,scope,expires_in:3600
      })};
    }
    const body=JSON.parse(init.body);
    assert.equal(init.method,"POST");
    assert.equal(init.headers["X-Shopify-Access-Token"],FAKETOKEN);
    if(body.query.includes("ASBDevVerify")){
      calls.shop++;
      return {ok:true,json:async()=>({data:{shop:{
        myshopifyDomain:badShop?"another.myshopify.com":SHOP,
        currencyCode:"PKR",ianaTimezone:"Asia/Karachi"
      }}})};
    }
    if(body.query.includes("ASBDevApnaCatalogue")){
      calls.catalog++;
      assert.equal(body.variables.ids.length<=5,true);
      calls.batches.push(body.variables.ids.length);
      const nodes=body.variables.ids.map(p=>sample(p));
      if(badNode)nodes[0].__typename="Collection";
      if(missing)nodes.splice(0,1);
      return {ok:true,json:async()=>({data:{nodes}})};
    }
    calls.mutations++;
    throw Error("UNREVIEWED_NETWORK_OPERATION");
  };
  return {calls,fetchImpl};
}
function client(f){
  return createDevCredentialsShopifyClient({
    shopDomain:SHOP,devDomainAllowlist:[SHOP],
    clientId:"ASB-DEV-CLIENT-TEST",
    clientSecret:"NOT_REAL_DEV_CLIENT_SECRET",
    fetchImpl:f.fetchImpl
  });
}
test("C1: server reads exact DRAFT product/variant data via read_products; no writes",async()=>{
  const f=fake(),c=client(f);
  const arr=await c.readProductsForPolicy({productGids:[PRODUCT,P2]});
  assert.deepEqual(arr.map(x=>x.id),[PRODUCT,P2]);
  assert.deepEqual(arr[0].variants.nodes.map(x=>x.title),["125 g","250 g"]);
  assert.equal(arr[0].status,"DRAFT");
  assert.deepEqual([f.calls.token,f.calls.shop,f.calls.catalog,f.calls.mutations],[1,1,1,0]);
});
test("C2: founder pack release cannot activate against DRAFT products",async()=>{
  const f=fake(),c=client(f);
  const products=await c.readProductsForPolicy({productGids:[PRODUCT]});
  const release={
    shop:SHOP,policyVersion:"apna-signed-"+"a".repeat(24),
    limitsByProduct:{"ASB-CANON-GINGER":{
      unit:"g",minQuantity:125,maxQuantity:500,allowedSizes:[125,250]}},
    mappedCanonicalByProduct:new Map([[PRODUCT,"ASB-CANON-GINGER"]])
  };
  assert.throws(()=>prepareApprovedApnaBindings({
    release,shopDomain:SHOP,verifiedProducts:products,
    serverCatalogVerified:true
  }),/APNA_INCOMPLETE_OR_INACTIVE_SHOPIFY_PRODUCT/);
});
test("C3: missing read_products scope denies catalogue even when write_orders exists",async()=>{
  const f=fake({scope:"write_orders"}),c=client(f);
  await assert.rejects(()=>c.readProductsForPolicy({productGids:[PRODUCT]}),
    /DEV_APP_READ_PRODUCTS_NOT_GRANTED/);
  assert.equal(f.calls.catalog,0);
});
test("C4: wrong dev shop blocks even read-only catalogue",async()=>{
  const f=fake({badShop:true}),c=client(f);
  await assert.rejects(()=>c.readProductsForPolicy({productGids:[PRODUCT]}),
    /DEV_SHOP_IDENTITY_OR_SETTINGS_MISMATCH/);
  assert.equal(f.calls.catalog,0);
});
test("C5: unknown/malformed product or duplicate IDs rejected without Shopify calls",async()=>{
  const f=fake(),c=client(f);
  for(const ids of [[],[PRODUCT,PRODUCT],
    ["gid://shopify/ProductVariant/69644382797858"],["bad-id"]]){
    await assert.rejects(()=>c.readProductsForPolicy({productGids:ids}),
      /APNA_CATALOG_PRODUCT_(IDS_REQUIRED|ID_INVALID)/);
  }
  assert.equal(f.calls.token,0);
  assert.equal(f.calls.catalog,0);
});
test("C6: missing product or non-Product GraphQL node fails closed",async()=>{
  for(const opts of [{missing:true},{badNode:true}]){
    const f=fake(opts),c=client(f);
    await assert.rejects(()=>c.readProductsForPolicy({productGids:[PRODUCT]}),
      /APNA_SHOPIFY_CATALOG_(RESPONSE_INVALID|INCOMPLETE)/);
    assert.equal(f.calls.mutations,0);
  }
});
test("C7: large approved catalogue is fetched in exact five-item batches",async()=>{
  const f=fake(),c=client(f);
  const ids=Array.from({length:12},(_,i)=>"gid://shopify/Product/"+(10000+i));
  const arr=await c.readProductsForPolicy({productGids:ids});
  assert.deepEqual(arr.map(x=>x.id),ids);
  assert.deepEqual(f.calls.batches,[5,5,2]);
  assert.equal(f.calls.catalog,3);
  assert.equal(f.calls.mutations,0);
});
