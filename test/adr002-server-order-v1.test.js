// ADR-002 T0/T1/T3 - server-order adapter isolated tests, no network.
"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {signQuote,verifySignedQuote,QuoteError}=require("../checkout/quote-crypto-v1");
const {buildOrderCreateInput,money,parseMoneyAsPaisa}=require("../checkout/ordercreate-v1");
const {confirmCodOrder,redemptionKeyFor}=require("../checkout/redemption-v1");
const {createDevShopifyClient}=require("../checkout/dev-shopify-graphql-v1");

const SECRET="test-only-not-for-production-use-0123456789-sufficiently-long";
const NOW="2026-11-05T10:10:00Z";
const lin=(lineId,door,variant,kind,qty,paisa,cap,provenance,extras={})=>({
  lineId,door,shopifyVariantGid:"gid://shopify/ProductVariant/"+variant,
  canonicalProductId:"ASB-CANON-"+variant,sku:null,productName:"Test Product "+variant,
  merchandiseKind:kind,unit:"g",qty,sellUnitLabel:String(qty)+" g",
  heroTier:null,provenance,ceilingLinePaisa:cap,quotedLinePaisa:paisa,...extras
});
const makeQuote=()=>signQuote({
  quoteId:"Q-DEV-TEST-1",version:1,issuedAt:"2026-11-05T10:00:00Z",
  expiresAt:"2026-11-05T10:20:00Z",cycleCode:"MON-2026-11-09",
  deliveryDate:"2026-11-09",customerReference:"household-A",currency:"PKR",
  lines:[
    lin("L1","apna_order",101,"grocery",125,8700,9000,{kind:"apna_selection"}),
    lin("L2","dish_to_cart",102,"grocery",40,1850,2000,{kind:"recipe",recipeIds:["RCP-000007"]}),
    lin("L3","community_order",103,"grocery",10000,150027,155000,{kind:"community_pack"},
      {heroTier:{heroWeekId:"H-TEST",tierId:"ONION-10KG"}})
  ],
  communityEligibilityByDoor:{
    community_order:{qualifyingCeilingPaisa:155000,eligible:true},
    dish_to_cart:{qualifyingCeilingPaisa:0,eligible:false},
    budget_to_cart:{qualifyingCeilingPaisa:0,eligible:false}
  },
  quotedTotalPaisa:160577,ceilingTotalPaisa:166000
},SECRET);
const CUSTOMER={householdKey:"household-A",phone:"923001234567",addressVerified:true,
  firstName:"Test",lastName:"Buyer",shippingAddress:{
    address1:"Block Test, Flat 4",address2:"Near Test Gate",city:"Karachi",countryCode:"PK"
  }
};
const identity={serverAuthenticated:true,phoneVerified:true,householdKey:"household-A",phone:"923001234567"};
function storage(quote=makeQuote()){
  let state=null,orderId=null,needsCount=0;
  return {
    quoteStore:{
      loadCurrentQuote:async(id)=>id===quote.quoteId?quote:null,
      loadCustomer:async(key)=>key===CUSTOMER.householdKey?CUSTOMER:null
    },
    ledger:{
      claimQuote:async ({quote:q,identity:i,redemptionKey,at})=>{
        assert.equal(q.quoteId,quote.quoteId);
        assert.equal(i.householdKey,identity.householdKey);
        assert.equal(redemptionKey,redemptionKeyFor(q.quoteId,q.version));
        assert.equal(at,new Date(NOW).toISOString());
        if(state==="completed")return {state:"completed",shopifyOrderGid:orderId};
        if(state)return {state};
        // Durable DB implementation must perform this under Postgres lock.
        state="creating";
        return {state:"claimed",claimId:"claim-A"};
      },
      completeQuote:async({shopifyOrderGid})=>{state="completed";orderId=shopifyOrderGid;},
      needsReconcile:async()=>{state="needs_reconcile";needsCount++;}
    },
    getState:()=>state,getReconcileCalls:()=>needsCount
  };
}
function expectedTotal(variables){
  const prices=variables.order.lineItems.map(i=>parseMoneyAsPaisa(i.priceSet.shopMoney.amount));
  const shipping=variables.order.shippingLines.reduce(
    (sum,s)=>sum+parseMoneyAsPaisa(s.priceSet.shopMoney.amount),0);
  return prices.reduce((a,b)=>a+b,0)+shipping;
}
function fakeShopify(){
  let calls=0,last=null,block=null;
  return {
    get calls(){return calls;},get last(){return last;},
    async createOrder({query,variables}){
      calls++;last={query,variables};
      if(block)await block;
      return {data:{orderCreate:{userErrors:[],order:{
        id:"gid://shopify/Order/987",displayFinancialStatus:"PENDING",
        currentTotalPriceSet:{shopMoney:{amount:money(expectedTotal(variables)),currencyCode:"PKR"}}
      }}}};
    },
    setBlock:p=>{block=p;}
  };
}
function run(opts={}){
  const store=opts.store||storage();
  const shopify=opts.shopify||fakeShopify();
  return {store,shopify,result:()=>confirmCodOrder({
    request:opts.request||{quoteId:"Q-DEV-TEST-1",version:1,signature:makeQuote().serverSignature},
    identity:opts.identity||identity,quoteStore:store.quoteStore,ledger:store.ledger,
    shopify,quoteSecret:SECRET,now:()=>new Date(opts.now||NOW),
    taxesDisabledApproved:true
  })};
}

