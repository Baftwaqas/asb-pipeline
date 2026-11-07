#!/usr/bin/env node
// ASB LAB ONLY — manually invoked, one idempotent synthetic Shopify COD order.
// NEVER run by the public health service; no incoming HTTP or real customer.
"use strict";
const {Pool}=require("pg");
const {assertMutationTarget,targetOf}=require("./lib/db-target-guard");
const {signQuote}=require("../checkout/quote-crypto-v1");
const {createPgRedemptionLedger}=require("../checkout/redemption-ledger-pg-v1");
const {createDevCredentialsShopifyClient}=require("../checkout/dev-shopify-credentials-v1");
const {verifyLabFixturePolicyInTransaction,SHOP}=require("../checkout/lab-fixture-policy-v1");
const {confirmCodOrder}=require("../checkout/redemption-v1");
const fixture=require("../checkout/fixtures/asb-checkout-lab.json");

const APPROVAL="ASB_LAB_ONLY_ONE_TEST_ORDER";
const DB="asb_checkout_lab_pg18";
const CASE = process.env.ASB_LAB_TEST_CASE || "A";
if(!["A","B"].includes(CASE))throw Error("UNAPPROVED_LAB_CASE");
const HOUSEHOLD="LAB-TEST-HOUSEHOLD-ONLY-"+CASE;
function preflight(){
  if(process.env.ASB_LAB_SHOP_DOMAIN!==SHOP||
     process.env.ASB_LAB_WRITE_MODE!=="disabled"||
     process.env.ASB_ENV!=="development")
    throw Error("LAB_MODE_OR_DOMAIN_GUARD_REFUSED");
  const url=process.env.DATABASE_URL;
  const target=targetOf(url);
  const DB_ID="dpg-dbm8v3qjnfac738pc31g-a";
  const allowedHosts=new Set([DB_ID,DB_ID+".internal",
    DB_ID+".singapore-postgres.render.com"]);
  if(target.database!==DB||!allowedHosts.has(target.host)||
     process.env.ASB_MUTATION_DB_NAME!==DB)
    throw Error("LAB_MUST_USE_OWN_ISOLATED_RENDER_DATABASE");
  assertMutationTarget({databaseUrl:url,
    expectedHost:target.host,expectedDatabase:DB,
    operation:"ASB LAB TEST ORDER"});
  if(typeof process.env.ASB_LAB_APP_CLIENT_ID!=="string"||
     typeof process.env.ASB_LAB_APP_CLIENT_SECRET!=="string"||
     typeof process.env.ASB_QUOTE_SECRET!=="string"||
     Buffer.byteLength(process.env.ASB_QUOTE_SECRET,"utf8")<32)
    throw Error("LAB_APP_OR_QUOTE_SECRETS_NOT_CONFIGURED");
  if(!process.argv.includes("--check-only")&&(
      !process.argv.includes("--create-single-order")||
      process.env.ASB_LAB_CLI_APPROVAL!==APPROVAL))
    throw Error("EXPLICIT_MANUAL_SINGLE_ORDER_APPROVAL_REQUIRED");
  return url;
}
function nextEligible(now){
  const karachi=new Date(now.getTime()+5*3600000);
  const start=new Date(Date.UTC(karachi.getUTCFullYear(),
    karachi.getUTCMonth(),karachi.getUTCDate()));
  for(let i=0;i<9;i++){
    const d=new Date(start.getTime()+i*86400000);
    if(d.getUTCDay()!==1&&d.getUTCDay()!==4)continue;
    // Previous local Sunday/Wednesday 20:00 = delivery midnight UTC - 9h.
    const cutoff=new Date(d.getTime()-9*3600000);
    if(now<cutoff){
      const deliveryDate=d.toISOString().slice(0,10);
      return {deliveryDate,cycleCode:(d.getUTCDay()===1?"MON-":"THU-")+deliveryDate,
        cutoff};
    }
  }
  throw Error("NO_NEXT_DELIVERY_CYCLE");
}
function moneyTotal(quote){return quote.lines.reduce((s,x)=>s+x.quotedLinePaisa,0);}
function buildQuote({cycle,now,secret}){
  const p=fixture.products;
  const l=(id,door,variant,canonical,qty,amount,kind,extras={})=>({
    lineId:id,door,shopifyVariantGid:variant.gid,
    canonicalProductId:canonical,sku:variant.sku,productName:
      door==="dish_to_cart"?"LAB ONLY Ginger":
      door==="community_order"?"LAB ONLY Community Onion":"LAB ONLY Onion",
    merchandiseKind:"grocery",unit:"g",qty,sellUnitLabel:qty>=1000?qty/1000+" kg":qty+" g",
    provenance:kind,ceilingLinePaisa:amount,quotedLinePaisa:amount,...extras
  });
  const lines=[
    l("L1","apna_order",p[0].variants[0],p[0].canonicalProductId,500,4500,
      {kind:"apna_selection"}),
    l("L2","dish_to_cart",p[1].variants[0],p[1].canonicalProductId,40,1120,
      {kind:"recipe",recipeIds:["LAB-RECIPE-001"]}),
    l("L3","community_order",p[2].variants[1],p[2].canonicalProductId,10000,150000,
      {kind:"community_pack"},{heroTier:{
        heroWeekId:"LAB-WEEK-20261109",tierId:"LAB-ONION-10KG"}})
  ];
  return signQuote({
    quoteId:"ASB-LAB-ONCE-"+CASE+"-"+cycle.cycleCode,version:1,
    issuedAt:new Date(now.getTime()-2000).toISOString(),
    expiresAt:new Date(Math.min(now.getTime()+600000,cycle.cutoff.valueOf())).toISOString(),
    cycleCode:cycle.cycleCode,deliveryDate:cycle.deliveryDate,
    customerReference:HOUSEHOLD,currency:"PKR",lines,
    communityEligibilityByDoor:{
      community_order:{qualifyingCeilingPaisa:150000,eligible:true},
      dish_to_cart:{qualifyingCeilingPaisa:0,eligible:false},
      budget_to_cart:{qualifyingCeilingPaisa:0,eligible:false}
    },
    quotedTotalPaisa:155620,ceilingTotalPaisa:155620,
    paymentSecurityState:"unsecured_cod"
  },secret);
}
async function main(){
  const url=preflight();
  const host=targetOf(url).host;
  const pool=new Pool({connectionString:url,ssl:/\.internal$/.test(host)?false:{rejectUnauthorized:false},max:4,
    connectionTimeoutMillis:10000});
  try {
    const exists=(await pool.query(
      "SELECT to_regclass('public.checkout_redemptions') IS NOT NULL AS ok")).rows[0].ok;
    if(!exists)throw Error("LAB_DATABASE_UNMIGRATED_RUN_NODE_SCRIPTS_MIGRATE_FIRST");
    const shopify=createDevCredentialsShopifyClient({
      shopDomain:SHOP,devDomainAllowlist:[SHOP],
      clientId:process.env.ASB_LAB_APP_CLIENT_ID,
      clientSecret:process.env.ASB_LAB_APP_CLIENT_SECRET
    });
    const shop=await shopify.checkShop();
    if(shop.shopDomain!==SHOP)throw Error("LAB_SHOP_VERIFICATION_FAILED");
    console.log("[lab] DEV app authenticated for "+SHOP+"; database is isolated");
    if(process.argv.includes("--check-only")){
      console.log("[lab] CHECK ONLY: no order created; no database row changed");
      return;
    }
    const now=new Date();
    const cycle=nextEligible(now);
    // Verify the single synthetic test cycle; never edit an existing cycle.
    const existing=(await pool.query(
      "SELECT status, delivery_date::text AS delivery_day FROM cycles WHERE code=$1",
      [cycle.cycleCode])).rows[0];
    if(!existing){
      await pool.query(
        `INSERT INTO cycles(code,cycle_date,opens_at,locks_at,delivery_date,status)
         VALUES($1,$2,clock_timestamp()-interval '30 minutes',$3,$2,'open')
         ON CONFLICT (code) DO NOTHING`,[
          cycle.cycleCode,cycle.deliveryDate,cycle.cutoff.toISOString()
        ]);
    }else if(existing.status!=="open"||existing.delivery_day!==cycle.deliveryDate)
      throw Error("LAB_CYCLE_NOT_OPEN");

    const proposed=buildQuote({cycle,now,secret:process.env.ASB_QUOTE_SECRET});
    const prior=(await pool.query(
      "SELECT signed_quote FROM checkout_quotes WHERE quote_id=$1",[proposed.quoteId])).rows[0];
    const quote=prior?.signed_quote||proposed;
    if(!prior){
      await pool.query(
        `INSERT INTO checkout_quotes
        (quote_id,version,shop_domain,household_key,cycle_code,delivery_date,issued_at,expires_at,signed_quote)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)
        ON CONFLICT (quote_id) DO NOTHING`,[
          quote.quoteId,quote.version,SHOP,HOUSEHOLD,quote.cycleCode,quote.deliveryDate,
          quote.issuedAt,quote.expiresAt,JSON.stringify(quote)
        ]);
    }
    const ledger=createPgRedemptionLedger({pool,shopDomain:SHOP,devDomainAllowlist:[SHOP],
      verifyPolicyInTransaction:verifyLabFixturePolicyInTransaction});
    const identity={serverAuthenticated:true,phoneVerified:true,
      householdKey:HOUSEHOLD,phone:"923000000000"};
    const customer={householdKey:HOUSEHOLD,phone:identity.phone,
      addressVerified:true,firstName:"ASB",lastName:"LAB ONLY",
      shippingAddress:{address1:"ASB SYNTHETIC QA — DO NOT DELIVER",
        city:"Karachi",countryCode:"PK"}};
    const quoteStore={
      loadCurrentQuote:async()=>quote,
      loadCustomer:async()=>customer
    };
    // Explicit wrapper adds Shopify's test flag, protects fixture mapping,
    // suppresses all receipts and never changes real inventory.
    const labShopify={
      createOrder:async({query,variables})=>{
        if(!variables?.order||!Array.isArray(variables.order.lineItems)||
           variables.order.lineItems.length!==3)throw Error("LAB_PAYLOAD_NOT_THREE_LINES");
        variables.order.test=true;
        variables.order.note="ASB CHECKOUT LAB — SYNTHETIC COD TEST ONLY. NEVER FULFILL OR DELIVER.";
        variables.order.tags.push("ASB-LAB-ONLY","NEVER-FULFILL");
        const result=await shopify.createOrder({query,variables});
        // This is an isolated synthetic dev order; show ONLY short Shopify
        // validation messages/field paths. No request body, credentials or
        // tokens are logged. A failed create still goes to durable reconciliation.
        if(result?.errors?.length||result?.data?.orderCreate?.userErrors?.length||
           !result?.data?.orderCreate?.order?.id){
          const e=(result?.errors||[]).slice(0,3).map(x=>({
            code:String(x?.extensions?.code||"GRAPHQL_ERROR").slice(0,70),
            hint:String(x?.message||"").slice(0,170)
          }));
          const u=(result?.data?.orderCreate?.userErrors||[]).slice(0,5).map(x=>({
            field:Array.isArray(x.field)?x.field.slice(0,8):[],
            hint:String(x.message||"").slice(0,180)
          }));
          console.log("[lab] SHOPIFY_ORDERCREATE_DIAGNOSTIC "+JSON.stringify({
            graphQLErrors:e,validationErrors:u,orderReturned:!!result?.data?.orderCreate?.order?.id
          }));
        }
        return result;
      }
    };
    const result=await confirmCodOrder({
      request:{quoteId:quote.quoteId,version:quote.version,signature:quote.serverSignature},
      identity,quoteStore,ledger,shopify:labShopify,
      quoteSecret:process.env.ASB_QUOTE_SECRET,
      now:()=>new Date(),taxesDisabledApproved:true
    });
    console.log("[lab] "+JSON.stringify(result));
    if(!["created","already_created"].includes(result.status))
      process.exitCode=6;
  }finally{await pool.end();}
}
if(require.main===module)main().catch(err=>{
  console.error("[lab] FAILED "+String(err.code||err.message||"LAB_ERROR").slice(0,160));
  process.exitCode=5;
});
module.exports={nextEligible,buildQuote,preflight};
