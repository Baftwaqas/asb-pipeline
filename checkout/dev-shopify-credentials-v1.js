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

  let current=null,expiresAt=0,inflight=null;
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
  async function createOrder({query,variables}={}){
    await checkShop();  // fail closed BEFORE an irreversible orderCreate.
    return graphql(query,variables);
  }
  return {checkShop,createOrder};
}
module.exports={createDevCredentialsShopifyClient};
