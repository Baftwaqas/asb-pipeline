// ASB CHECKOUT LAB — ONE-TIME READ-ONLY connection readiness check.
// No external secrets printed, no database mutation, no Shopify order creation.
"use strict";
const {Pool}=require("pg");
const {targetOf}=require("./lib/db-target-guard");
const {createDevCredentialsShopifyClient}=require("../checkout/dev-shopify-credentials-v1");
const DB_ID="dpg-dbm8v3qjnfac738pc31g-a";
const DB_NAME="asb_checkout_lab_pg18";
const SHOP="asb-checkout-lab.myshopify.com";
function guardedTarget(){
  if(process.env.ASB_LAB_SHOP_DOMAIN!==SHOP||
     process.env.ASB_ENV!=="development"||
     process.env.ASB_LAB_WRITE_MODE!=="disabled"||
     process.env.ASB_MUTATION_DB_NAME!==DB_NAME)
    throw Error("WRONG_DEV_CONFIGURATION");
  const t=targetOf(process.env.DATABASE_URL);
  if(t.database!==DB_NAME||
    ![DB_ID,DB_ID+".internal",DB_ID+".singapore-postgres.render.com"].includes(t.host))
    throw Error("WRONG_DEV_DATABASE");
  return t;
}
async function main(){
  const host=guardedTarget();
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:1,
    connectionTimeoutMillis:9000,
    ssl:host.host.endsWith(".internal")||host.host===DB_ID?false:{rejectUnauthorized:false}});
  try{
    const res=await pool.query(
      "SELECT current_database() AS db, current_setting('server_version_num')::int AS v, to_regclass('public.checkout_quotes') IS NOT NULL AS migrated");
    const x=res.rows[0];
    if(x.db!==DB_NAME||x.v<180000)throw Error("DEV_DB_IDENTITY_OR_VERSION_MISMATCH");
    console.log("[lab-readiness] DB_OK version=18 migrated="+String(x.migrated));
    const q=await pool.query("SELECT to_regclass('public.checkout_apna_policy_releases') IS NOT NULL AS apna_staging_ready");
    if(q.rows[0].apna_staging_ready){
      const stats=await pool.query(
        "SELECT state,count(*)::int AS count FROM checkout_apna_policy_releases GROUP BY state");
      const byState=Object.fromEntries(stats.rows.map(r=>[r.state,r.count]));
      console.log("[lab-readiness] APNA_POLICY_STAGING_READY releases="+
        String(Object.values(byState).reduce((a,b)=>a+b,0))+
        " active="+String(byState.active||0));
    }else{
      console.log("[lab-readiness] APNA_POLICY_STAGING_NOT_INSTALLED");
    }
  }finally{await pool.end();}
  const cli=createDevCredentialsShopifyClient({
    shopDomain:SHOP,devDomainAllowlist:[SHOP],
    clientId:process.env.ASB_LAB_APP_CLIENT_ID,
    clientSecret:process.env.ASB_LAB_APP_CLIENT_SECRET
  });
  const shop=await cli.checkShop();
  if(shop.shopDomain!==SHOP)throw Error("DEV_SHOP_MISMATCH");
  console.log("[lab-readiness] SHOPIFY_APP_TOKEN_OK scope=write_orders");
  console.log("[lab-readiness] READ_ONLY_READY — no order created");
}
if(require.main===module)main().catch(err=>{
  // NEVER log network error objects; some libraries embed URLs or credentials.
  const allowed=new Set(["WRONG_DEV_CONFIGURATION","WRONG_DEV_DATABASE",
    "DEV_APP_CREDENTIALS_REQUIRED","DEV_STORE_NOT_EXPLICITLY_ALLOWLISTED",
    "DEV_APP_TOKEN_REQUEST_FAILED","DEV_APP_TOKEN_BAD_RESPONSE",
    "DEV_APP_WRITE_ORDERS_NOT_GRANTED","DEV_SHOP_CHECK_HTTP_FAILED",
    "DEV_SHOP_IDENTITY_OR_SETTINGS_MISMATCH","DEV_DB_IDENTITY_OR_VERSION_MISMATCH"]);
  const code=String(err?.code||err?.message||"CONNECTION_FAILURE");
  console.error("[lab-readiness] BLOCKED reason="+(allowed.has(code)?code:
    /^[A-Z0-9_]{3,50}$/.test(code)?code:"UNCLASSIFIED_CONNECTION_FAILURE"));
  process.exitCode=2;
});
module.exports={guardedTarget};
