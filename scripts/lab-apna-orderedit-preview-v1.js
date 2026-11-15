#!/usr/bin/env node
// ASB LAB ONLY: stage a Shopify order edit and READ its calculated price.
// No orderEditCommit, bill send, migration, checkout activation, or delivery.
"use strict";
const {Pool}=require("pg");
const {targetOf}=require("./lib/db-target-guard");
const {createDevCredentialsShopifyClient}=
  require("../checkout/dev-shopify-credentials-v1");
const SHOP="asb-checkout-lab.myshopify.com";
const DB="asb_checkout_lab_pg18";
const HOST="dpg-dbm8v3qjnfac738pc31g-a";
const TARGET="gid://shopify/Order/19011998580770";
function need(x,code){if(!x)throw Error(code);}
async function main(){
  need(process.env.ASB_LAB_APNA_EDIT_PREVIEW==="STAGE_WITHOUT_COMMIT"&&
    process.env.ASB_LAB_SHOP_DOMAIN===SHOP&&
    process.env.ASB_ENV==="development"&&
    process.env.ASB_LAB_WRITE_MODE==="disabled"&&
    process.env.ASB_LAB_APNA_ONE_SHOT==="disabled"&&
    process.env.ASB_LAB_MIGRATE_ONCE==="disabled",
    "LAB_APNA_PREVIEW_UNAUTHORIZED_CONFIGURATION");
  const db=targetOf(process.env.DATABASE_URL);
  need(db.database===DB&&
    [HOST,HOST+".internal",HOST+".singapore-postgres.render.com"].includes(db.host)&&
    process.env.ASB_MUTATION_DB_NAME===DB,
    "LAB_APNA_PREVIEW_DATABASE_NOT_ISOLATED");
  const pool=new Pool({
    connectionString:process.env.DATABASE_URL,max:1,
    ssl:db.host.endsWith(".internal")||db.host===HOST?false:{rejectUnauthorized:false}
  });
  try{
    const cycle=(await pool.query(
      "SELECT code,status::text,delivery_date::text AS date,opens_at,locks_at,"+
      " clock_timestamp() AS now FROM cycles WHERE code=$1",
      ["MON-2026-11-16"]
    )).rows[0];
    need(cycle&&cycle.status==="open"&&cycle.date==="2026-11-16"&&
      cycle.now>=cycle.opens_at&&cycle.now<cycle.locks_at,
      "LAB_APNA_PREVIEW_CYCLE_NOT_OPEN");
  }finally{await pool.end();}
  const cli=createDevCredentialsShopifyClient({
    shopDomain:SHOP,devDomainAllowlist:[SHOP],
    clientId:process.env.ASB_LAB_APP_CLIENT_ID,
    clientSecret:process.env.ASB_LAB_APP_CLIENT_SECRET
  });
  const result=await cli.previewLabApnaOnionUncommitted({
    orderGid:TARGET,operatorApproval:"ASB_LAB_APNA_ONION_STAGE_ONLY",
    previewMode:"STAGE_WITHOUT_COMMIT"
  });
  console.log("[lab-apna-preview] "+result.state+
    " TEST_ORDER="+TARGET+
    " ORIGINAL_PKR=45.00 ADDED_PKR=90.00 CALCULATED_PKR=135.00");
  console.log("[lab-apna-preview] CALCULATED_ORDER="+result.calculatedOrderId+
    " ORDER_COMMIT_CALLS=0 BILL_SENDS=0 NO_ACTIVATION=true");
}
if(require.main===module)main().catch(err=>{
  const code=String(err?.code||err?.message||"LAB_PREVIEW_UNKNOWN");
  console.error("[lab-apna-preview] BLOCKED reason="+
    (/^[A-Z0-9_]{3,70}$/.test(code)?code:"LAB_PREVIEW_UNKNOWN_FAILURE"));
  process.exitCode=2;
});
module.exports={main};
