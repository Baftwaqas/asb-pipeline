// ASB ADR-002 - explicitly allowlisted DEV-store Shopify GraphQL client.
// PROD-SAFE DEFAULT: zero permitted domains. Never use live store credentials
// or enable production writes through this module.
"use strict";
const {QuoteError}=require("./quote-crypto-v1");

function createDevShopifyClient({
  shopDomain,offlineAccessToken,devDomainAllowlist=[],
  fetchImpl=globalThis.fetch,apiVersion="2026-10"
}={}){
  if(typeof shopDomain!=="string" || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(shopDomain))
    throw new QuoteError("INVALID_SHOP_DOMAIN");
  if(!Array.isArray(devDomainAllowlist) || !devDomainAllowlist.includes(shopDomain))
    throw new QuoteError("DEV_STORE_NOT_EXPLICITLY_ALLOWLISTED");
  if(typeof offlineAccessToken!=="string" || offlineAccessToken.length<10)
    throw new QuoteError("OFFLINE_TOKEN_REQUIRED");
  if(apiVersion!=="2026-10")throw new QuoteError("UNREVIEWED_API_VERSION");
  if(typeof fetchImpl!=="function")throw new QuoteError("FETCH_REQUIRED");
  return {
    createOrder:async ({query,variables})=>{
      if(typeof query!=="string" || !query.includes("orderCreate("))
        throw new QuoteError("UNREVIEWED_MUTATION");
      const response=await fetchImpl(
        "https://"+shopDomain+"/admin/api/"+apiVersion+"/graphql.json",
        {method:"POST",headers:{"Content-Type":"application/json",
          "X-Shopify-Access-Token":offlineAccessToken},
         body:JSON.stringify({query,variables})}
      );
      if(!response?.ok)throw new QuoteError("SHOPIFY_HTTP_ERROR");
      const payload=await response.json();
      if(!payload || typeof payload!=="object")throw new QuoteError("SHOPIFY_INVALID_RESPONSE");
      return payload;
    }
  };
}
module.exports={createDevShopifyClient};
