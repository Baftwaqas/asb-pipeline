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


  // Server-private, READ-ONLY Shopify order metadata for a single explicitly
  // named LAB order. No arbitrary GraphQL, customer contact data or writes.
  async function readLabOrderForAmendment({orderGid}={}){
    if(!/^gid:\/\/shopify\/Order\/[1-9][0-9]*$/.test(orderGid||""))
      throw new QuoteError("LAB_ORDER_EDIT_INVALID_ORDER_GID");
    await checkShop();
    const token=await getToken();
    if(!currentScopes.has("write_orders")||!currentScopes.has("write_order_edits"))
      throw new QuoteError("LAB_ORDER_EDIT_SCOPE_NOT_GRANTED");
    const query=[
      "query ASBReadLabOrderForAmendment($id: ID!) {",
      " order(id:$id) { id test tags createdAt currencyCode",
      " displayFinancialStatus displayFulfillmentStatus",
      " currentTotalPriceSet { shopMoney { amount currencyCode } }",
      " totalOutstandingSet { shopMoney { amount currencyCode } }",
      " lineItems(first:100) { nodes { id quantity unfulfilledQuantity",
      " variant { id sku } customAttributes { key value } }",
      " pageInfo { hasNextPage } } } }"
    ].join(" ");
    const response=await fetchImpl(
      "https://"+shopDomain+"/admin/api/2026-10/graphql.json",{
        method:"POST",redirect:"error",
        headers:{"Content-Type":"application/json","X-Shopify-Access-Token":token},
        body:JSON.stringify({query,variables:{id:orderGid}})
      });
    if(!response?.ok)throw new QuoteError("LAB_ORDER_EDIT_READ_HTTP_FAILED");
    const data=await response.json();
    const order=data?.data?.order;
    if(data?.errors?.length||!order||order.id!==orderGid||
      !Array.isArray(order.tags)||!Array.isArray(order.lineItems?.nodes)||
      order.lineItems.pageInfo?.hasNextPage!==false)
      throw new QuoteError("LAB_ORDER_EDIT_READ_INVALID_RESPONSE");
    if(order.test!==true||!order.tags.includes("ASB-LAB-ONLY")||
      !order.tags.includes("NEVER-FULFILL"))
      throw new QuoteError("LAB_ORDER_EDIT_NOT_SYNTHETIC_TEST_ORDER");
    if(order.currencyCode!=="PKR"||
      order.displayFinancialStatus!=="PENDING"||
      order.displayFulfillmentStatus!=="UNFULFILLED")
      throw new QuoteError("LAB_ORDER_EDIT_NOT_PENDING_UNFULFILLED");
    if(!Array.isArray(order.lineItems.nodes)||order.lineItems.nodes.some(x=>
      typeof x?.id!=="string"||
      !Number.isSafeInteger(x.quantity)||x.quantity<1||
      !Number.isSafeInteger(x.unfulfilledQuantity)||
      x.unfulfilledQuantity!==x.quantity))
      throw new QuoteError("LAB_ORDER_EDIT_NONEDITABLE_LINE");
    return order;
  }


  // Deliberately non-committing Shopify edit SESSION preview for the single
  // synthetic Apna Onion order created Nov 12. Uses real Shopify calculated
  // prices; NEVER calls orderEditCommit or writes a bill/customer notification.
  async function previewLabApnaOnionUncommitted({
    orderGid,operatorApproval,previewMode
  }={}){
    const TARGET="gid://shopify/Order/19011998580770";
    const ONEKG="gid://shopify/ProductVariant/69644381716514";
    if(orderGid!==TARGET||
       operatorApproval!=="ASB_LAB_APNA_ONION_STAGE_ONLY"||
       previewMode!=="STAGE_WITHOUT_COMMIT")
      throw new QuoteError("LAB_APNA_PREVIEW_NOT_ARMED");
    const order=await readLabOrderForAmendment({orderGid:TARGET});
    const {parseMoneyAsPaisa}=require("./ordercreate-v1");
    const first=order.lineItems?.nodes?.[0];
    const props=new Map((first?.customAttributes||[]).map(x=>[x.key,x.value]));
    const money=order.currentTotalPriceSet?.shopMoney;
    const outstanding=order.totalOutstandingSet?.shopMoney;
    if(!order.tags.includes("ASB-APNA-AMENDMENT-TARGET")||
       !order.tags.includes("ASB-CYCLE-MON-2026-11-16")||
       order.lineItems.nodes.length!==1||
       first?.variant?.id!=="gid://shopify/ProductVariant/69644381683746"||
       first?.quantity!==1||
       props.get("_asb_door")!=="apna_order"||
       props.get("_asb_product")!=="ASB-CANON-ONION"||
       money?.currencyCode!=="PKR"||
       outstanding?.currencyCode!=="PKR"||
       parseMoneyAsPaisa(money.amount)!==4500||
       parseMoneyAsPaisa(outstanding.amount)!==4500)
      throw new QuoteError("LAB_APNA_PREVIEW_SOURCE_NOT_ELIGIBLE");
    const granted=await readGrantedScopesForLab();
    if(!granted.ready)throw new QuoteError("LAB_APNA_PREVIEW_SCOPE_NOT_GRANTED");
    const token=await getToken();
    async function fixedMutation(query,variables,key){
      const response=await fetchImpl(
        "https://"+shopDomain+"/admin/api/2026-10/graphql.json",{
          method:"POST",redirect:"error",
          headers:{"Content-Type":"application/json",
            "X-Shopify-Access-Token":token},
          body:JSON.stringify({query,variables})
        });
      if(!response?.ok)throw new QuoteError("LAB_APNA_PREVIEW_HTTP_UNCERTAIN");
      const json=await response.json();
      const entry=json?.data?.[key];
      if(json?.errors?.length||!entry||
         !Array.isArray(entry.userErrors)||entry.userErrors.length||
         !entry.calculatedOrder?.id)
        throw new QuoteError("LAB_APNA_PREVIEW_SHOPIFY_REJECTED");
      const co=entry.calculatedOrder;
      if(!/^gid:\/\/shopify\/CalculatedOrder\/[1-9][0-9]*$/.test(co.id))
        throw new QuoteError("LAB_APNA_PREVIEW_INVALID_CALCULATED_ORDER");
      return co;
    }
    const beginQuery=[
      "mutation ASBLabApnaOnionBegin($id:ID!){",
      " orderEditBegin(id:$id){ calculatedOrder {id",
      " totalPriceSet{shopMoney{amount currencyCode}}",
      " totalOutstandingSet{shopMoney{amount currencyCode}}}",
      " userErrors{field message}}}"
    ].join(" ");
    const addedQuery=[
      "mutation ASBLabApnaOnionAdd($id:ID!,$variantId:ID!,$quantity:Int!){",
      " orderEditAddVariant(id:$id,variantId:$variantId,quantity:$quantity,allowDuplicates:false){",
      " calculatedOrder{id totalPriceSet{shopMoney{amount currencyCode}}",
      " totalOutstandingSet{shopMoney{amount currencyCode}}}",
      " userErrors{field message}}}"
    ].join(" ");
    const stage=await fixedMutation(beginQuery,{id:TARGET},"orderEditBegin");
    if(stage.totalPriceSet?.shopMoney?.currencyCode!=="PKR"||
       parseMoneyAsPaisa(stage.totalPriceSet.shopMoney.amount)!==4500)
      throw new QuoteError("LAB_APNA_PREVIEW_ORIGINAL_MONEY_CHANGED");
    const preview=await fixedMutation(addedQuery,{
      id:stage.id,variantId:ONEKG,quantity:1
    },"orderEditAddVariant");
    if(preview.id!==stage.id||
       preview.totalPriceSet?.shopMoney?.currencyCode!=="PKR"||
       preview.totalOutstandingSet?.shopMoney?.currencyCode!=="PKR"||
       parseMoneyAsPaisa(preview.totalPriceSet.shopMoney.amount)!==13500||
       parseMoneyAsPaisa(preview.totalOutstandingSet.shopMoney.amount)!==13500)
      throw new QuoteError("LAB_APNA_PREVIEW_FINAL_MONEY_MISMATCH");
    return Object.freeze({
      state:"STAGED_ONLY_NOT_COMMITTED",
      calculatedOrderId:preview.id,
      originalPaisa:4500,additionalPaisa:9000,expectedFinalPaisa:13500,
      orderModified:false,billSent:false,
      explicitNoCommit:true
    });
  }

  // Strict, server-private independent order read for real lab reconciliation.
  // No phone, email, address, tokens or customer records are requested.
  async function readLabOrderForCommitReconcile({orderGid}={}){
    const target="gid://shopify/Order/19011998580770";
    if(shopDomain!=="asb-checkout-lab.myshopify.com"||orderGid!==target)
      throw new QuoteError("LAB_REAL_COMMIT_WRONG_ORDER_OR_SHOP");
    const grant=await readGrantedScopesForLab();
    if(!grant.ready)throw new QuoteError("LAB_REAL_COMMIT_SCOPES_NOT_GRANTED");
    const token=await getToken();
    const query=[
      "query ASBLabCommitReadback($id:ID!){order(id:$id){",
      "id test edited tags currencyCode displayFinancialStatus displayFulfillmentStatus",
      "currentTotalPriceSet{shopMoney{amount currencyCode}}",
      "totalOutstandingSet{shopMoney{amount currencyCode}}",
      "currentSubtotalPriceSet{shopMoney{amount currencyCode}}",
      "currentTotalTaxSet{shopMoney{amount currencyCode}}",
      "currentTotalDiscountsSet{shopMoney{amount currencyCode}}",
      "currentShippingPriceSet{shopMoney{amount currencyCode}}",
      "totalReceivedSet{shopMoney{amount currencyCode}}",
      "lineItems(first:100){nodes{id quantity unfulfilledQuantity",
      "variant{id sku} customAttributes{key value}}",
      "pageInfo{hasNextPage}}}}"
    ].join(" ");
    const response=await fetchImpl(
      "https://"+shopDomain+"/admin/api/2026-10/graphql.json",{
        method:"POST",redirect:"error",
        headers:{"Content-Type":"application/json",
          "X-Shopify-Access-Token":token},
        body:JSON.stringify({query,variables:{id:target}})
      });
    if(!response?.ok)throw new QuoteError("LAB_REAL_COMMIT_READBACK_HTTP_FAILED");
    const parsed=await response.json();
    if(parsed?.errors?.length||parsed?.data?.order?.id!==target||
       !Array.isArray(parsed.data.order.lineItems?.nodes)||
       parsed.data.order.lineItems.pageInfo?.hasNextPage!==false)
      throw new QuoteError("LAB_REAL_COMMIT_READBACK_INCOMPLETE");
    return parsed.data.order;
  }

  // FINALIZER is not exposed by any HTTP route, Render startup script, or UI.
  // A reviewed lab-only operator entrypoint must explicitly configure BOTH
  // flags and provide the DB-committed one-shot intent before calling it.
  // This method executes EXACTLY ONE GraphQL request; NO retries.
  async function commitLabStagedOrderEdit({
    shopifyOrderGid,calculatedOrderGid,
    durableIntentRecorded=false,operatorGate
  }={}){
    if(shopDomain!=="asb-checkout-lab.myshopify.com"||
       shopifyOrderGid!=="gid://shopify/Order/19011998580770"||
       !/^gid:\/\/shopify\/CalculatedOrder\/[1-9][0-9]*$/.test(calculatedOrderGid||"")||
       durableIntentRecorded!==true||
       operatorGate!=="DURABLE_LAB_COMMIT_INTENT_VERIFIED"||
       process.env.ASB_LAB_REAL_COMMIT!=="REVIEWED_ONE_SHOT_ONLY"||
       process.env.ASB_LAB_WRITE_MODE!=="lab-commit-single-attempt")
      throw new QuoteError("LAB_REAL_COMMIT_NOT_AUTHORIZED");
    const grant=await readGrantedScopesForLab();
    if(!grant.ready)throw new QuoteError("LAB_REAL_COMMIT_SCOPES_NOT_GRANTED");
    const token=await getToken();
    const query=[
      "mutation ASBLabCommitOnce($id:ID!){",
      "orderEditCommit(id:$id,notifyCustomer:false,",
      'staffNote:"ASB LAB synthetic Onion amendment, verified one-shot; DO NOT FULFILL"){',
      "order{id} successMessages userErrors{field message}}}"
    ].join(" ");
    let response,body;
    try{
      response=await fetchImpl(
        "https://"+shopDomain+"/admin/api/2026-10/graphql.json",{
          method:"POST",redirect:"error",
          headers:{"Content-Type":"application/json",
            "X-Shopify-Access-Token":token},
          body:JSON.stringify({query,variables:{id:calculatedOrderGid}})
        });
      if(!response?.ok)throw new Error("HTTP_NOT_OK");
      body=await response.json();
    }catch{
      throw new QuoteError("LAB_REAL_COMMIT_OUTCOME_UNCERTAIN");
    }
    const r=body?.data?.orderEditCommit;
    if(body?.errors?.length||!r||!Array.isArray(r.userErrors)||
      r.userErrors.length||r.order?.id!==shopifyOrderGid)
      throw new QuoteError("LAB_REAL_COMMIT_OUTCOME_UNCERTAIN");
    // Mutation acknowledgment is NOT confirmation; independent order read is mandatory.
    return {state:"mutation_acknowledged_needs_readback",
      shopifyOrderGid,notified:false,reconciled:false};
  }

  async function createOrder({query,variables}={}){
    await checkShop();  // fail closed BEFORE an irreversible orderCreate.
    return graphql(query,variables);
  }
  return {checkShop,createOrder,readProductsForPolicy,readGrantedScopesForLab,readLabOrderForAmendment,previewLabApnaOnionUncommitted,
    readLabOrderForCommitReconcile,commitLabStagedOrderEdit};
}
module.exports={createDevCredentialsShopifyClient};
