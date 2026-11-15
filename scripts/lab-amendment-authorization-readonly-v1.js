#!/usr/bin/env node
// ASB Checkout Lab: verify a signed synthetic amendment against actual stored
// original HMAC quote + actual Shopify order/catalog WITHOUT any DB/Shopify writes.
// NEVER output the signing secret, raw quote, customer identity or tokens.
"use strict";
const {Pool}=require("pg");
const {targetOf}=require("./lib/db-target-guard");
const {createDevCredentialsShopifyClient}=
  require("../checkout/dev-shopify-credentials-v1");
const {verifySignedQuote}=require("../checkout/quote-crypto-v1");
const {verifyAmendmentPreflight}=require("../checkout/apna-order-amendment-preflight-v1");
const {makeSignedSyntheticPacket,verifyCatalog,SHOP,ORDER,QUOTE,CYCLE}=
  require("../checkout/lab-apna-signed-amendment-pg-v1");
const fixture=require("../checkout/fixtures/asb-checkout-lab.json");
const DB="asb_checkout_lab_pg18",HOST="dpg-dbm8v3qjnfac738pc31g-a";
function check(ok,code){if(!ok)throw Error(code);}
async function main(){
  check(process.env.ASB_LAB_AMENDMENT_READONLY==="VERIFY_SIGNED_LAB_PROPOSAL"&&
    process.env.ASB_LAB_SHOP_DOMAIN===SHOP&&
    process.env.ASB_ENV==="development"&&
    process.env.ASB_LAB_WRITE_MODE==="disabled"&&
    process.env.ASB_LAB_APNA_ONE_SHOT==="disabled"&&
    process.env.ASB_LAB_APNA_EDIT_PREVIEW==="disabled"&&
    process.env.ASB_LAB_MIGRATE_ONCE==="disabled",
    "LAB_SIGNED_AMENDMENT_READONLY_NOT_ARMED");
  const target=targetOf(process.env.DATABASE_URL);
  check(target.database===DB&&
    [HOST,HOST+".internal",HOST+".singapore-postgres.render.com"].includes(target.host)&&
    process.env.ASB_MUTATION_DB_NAME===DB,
    "LAB_SIGNED_AMENDMENT_WRONG_DATABASE");
  const cli=createDevCredentialsShopifyClient({
    shopDomain:SHOP,devDomainAllowlist:[SHOP],
    clientId:process.env.ASB_LAB_APP_CLIENT_ID,
    clientSecret:process.env.ASB_LAB_APP_CLIENT_SECRET
  });
  const scopes=await cli.readGrantedScopesForLab();
  check(scopes.ready===true&&scopes.shopDomain===SHOP,
    "LAB_SIGNED_AMENDMENT_SCOPES_NOT_GRANTED");
  const [order,products]=await Promise.all([
    cli.readLabOrderForAmendment({orderGid:ORDER}),
    cli.readProductsForPolicy({productGids:[fixture.products[0].productGid]})
  ]);
  verifyCatalog(products);
  const db=new Pool({connectionString:process.env.DATABASE_URL,max:1,
    connectionTimeoutMillis:10000,
    ssl:target.host.endsWith(".internal")||target.host===HOST?false:{rejectUnauthorized:false}});
  try{
    await db.query("BEGIN READ ONLY");
    const result=(await db.query(
      "SELECT r.claim_id,r.shop_domain,r.household_key,r.cycle_code,"+
      " r.shopify_order_gid,r.expected_cod_paisa,r.state AS claim_state,"+
      " q.signed_quote,q.version,q.state AS quote_state,"+
      " q.delivery_date::text AS delivery_date"+
      " FROM checkout_redemptions r JOIN checkout_quotes q ON q.quote_id=r.quote_id"+
      " WHERE r.quote_id=$1",[QUOTE])).rows[0];
    check(result&&result.shop_domain===SHOP&&result.cycle_code===CYCLE&&
      result.shopify_order_gid===ORDER&&result.claim_state==="completed"&&
      Number(result.expected_cod_paisa)===4500&&
      result.version===1&&result.quote_state==="active"&&
      result.delivery_date==="2026-11-16",
      "LAB_SIGNED_AMENDMENT_ORIGINAL_CLAIM_INVALID");
    check(verifySignedQuote(result.signed_quote,process.env.ASB_QUOTE_SECRET),
      "LAB_SIGNED_AMENDMENT_ORIGINAL_HMAC_INVALID");
    check(result.signed_quote.customerReference===result.household_key,
      "LAB_SIGNED_AMENDMENT_CUSTOMER_KEY_MISMATCH");
    const c=(await db.query(
      "SELECT code,status::text,delivery_date::text AS delivery_date,"+
      " opens_at,locks_at,clock_timestamp() AS db_now"+
      " FROM cycles WHERE code=$1",[CYCLE])).rows[0];
    check(c&&c.status==="open"&&c.delivery_date==="2026-11-16"&&
      c.db_now>=c.opens_at&&c.db_now<c.locks_at,
      "LAB_SIGNED_AMENDMENT_CYCLE_CLOSED");

    const packet=makeSignedSyntheticPacket({
      originalQuote:result.signed_quote,order,
      secret:process.env.ASB_QUOTE_SECRET
    });
    const decision=verifyAmendmentPreflight({
      shopDomain:SHOP,
      identity:{serverAuthenticated:true,phoneVerified:true,
        householdKey:result.household_key},
      cycle:{code:CYCLE,status:"open",cutoffVerifiedByDatabase:true},
      originalOrder:{shopDomain:SHOP,householdKey:result.household_key,
        cycleCode:CYCLE,orderId:QUOTE,shopifyOrderGid:ORDER,
        redemptionState:"completed",fulfillmentState:"confirmed",
        paymentState:"pending_cod"},
      originalLines:packet.originalLines,proposedLines:packet.proposedLines,
      existingCycleLines:[],limitsByProduct:{
        "ASB-CANON-ONION":{unit:"g",minQuantity:500,maxQuantity:2000,
          allowedSizes:[500,1000]}
      },
      sourceVerified:true,historyVerified:true,policyVerified:true
    });
    check(decision.proposedTotalPaisa===13500&&
      decision.additionalPaisa===9000&&
      decision.quantityResults.products[0].totalQuantity===1500,
      "LAB_SIGNED_AMENDMENT_RESULT_MISMATCH");
    // The test household was created only for this order. The primary
    // household-cycle reservation must be exactly the original claim.
    const claims=(await db.query(
      "SELECT count(*)::int AS n FROM checkout_redemptions"+
      " WHERE shop_domain=$1 AND household_key=$2 AND cycle_code=$3",
      [SHOP,result.household_key,CYCLE])).rows[0].n;
    check(claims===1,"LAB_SIGNED_AMENDMENT_CONFLICTING_CLAIMS");
    await db.query("COMMIT");
    console.log("[lab-amendment] ORIGINAL_HMAC_OK STORE_AND_SCOPES_OK");
    console.log("[lab-amendment] SOURCE_ORDER="+ORDER+" CYCLE="+CYCLE+
      " ORIGINAL_PKR=45.00 ADD_PKR=90.00 PROPOSED_PKR=135.00 QUANTITY_GRAMS=1500");
    console.log("[lab-amendment] SYNTHETIC_OPERATOR_AUTH_ONLY=true "+
      "REAL_CUSTOMER_CONSENT=false READ_ONLY=true SHOPIFY_COMMITS=0 BILL_SENDS=0");
  }catch(e){try{await db.query("ROLLBACK");}catch{}throw e;
  }finally{await db.end();}
}
if(require.main===module)main().catch(e=>{
  const s=String(e?.code||e?.message||"LAB_AMENDMENT_FAILED");
  console.error("[lab-amendment] BLOCKED reason="+
    (/^[A-Z0-9_]{3,90}$/.test(s)?s:"UNCLASSIFIED_LAB_AMENDMENT_FAILURE"));
  process.exitCode=2;
});
module.exports={main};