test("T3 canonical HMAC authenticates nested quote regardless of key order",()=>{
  const signed=makeQuote();
  assert.equal(verifySignedQuote(signed,SECRET),true);
  assert.equal(verifySignedQuote({...signed,version:2},SECRET),false);
  assert.equal(verifySignedQuote({...signed,lines:[{...signed.lines[0],qty:40},...signed.lines.slice(1)]},SECRET),false);
  assert.equal(verifySignedQuote({...signed,lines:[{...signed.lines[0],door:"community_order"},...signed.lines.slice(1)]},SECRET),false);
  assert.equal(verifySignedQuote({...signed,lines:[...signed.lines.slice(0,2),
    {...signed.lines[2],heroTier:{heroWeekId:"H-TEST",tierId:"FORGED"}}]},SECRET),false);
  assert.equal(verifySignedQuote({...signed,quotedTotalPaisa:1},SECRET),false);
});
test("T1 makes three feature-specific Shopify items but ONE pending COD order",()=>{
  const q=makeQuote(),p=buildOrderCreateInput({quote:q,customer:CUSTOMER,
    redemptionKey:"R-1",taxesDisabledApproved:true});
  assert.equal(p.variables.order.lineItems.length,3);
  assert.deepEqual(p.variables.order.lineItems.map(l=>l.quantity),[1,1,1]);
  assert.deepEqual(p.variables.order.lineItems.map(l=>l.variantId),
    q.lines.map(l=>l.shopifyVariantGid));
  assert.deepEqual(p.variables.order.lineItems.map(l=>
    l.properties.find(prop=>prop.name==="_asb_door").value),
    ["apna_order","dish_to_cart","community_order"]);
  assert.equal(p.variables.order.lineItems[1].properties.find(prop=>prop.name==="_asb_qty").value,"40");
  assert.equal(p.variables.order.lineItems[1].weight.value,0.04);
  assert.equal(p.variables.order.financialStatus,"PENDING");
  assert.equal(p.variables.order.currency,"PKR");
  assert.equal(p.variables.order.shippingLines[0].priceSet.shopMoney.amount,"0.00");
  assert.equal(p.variables.options.inventoryBehaviour,"BYPASS");
  assert.equal(p.variables.options.sendReceipt,false);
  assert.equal(p.expectedCodPaisa,160500);
  assert.equal(p.roundingCreditPaisa,77);
  assert.equal(expectedTotal(p.variables),p.expectedCodPaisa);
  assert.ok(p.variables.order.customAttributes.some(x=>x.key==="asb_quote_id"&&x.value==="Q-DEV-TEST-1"));
  assert.ok(p.variables.order.lineItems[2].properties.some(x=>x.name==="_asb_hero_tier"&&x.value==="ONION-10KG"));
});
test("T1 a successful fake Shopify response is reconciled to exact COD payable",async()=>{
  const x=run();const result=await x.result();
  assert.equal(result.status,"created");
  assert.equal(result.codPaisa,160500);
  assert.equal(x.shopify.calls,1);
  assert.equal(x.store.getState(),"completed");
});
test("T0 idempotent retry of completed quote returns same Shopify order ID",async()=>{
  const x=run();
  const first=await x.result(),again=await x.result();
  assert.equal(first.status,"created");
  assert.equal(again.status,"already_created");
  assert.equal(again.shopifyOrderGid,first.shopifyOrderGid);
  assert.equal(x.shopify.calls,1);
});
test("T0 concurrent redemption cannot call Shopify twice",async()=>{
  let release;const blocker=new Promise(resolve=>{release=resolve;});
  const shopify=fakeShopify();shopify.setBlock(blocker);
  const x=run({shopify});
  const first=x.result(); // asynchronous reservation then network
  await new Promise(resolve=>setImmediate(resolve));
  const second=await x.result();
  assert.equal(second.status,"needs_reconcile");
  assert.equal(shopify.calls,1);
  release();
  assert.equal((await first).status,"created");
  assert.equal((await x.result()).status,"already_created");
  assert.equal(shopify.calls,1);
});
test("T0 ambiguous network timeout is not automatically retried",async()=>{
  let calls=0;
  const shopify={async createOrder(){calls++;throw new Error("simulated network timeout");}};
  const x=run({shopify});
  assert.equal((await x.result()).status,"needs_reconcile");
  assert.equal((await x.result()).status,"needs_reconcile");
  assert.equal(calls,1);
  assert.equal(x.store.getState(),"needs_reconcile");
});
test("T0 response without order ID is held for reconciliation",async()=>{
  const shopify={createOrder:async()=>({data:{orderCreate:{userErrors:[{message:"invalid variant"}],order:null}}})};
  const x=run({shopify});
  assert.equal((await x.result()).status,"needs_reconcile");
  assert.equal(x.store.getState(),"needs_reconcile");
});
test("T1 Shopify totals higher than ASB quote stop confirmation",async()=>{
  const shopify={createOrder:async()=>({data:{orderCreate:{userErrors:[],order:{
    id:"gid://shopify/Order/666",displayFinancialStatus:"PENDING",
    currentTotalPriceSet:{shopMoney:{amount:"1800.00",currencyCode:"PKR"}}
  }}}})};
  const x=run({shopify});
  const r=await x.result();
  assert.equal(r.status,"needs_reconcile");
  assert.equal(r.reason,"SHOPIFY_TOTAL_OR_PAYMENT_MISMATCH");
  assert.equal(x.store.getState(),"needs_reconcile");
  assert.equal(x.store.getReconcileCalls(),1);
});
test("T1 a paid Shopify order is held, not misrepresented as COD",async()=>{
  const shopify={createOrder:async()=>({data:{orderCreate:{userErrors:[],order:{
    id:"gid://shopify/Order/666",displayFinancialStatus:"PAID",
    currentTotalPriceSet:{shopMoney:{amount:"1605.00",currencyCode:"PKR"}}
  }}}})};
  assert.equal((await run({shopify}).result()).status,"needs_reconcile");
});
test("T3 tampered price and door fail before reservations or network",async()=>{
  const signed=makeQuote();
  for(const bad of [
    {...signed,lines:signed.lines.map((x,i)=>i===0?{...x,quotedLinePaisa:1}:x)},
    {...signed,lines:signed.lines.map((x,i)=>i===0?{...x,door:"community_order"}:x)}
  ]){
    let called=0;
    const store={quoteStore:{
      loadCurrentQuote:async()=>bad,
      loadCustomer:async()=>CUSTOMER
    },ledger:{claimQuote:async()=>{called++;throw Error("must not call");},
      completeQuote:async()=>{},needsReconcile:async()=>{}}};
    await assert.rejects(run({store}).result(),/QUOTE_AUTHENTICATION_FAILED/);
    assert.equal(called,0);
  }
});
test("T3 expired or obsolete quote cannot reach ledger",async()=>{
  await assert.rejects(run({now:"2026-11-05T10:20:00Z"}).result(),/QUOTE_EXPIRED/);
  await assert.rejects(run({request:{quoteId:"Q-DEV-TEST-1",version:2,signature:makeQuote().serverSignature}}).result(),/QUOTE_AUTHENTICATION_FAILED/);
});
test("T3 customer identity is NOT inferred from app-proxy origin",async()=>{
  const wrong={...identity,householdKey:"household-B"};
  await assert.rejects(run({identity:wrong}).result(),/HOUSEHOLD_MISMATCH/);
  await assert.rejects(run({identity:{...identity,serverAuthenticated:false}}).result(),/CUSTOMER_NOT_AUTHENTICATED/);
});
test("T3 missing server-approved tax policy refuses checkout",()=>{
  assert.throws(()=>buildOrderCreateInput({quote:makeQuote(),customer:CUSTOMER,redemptionKey:"R"}),/TAX_POLICY_NOT_VERIFIED/);
});
test("T3 each line's pricing, packing unit and provenance are validated",()=>{
  const q=makeQuote();
  for(const bad of [
    {...q,quotedTotalPaisa:1},
    {...q,lines:[{...q.lines[0],unit:"kg"},...q.lines.slice(1)]},
    {...q,lines:[{...q.lines[0],merchandiseKind:"non_grocery"},...q.lines.slice(1)]},
    {...q,lines:[{...q.lines[0],heroTier:{tierId:"FORGED",heroWeekId:"H"}},...q.lines.slice(1)]},
    {...q,lines:[{...q.lines[0],shopifyVariantGid:null},...q.lines.slice(1)]},
    {...q,lines:[{...q.lines[0],provenance:{kind:"community_pack"}},...q.lines.slice(1)]}
  ])assert.throws(()=>buildOrderCreateInput({quote:bad,customer:CUSTOMER,redemptionKey:"R",taxesDisabledApproved:true}),QuoteError);
});
test("no cross-door pooling or pricing authority is invented by adapter",()=>{
  const q=makeQuote();
  const p=buildOrderCreateInput({quote:q,customer:CUSTOMER,redemptionKey:"R",taxesDisabledApproved:true});
  assert.equal(p.variables.order.lineItems[0].properties.find(x=>x.name==="_asb_door").value,"apna_order");
  assert.ok(!p.variables.order.lineItems[0].properties.some(x=>x.name==="_asb_hero_tier"));
});
test("Bhao Tao is only eligible for non-grocery",()=>{
  const q=makeQuote();
  const bhao={...q.lines[0],door:"bhao_tao",merchandiseKind:"non_grocery",
    provenance:{kind:"bhao_offer",offerId:"O1"},heroTier:null};
  const revised={...q,lines:[bhao,...q.lines.slice(1)]};
  const p=buildOrderCreateInput({quote:revised,customer:CUSTOMER,redemptionKey:"R",taxesDisabledApproved:true});
  assert.equal(p.variables.order.lineItems.length,3);
  assert.throws(()=>buildOrderCreateInput({quote:{...revised,lines:[{...bhao,merchandiseKind:"grocery"},...q.lines.slice(1)]},
    customer:CUSTOMER,redemptionKey:"R",taxesDisabledApproved:true}),/WRONG_DOOR_PRODUCT_TYPE/);
});
test("cash rounding allocates credits even if no single line holds all 99 paisa",()=>{
  const q=makeQuote();
  const raw=Array.from({length:199},(_,i)=>lin("T"+i,"apna_order",101+i,"grocery",1,1,1,{kind:"apna_selection"}));
  const many={...q,lines:raw,quotedTotalPaisa:199,ceilingTotalPaisa:199};
  const p=buildOrderCreateInput({quote:many,customer:CUSTOMER,redemptionKey:"R",taxesDisabledApproved:true});
  assert.equal(p.roundingCreditPaisa,99);
  assert.equal(p.expectedCodPaisa,100);
  assert.equal(expectedTotal(p.variables),100);
});
test("money formatting and decimal response parsing never use float rounding",()=>{
  assert.equal(money(5417),"54.17");
  assert.equal(parseMoneyAsPaisa("1605.00"),160500);
  assert.equal(parseMoneyAsPaisa("54.1"),5410);
  assert.throws(()=>parseMoneyAsPaisa("54.123"),/SHOPIFY_INVALID_MONEY/);
});
test("dev-store transport refuses every non-allowlisted shop by default",async()=>{
  assert.throws(()=>createDevShopifyClient({shopDomain:"asb-prod.myshopify.com",
    offlineAccessToken:"dev-example-token"}),/DEV_STORE_NOT_EXPLICITLY_ALLOWLISTED/);
  assert.throws(()=>createDevShopifyClient({shopDomain:"apnasastabazaar.com",
    offlineAccessToken:"dev-example-token",devDomainAllowlist:["apnasastabazaar.com"]}),/INVALID_SHOP_DOMAIN/);
  let hit=null;
  const client=createDevShopifyClient({
    shopDomain:"asb-development.myshopify.com",
    offlineAccessToken:"test-only-0123456789",
    devDomainAllowlist:["asb-development.myshopify.com"],
    fetchImpl:async(url,options)=>{
      hit={url,options};
      return {ok:true,json:async()=>({data:{orderCreate:{order:{id:"gid://shopify/Order/1"}}}})};
    }
  });
  await client.createOrder({query:"mutation { orderCreate(...) }",variables:{order:{}}});
  assert.equal(hit.url,"https://asb-development.myshopify.com/admin/api/2026-10/graphql.json");
  assert.equal(hit.options.method,"POST");
});
