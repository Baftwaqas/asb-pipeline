// No real Shopify tokens, network, external shop or payment.
"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {createDevCredentialsShopifyClient}=require("../checkout/dev-shopify-credentials-v1");
const SHOP="asb-checkout-lab.myshopify.com";
const MUTATION="mutation LAB($order: OrderCreateOrderInput!) { orderCreate(order:$order){ userErrors {message} } }";
const token="shpat_TEST_TOKEN_NEVER_REAL_01234567890123456789";
function response(body,ok=true){return {ok,json:async()=>body};}
function fixture({scope="read_products,write_orders",currency="PKR",zone="Asia/Karachi",domain=SHOP,expires=86400}={}){
  const calls={token:0,read:0,write:0,url:[],lastBody:""};
  const fetchImpl=async(url,init)=>{
    calls.url.push(url);
    if(url.endsWith("/admin/oauth/access_token")){
      calls.token++;
      calls.lastBody=init.body;
      assert.equal(init.method,"POST");
      assert.equal(init.headers["Content-Type"],"application/x-www-form-urlencoded");
      const params=new URLSearchParams(init.body);
      assert.equal(params.get("grant_type"),"client_credentials");
      assert.equal(params.get("client_id"),"CLIENT-ID-TEST-ONLY");
      assert.equal(params.get("client_secret"),"CLIENT-SECRET-TEST-ONLY");
      assert.equal(params.has("scope"),false);
      return response({access_token:token,scope,expires_in:expires});
    }
    const body=JSON.parse(init.body);
    assert.equal(init.headers["X-Shopify-Access-Token"],token);
    if(body.query.includes("ASBDevVerify")){
      calls.read++;
      return response({data:{shop:{myshopifyDomain:domain,currencyCode:currency,ianaTimezone:zone}}});
    }
    if(body.query.includes("orderCreate(")){
      calls.write++;
      return response({data:{orderCreate:{userErrors:[]}}});
    }
    throw Error("UNEXPECTED_API_REQUEST");
  };
  return {calls,fetchImpl};
}
function client(fake,options={}){
  return createDevCredentialsShopifyClient({shopDomain:SHOP,devDomainAllowlist:[SHOP],
    clientId:"CLIENT-ID-TEST-ONLY",clientSecret:"CLIENT-SECRET-TEST-ONLY",
    fetchImpl:fake.fetchImpl,...options});
}
test("D0: no authorization credentials or exact shop allowlist: deny by default",()=>{
  const f=fixture();
  assert.throws(()=>createDevCredentialsShopifyClient({shopDomain:SHOP,clientId:"CLIENT-ID-TEST-ONLY",
    clientSecret:"CLIENT-SECRET-TEST-ONLY",fetchImpl:f.fetchImpl}),/DEV_STORE_NOT_EXPLICITLY_ALLOWLISTED/);
  assert.throws(()=>createDevCredentialsShopifyClient({shopDomain:SHOP,devDomainAllowlist:[SHOP],
    clientId:"missing",fetchImpl:f.fetchImpl}),/DEV_APP_CREDENTIALS_REQUIRED/);
  assert.throws(()=>createDevCredentialsShopifyClient({shopDomain:"apnasastabazaar.myshopify.com",
    devDomainAllowlist:[SHOP],clientId:"CLIENT-ID-TEST-ONLY",
    clientSecret:"CLIENT-SECRET-TEST-ONLY",fetchImpl:f.fetchImpl}),/DEV_STORE_NOT_EXPLICITLY_ALLOWLISTED/);
});
test("D0: first server-to-server token exchange uses grant, verifies shop and creates order",async()=>{
  const f=fixture();const c=client(f);
  const identity=await c.checkShop();
  assert.deepEqual(identity,{shopDomain:SHOP,currency:"PKR",timeZone:"Asia/Karachi"});
  const r=await c.createOrder({query:MUTATION,variables:{order:{}}});
  assert.deepEqual(r.data.orderCreate.userErrors,[]);
  assert.deepEqual([f.calls.token,f.calls.read,f.calls.write],[1,2,1]);
});
test("D0: concurrent calls reuse one token, never send a token to caller",async()=>{
  const f=fixture();const c=client(f);
  const [a,b]=await Promise.all([c.checkShop(),c.checkShop()]);
  assert.equal(a.shopDomain,SHOP);assert.equal(b.shopDomain,SHOP);
  assert.equal(f.calls.token,1);
  assert.equal(JSON.stringify(a).includes(token),false);
});
test("D0: merchant must actually grant write_orders (declared scope is not proof)",async()=>{
  const f=fixture({scope:"read_products"});const c=client(f);
  await assert.rejects(()=>c.createOrder({query:MUTATION}),/DEV_APP_WRITE_ORDERS_NOT_GRANTED/);
  assert.equal(f.calls.write,0);
});
test("D0: failure on wrong domain or currency or timezone blocks orderCreate",async()=>{
  for(const change of [{domain:"another.myshopify.com"},{currency:"USD"},{zone:"America/New_York"}]){
    const f=fixture(change);const c=client(f);
    await assert.rejects(()=>c.createOrder({query:MUTATION}),/DEV_SHOP_IDENTITY_OR_SETTINGS_MISMATCH/);
    assert.equal(f.calls.write,0);
  }
});
test("D0: cache refreshes using expires_in, never a hardcoded token lifetime",async()=>{
  let clock=1000000;const f=fixture({expires:3600});
  const c=client(f,{now:()=>clock});
  await c.checkShop();
  assert.equal(f.calls.token,1);
  clock+=3350*1000;
  await c.checkShop();
  assert.equal(f.calls.token,2);
});
test("D0: unreviewed GraphQL mutation not allowed by existing Shopify client",async()=>{
  const f=fixture();const c=client(f);
  await assert.rejects(()=>c.createOrder({query:"mutation { productDelete(input:{}) { userErrors {message} } }"}),
    /UNREVIEWED_MUTATION/);
  assert.equal(f.calls.write,0);
});
