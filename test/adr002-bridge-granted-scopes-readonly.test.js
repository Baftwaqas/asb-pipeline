"use strict";
// Test Bridge's exact client-credentials scope proof: no external requests.
const test=require("node:test"),assert=require("node:assert/strict");
const {createDevCredentialsShopifyClient}=
  require("../checkout/dev-shopify-credentials-v1");
const SHOP="asb-checkout-lab.myshopify.com";
const TOKEN="shpat_FAKE_SCOPE_AUDIT_TOKEN_01234567890123";
function fake({tokenScopes="read_products,write_orders,write_order_edits",
  appScopes=["read_products","write_orders","write_order_edits"],
  domain=SHOP,wrongGraphQL=false}={}){
  const calls={token:0,shop:0,scope:0,mutations:0};
  const fetchImpl=async(url,init)=>{
    if(url.endsWith("/admin/oauth/access_token")){
      calls.token++;
      const p=new URLSearchParams(init.body);
      assert.equal(p.get("grant_type"),"client_credentials");
      assert.equal(p.has("scope"),false);
      return {ok:true,json:async()=>({access_token:TOKEN,scope:tokenScopes,expires_in:86399})};
    }
    assert.equal(url,"https://"+SHOP+"/admin/api/2026-10/graphql.json");
    assert.equal(init.headers["X-Shopify-Access-Token"],TOKEN);
    const body=JSON.parse(init.body);
    assert.ok(body.query.startsWith("query "));
    if(body.query.includes("ASBDevVerify")){
      calls.shop++;
      return {ok:true,json:async()=>({data:{shop:{
        myshopifyDomain:domain,currencyCode:"PKR",ianaTimezone:"Asia/Karachi"
      }}})};
    }
    if(body.query.includes("currentAppInstallation")){
      calls.scope++;
      return {ok:true,json:async()=>wrongGraphQL?{errors:[{message:"denied"}]}:
        {data:{currentAppInstallation:{accessScopes:appScopes.map(handle=>({handle}))}}}};
    }
    calls.mutations++;throw Error("MUTATION_FORBIDDEN_IN_SCOPE_PROBE");
  };
  const client=createDevCredentialsShopifyClient({
    shopDomain:SHOP,devDomainAllowlist:[SHOP],
    clientId:"BRIDGE-TEST-CLIENT-ID",clientSecret:"BRIDGE-TEST-CLIENT-SECRET",
    fetchImpl
  });
  return {calls,client};
}
test("granted all three Bridge scopes; neither read_orders nor a Shopify write is needed",async()=>{
  const f=fake();
  const r=await f.client.readGrantedScopesForLab();
  assert.deepEqual(r,{shopDomain:SHOP,ready:true,
    readProducts:true,writeOrders:true,writeOrderEdits:true});
  assert.deepEqual(f.calls,{token:1,shop:1,scope:1,mutations:0});
  assert.equal(JSON.stringify(r).includes(TOKEN),false);
});
test("new write_order_edits grant missing: return not ready even after version release",async()=>{
  const f=fake({tokenScopes:"read_products,write_orders",
    appScopes:["read_products","write_orders"]});
  const r=await f.client.readGrantedScopesForLab();
  assert.equal(r.ready,false);assert.equal(r.writeOrderEdits,false);
  assert.equal(f.calls.mutations,0);
});
test("token and installation disagree: refuse rather than infer granted access",async()=>{
  const f=fake({tokenScopes:"read_products,write_orders",
    appScopes:["read_products","write_orders","write_order_edits"]});
  await assert.rejects(()=>f.client.readGrantedScopesForLab(),
    /DEV_SCOPE_AUDIT_GRANT_MISMATCH/);
});
test("invalid GraphQL installation response or identity blocks proof",async()=>{
  const a=fake({wrongGraphQL:true});
  await assert.rejects(()=>a.client.readGrantedScopesForLab(),
    /DEV_SCOPE_AUDIT_INVALID_RESPONSE/);
  const b=fake({domain:"another-shop.myshopify.com"});
  await assert.rejects(()=>b.client.readGrantedScopesForLab(),
    /DEV_SHOP_IDENTITY_OR_SETTINGS_MISMATCH/);
  assert.equal(b.calls.scope,0);
});
test("separate Shopify connector cannot substitute for Bridge app identity",()=>{
  assert.throws(()=>createDevCredentialsShopifyClient({
    shopDomain:"production.myshopify.com",devDomainAllowlist:[SHOP],
    clientId:"BRIDGE-TEST-CLIENT-ID",clientSecret:"BRIDGE-TEST-CLIENT-SECRET"
  }),/DEV_STORE_NOT_EXPLICITLY_ALLOWLISTED/);
});
