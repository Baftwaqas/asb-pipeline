#!/usr/bin/env node
// One exact ASB Checkout Lab Apna-only 500g Onion COD *test* order.
// Never public HTTP, never production, never delivered, never paid.
"use strict";
const {Pool}=require("pg");
const {targetOf,assertMutationTarget}=require("./lib/db-target-guard");
const {signQuote}=require("../checkout/quote-crypto-v1");
const {createPgRedemptionLedger}=require("../checkout/redemption-ledger-pg-v1");
const {createDevCredentialsShopifyClient}=require("../checkout/dev-shopify-credentials-v1");
const {confirmCodOrder}=require("../checkout/redemption-v1");
const {verifyLabApnaOnionOnlyInTransaction,SHOP,CANONICAL}=
  require("../checkout/lab-apna-onion-only-policy-v1");
const fixture=require("../checkout/fixtures/asb-checkout-lab.json");
const DB="asb_checkout_lab_pg18",DB_HOST="dpg-dbm8v3qjnfac738pc31g-a";
const FLAG="CREATE_APNA_500G_ONCE";
const QUIET_PHONE="923000000000";
function requireIt(ok,code){if(!ok)throw Error(code);}
function nextMondayCycle(now){
  const karachi=new Date(now.getTime()+5*3600000);
  const start=new Date(Date.UTC(karachi.getUTCFullYear(),
    karachi.getUTCMonth(),karachi.getUTCDate()));
  for(let i=0;i<9;i++){
    const d=new Date(start.getTime()+i*86400000);
    if(d.getUTCDay()!==1)continue;
    const cutoff=new Date(d.getTime()-8*3600000); // Sunday 21:00 PKT
    if(now<cutoff){
      const date=d.toISOString().slice(0,10);
      return {deliveryDate:date,cycleCode:"MON-"+date,cutoff};
    }
  }
  throw Error("LAB_APNA_NO_ELIGIBLE_MONDAY");
}
function preflight(){
  requireIt(process.env.ASB_LAB_SHOP_DOMAIN===SHOP&&
    process.env.ASB_ENV==="development"&&
    process.env.ASB_LAB_WRITE_MODE==="disabled",
    "LAB_APNA_SHOP_OR_WRITE_MODE_UNSAFE");
  const t=targetOf(process.env.DATABASE_URL);
  requireIt(t.database===DB&&
    [DB_HOST,DB_HOST+".internal",DB_HOST+".singapore-postgres.render.com"].includes(t.host)&&
    process.env.ASB_MUTATION_DB_NAME===DB,"LAB_APNA_DATABASE_NOT_ISOLATED");
  assertMutationTarget({databaseUrl:process.env.DATABASE_URL,
    expectedHost:t.host,expectedDatabase:DB,operation:"ASB LAB APNA ONE TEST ORDER"});
  requireIt(typeof process.env.ASB_LAB_APP_CLIENT_ID==="string"&&
    process.env.ASB_LAB_APP_CLIENT_ID.length>=5&&
    typeof process.env.ASB_LAB_APP_CLIENT_SECRET==="string"&&
    process.env.ASB_LAB_APP_CLIENT_SECRET.length>=10&&
    typeof process.env.ASB_QUOTE_SECRET==="string"&&
    Buffer.byteLength(process.env.ASB_QUOTE_SECRET,"utf8")>=32,
    "LAB_APNA_SERVER_SECRETS_REQUIRED");
  if(process.argv.includes("--check-only"))return t;
  requireIt(process.argv.includes("--create-single-apna-onion-order")&&
    process.env.ASB_LAB_APNA_ONE_SHOT===FLAG,
    "LAB_APNA_EXPLICIT_ONE_SHOT_REQUIRED");
  return t;
}
function buildQuote(cycle,now,secret){
  const variant=fixture.products[0].variants[0];
  const household="ASB-LAB-APNA-AMENDMENT-HH-"+cycle.cycleCode;
  return signQuote({
    quoteId:"ASB-LAB-APNA-ONION-500-"+cycle.cycleCode,
    version:1,
    issuedAt:new Date(now.valueOf()-2000).toISOString(),
    expiresAt:new Date(Math.min(now.valueOf()+600000,cycle.cutoff.valueOf())).toISOString(),
    cycleCode:cycle.cycleCode,deliveryDate:cycle.deliveryDate,
    customerReference:household,currency:"PKR",
    lines:[{
      lineId:"LAB-APNA-ONION-500",door:"apna_order",
      shopifyVariantGid:variant.gid,canonicalProductId:CANONICAL,sku:variant.sku,
      productName:"LAB ONLY Apna Onion",merchandiseKind:"grocery",unit:"g",
      qty:500,sellUnitLabel:"500 g",provenance:{kind:"apna_selection"},
      quotedLinePaisa:4500,ceilingLinePaisa:4500
    }],
    communityEligibilityByDoor:{
      community_order:{qualifyingCeilingPaisa:0,eligible:false},
      dish_to_cart:{qualifyingCeilingPaisa:0,eligible:false},
      budget_to_cart:{qualifyingCeilingPaisa:0,eligible:false}
    },
    quotedTotalPaisa:4500,ceilingTotalPaisa:4500,
    paymentSecurityState:"unsecured_cod"
  },secret);
}
async function main(){
  const target=preflight();
  const shopify=createDevCredentialsShopifyClient({
    shopDomain:SHOP,devDomainAllowlist:[SHOP],
    clientId:process.env.ASB_LAB_APP_CLIENT_ID,
    clientSecret:process.env.ASB_LAB_APP_CLIENT_SECRET
  });
  await shopify.checkShop();
  const catalog=await shopify.readProductsForPolicy({
    productGids:[fixture.products[0].productGid]
  });
  const p=catalog[0],variants=p.variants?.nodes||[];
  const v=variants.find(v=>v.id===fixture.products[0].variants[0].gid);
  requireIt(p.id===fixture.products[0].productGid&&p.status==="DRAFT"&&
    v?.sku===fixture.products[0].variants[0].sku&&
    /^45(?:\.0{1,2})?$/.test(v.price),
    "LAB_APNA_VARIANT_PRICE_OR_DRAFT_MISMATCH");
  const now=new Date(),cycle=nextMondayCycle(now);
  console.log("[lab-apna] SHOP_AND_DRAFT_CATALOG_VERIFIED nextCycle="+cycle.cycleCode);
  if(process.argv.includes("--check-only")){
    console.log("[lab-apna] CHECK_ONLY no order, no database mutation");
    return;
  }
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:4,
    connectionTimeoutMillis:10000,
    ssl:target.host.endsWith(".internal")||target.host===DB_HOST?false:{rejectUnauthorized:false}});
  try{
    const dbVersion=(await pool.query(
      "SELECT current_database() AS db,current_setting('server_version_num')::int AS version,"+
      " to_regclass('public.checkout_quotes') IS NOT NULL AS migrated")).rows[0];
    requireIt(dbVersion.db===DB&&dbVersion.version>=180000&&dbVersion.migrated,
      "LAB_APNA_DATABASE_VERSION_OR_SCHEMA_MISMATCH");
    const existing=(await pool.query(
      "SELECT status,delivery_date::text AS delivery_day FROM cycles WHERE code=$1",
      [cycle.cycleCode])).rows[0];
    if(!existing){
      await pool.query(
        "INSERT INTO cycles(code,cycle_date,opens_at,locks_at,delivery_date,status)"+
        " VALUES($1,$2,clock_timestamp()-interval '30 minutes',$3,$2,'open')"+
        " ON CONFLICT (code) DO NOTHING",
        [cycle.cycleCode,cycle.deliveryDate,cycle.cutoff.toISOString()]);
    }else requireIt(existing.status==="open"&&existing.delivery_day===cycle.deliveryDate,
      "LAB_APNA_CYCLE_LOCKED");
    const proposed=buildQuote(cycle,now,process.env.ASB_QUOTE_SECRET);
    const prior=(await pool.query("SELECT signed_quote FROM checkout_quotes WHERE quote_id=$1",
      [proposed.quoteId])).rows[0];
    const quote=prior?.signed_quote||proposed;
    if(!prior){
      await pool.query(
        "INSERT INTO checkout_quotes"+
        " (quote_id,version,shop_domain,household_key,cycle_code,delivery_date,issued_at,expires_at,signed_quote)"+
        " VALUES($1,1,$2,$3,$4,$5,$6,$7,$8::jsonb) ON CONFLICT(quote_id) DO NOTHING",
        [quote.quoteId,SHOP,quote.customerReference,cycle.cycleCode,cycle.deliveryDate,
          quote.issuedAt,quote.expiresAt,JSON.stringify(quote)]);
    }
    const identity={serverAuthenticated:true,phoneVerified:true,
      householdKey:quote.customerReference,phone:QUIET_PHONE};
    const customer={householdKey:identity.householdKey,phone:QUIET_PHONE,
      addressVerified:true,firstName:"ASB",lastName:"SYNTHETIC LAB",
      shippingAddress:{address1:"ASB TEST ORDER - NEVER DELIVER",
        city:"Karachi",countryCode:"PK"}};
    const ledger=createPgRedemptionLedger({
      pool,shopDomain:SHOP,devDomainAllowlist:[SHOP],
      verifyPolicyInTransaction:verifyLabApnaOnionOnlyInTransaction
    });
    const labShopify={createOrder:async({query,variables})=>{
      requireIt(variables?.order?.lineItems?.length===1&&
        variables.order.lineItems[0].variantId===fixture.products[0].variants[0].gid,
        "LAB_APNA_ORDER_PAYLOAD_UNEXPECTED");
      variables.order.test=true;
      variables.order.note="ASB LAB TEST - APNA 500G ONION. NEVER FULFILL, SEND OR DELIVER.";
      variables.order.tags.push("ASB-LAB-ONLY","NEVER-FULFILL",
        "ASB-APNA-AMENDMENT-TARGET");
      return shopify.createOrder({query,variables});
    }};
    const result=await confirmCodOrder({
      request:{quoteId:quote.quoteId,version:quote.version,
        signature:quote.serverSignature},
      identity,quoteStore:{loadCurrentQuote:async()=>quote,
        loadCustomer:async()=>customer},
      ledger,shopify:labShopify,
      quoteSecret:process.env.ASB_QUOTE_SECRET,
      now:()=>new Date(),taxesDisabledApproved:true
    });
    console.log("[lab-apna] outcome="+result.status+
      " cycle="+cycle.cycleCode+
      (result.shopifyOrderGid?" orderGid="+result.shopifyOrderGid:""));
    if(!["created","already_created"].includes(result.status))process.exitCode=6;
  }finally{await pool.end();}
}
if(require.main===module)main().catch(err=>{
  const code=String(err?.code||err?.message||"LAB_APNA_ERROR");
  console.error("[lab-apna] BLOCKED "+(/^[A-Z0-9_]{3,70}$/.test(code)?code:"UNCLASSIFIED_LAB_APNA_FAILURE"));
  process.exitCode=5;
});
module.exports={nextMondayCycle,buildQuote,preflight};
