// Shopify Dev Dashboard client-credentials grant for an OWNED DEV store.
// No Shopify secrets in Git, customer/browser, ChatGPT messages or logs.
// Requires an installed, separately registered dev app with write_orders.
// Production safe by default: zero allowed shops until explicit allowlist.
"use strict";
const {QuoteError}=require("./quote-crypto-v1");
const {createDevShopifyClient}=require("./dev-shopify-graphql-v1");

function createDevCredentialsShopifyClient({
  shopDomain,clientId,clientSecret,devDomainAllowlist=[],
  fetchImpl=globalThis.fetch,now=()=>Date.now()
}={}){
  if(typeof shopDomain!=="string" ||
     !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopDomain) ||
     !Array.isArray(devDomainAllowlist) || !devDomainAllowlist.includes(shopDomain))
    throw new QuoteError("DEV_STORE_NOT_EXPLICITLY_ALLOWLISTED");
  if(typeof clientId!=="string"||clientId.length<5||
     typeof clientSecret!=="string"||clientSecret.length<10)
    throw new QuoteError("DEV_APP_CREDENTIALS_REQUIRED");
  if(typeof fetchImpl!=="function"||typeof now!=="function")
    throw new QuoteError("DEV_CLIENT_CONFIG_INVALID");

  let current=null,expiresAt=0,inflight=null,currentScopes=new Set();
  async function getToken(){
    if(current&&now()<expiresAt)return current;
    if(inflight)return inflight;
    inflight=(async()=>{
      const r=await fetchImpl("https://"+shopDomain+"/admin/oauth/access_token",{
        method:"POST",
        headers:{"Content-Type":"application/x-www-form-urlencoded","Accept":"application/json"},
        body:new URLSearchParams({
          grant_type:"client_credentials",client_id:clientId,client_secret:clientSecret
        }).toString(),
        redirect:"error"
      });
      if(!r?.ok)throw new QuoteError("DEV_APP_TOKEN_REQUEST_FAILED");
      const json=await r.json();
      if(typeof json?.access_token!=="string"||json.access_token.length<16||
         !Number.isSafeInteger(json.expires_in)||json.expires_in<30||
         typeof json.scope!=="string")
        throw new QuoteError("DEV_APP_TOKEN_BAD_RESPONSE");
      const scopes=new Set(json.scope.split(/[\s,]+/).filter(Boolean));
      if(!scopes.has("write_orders"))
        throw new QuoteError("DEV_APP_WRITE_ORDERS_NOT_GRANTED");
      current=json.access_token;
      currentScopes=scopes;
      // Provider controls expiration; never assume a fixed one-day lifetime.
      expiresAt=now()+Math.max(1000,(json.expires_in-300)*1000);
      return current;
    })();
    try{return await inflight;}finally{inflight=null;}
  }

  // Token stays server-private, never returned by this object.
  async function graphql(query,variables={}){
    const token=await getToken();
    const client=createDevShopifyClient({
      shopDomain,offlineAccessToken:token,devDomainAllowlist,fetchImpl
    });
    // This module deliberately supports only the already reviewed
    // orderCreate adapter. Read-only preflight has its own local query below.
    return client.createOrder({query,variables});
  }

  async function checkShop(){
    const token=await getToken();
    const response=await fetchImpl(
      "https://"+shopDomain+"/admin/api/2026-10/graphql.json",{
        method:"POST",
        headers:{"Content-Type":"application/json","X-Shopify-Access-Token":token},
        body:JSON.stringify({query:"query ASBDevVerify { shop { myshopifyDomain currencyCode ianaTimezone } }"})
      });
    if(!response?.ok)throw new QuoteError("DEV_SHOP_CHECK_HTTP_FAILED");
    const json=await response.json();
    const s=json?.data?.shop;
    if(json.errors?.length||s?.myshopifyDomain!==shopDomain||
       s.currencyCode!=="PKR"||s.ianaTimezone!=="Asia/Karachi")
      throw new QuoteError("DEV_SHOP_IDENTITY_OR_SETTINGS_MISMATCH");
    return {shopDomain:s.myshopifyDomain,currency:s.currencyCode,timeZone:s.ianaTimezone};
  }

  // Explicit read-only Admin GraphQL API, no arbitrary query passthrough.
  // IDs come from a verified founder release, NOT a browser request.
  async function readProductsForPolicy({productGids}={}){
    if(!Array.isArray(productGids)||productGids.length===0||
       productGids.length>4000)
      throw new QuoteError("APNA_CATALOG_PRODUCT_IDS_REQUIRED");
    const valid=/^gid:\/\/shopify\/Product\/[1-9][0-9]*$/;
    const seen=new Set();
    for(const id of productGids){
      if(typeof id!=="string"||!valid.test(id)||seen.has(id))
        throw new QuoteError("APNA_CATALOG_PRODUCT_ID_INVALID");
      seen.add(id);
    }
    await checkShop();
    const q=[
      "query ASBDevApnaCatalogue($ids:[ID!]!) {",
      "nodes(ids:$ids) { __typename ... on Product { id title status",
      "variants(first:100) { nodes { id title sku price }",
      "pageInfo { hasNextPage } } } } }"
    ].join(" ");
    const products=[];
    for(let i=0;i<productGids.length;i+=5){
      const ids=productGids.slice(i,i+5);
      const token=await getToken();
      if(!currentScopes.has("read_products"))
        throw new QuoteError("DEV_APP_READ_PRODUCTS_NOT_GRANTED");
      const response=await fetchImpl(
        "https://"+shopDomain+"/admin/api/2026-10/graphql.json",{
          method:"POST",redirect:"error",
          headers:{"Content-Type":"application/json",
            "X-Shopify-Access-Token":token},
          body:JSON.stringify({query:q,variables:{ids}})
        });
      if(!response?.ok)
        throw new QuoteError("APNA_SHOPIFY_CATALOG_HTTP_FAILED");
      const json=await response.json();
      if(json?.errors?.length||!Array.isArray(json?.data?.nodes)||
         json.data.nodes.length!==ids.length)
        throw new QuoteError("APNA_SHOPIFY_CATALOG_RESPONSE_INVALID");
      const byId=new Map();
      for(const node of json.data.nodes){
        if(node?.__typename!=="Product"||!ids.includes(node.id)||
           byId.has(node.id)||typeof node.title!=="string"||
           typeof node.status!=="string"||
           !Array.isArray(node.variants?.nodes)||
           typeof node.variants?.pageInfo?.hasNextPage!=="boolean")
          throw new QuoteError("APNA_SHOPIFY_CATALOG_INCOMPLETE");
        byId.set(node.id,{
          id:node.id,title:node.title,status:node.status,
          variants:node.variants
        });
      }
      if(byId.size!==ids.length)
        throw new QuoteError("APNA_SHOPIFY_CATALOG_MISSING_PRODUCT");
      for(const id of ids)products.push(byId.get(id));
    }
    return products;
  }


  // Read-only scope audit bound to THIS installed app's own client credentials.
  // A separate Shopify/ChatGPT app can never attest Bridge permissions.
  async function readGrantedScopesForLab(){
    await checkShop();  // existing shop/currency/timezone identity proof
    const token=await getToken();
    const query="query ASBBridgeScopeAudit { currentAppInstallation { accessScopes { handle } } }";
    const response=await fetchImpl(
      "https://"+shopDomain+"/admin/api/2026-10/graphql.json",{
        method:"POST",redirect:"error",
        headers:{"Content-Type":"application/json",
          "X-Shopify-Access-Token":token},
        body:JSON.stringify({query})
      });
    if(!response?.ok)throw new QuoteError("DEV_SCOPE_AUDIT_HTTP_FAILED");
    const json=await response.json();
    const values=json?.data?.currentAppInstallation?.accessScopes;
    if(json?.errors?.length||!Array.isArray(values)||values.some(x=>
      typeof x?.handle!=="string"||!x.handle.length))
      throw new QuoteError("DEV_SCOPE_AUDIT_INVALID_RESPONSE");
    const installed=new Set(values.map(x=>x.handle));
    const required=["read_products","write_orders","write_order_edits"];
    const granted=required.filter(x=>installed.has(x)&&currentScopes.has(x));
    // Token-grant response and GraphQL installation must agree on each
    // required scope; inconsistency is a failure, never treated as approval.
    const disagree=required.some(x=>installed.has(x)!==currentScopes.has(x));
    if(disagree)throw new QuoteError("DEV_SCOPE_AUDIT_GRANT_MISMATCH");
    return Object.freeze({
      shopDomain,ready:granted.length===required.length,
      readProducts:granted.includes("read_products"),
      writeOrders:granted.includes("write_orders"),
      writeOrderEdits:granted.includes("write_order_edits")
    });
  }

  async function createOrder({query,variables}={}){
    await checkShop();  // fail closed BEFORE an irreversible orderCreate.
    return graphql(query,variables);
  }
  return {checkShop,createOrder,readProductsForPolicy,readGrantedScopesForLab};
}
module.exports={createDevCredentialsShopifyClient};
