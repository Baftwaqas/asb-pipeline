// ASB Checkout Lab Bridge: standalone SAFE-LOCKED HTTP health endpoint.
// No checkout route, no tokens, no real Shopify writes, and no production DB.
"use strict";
const http=require("node:http");
const EXPECTED="asb-checkout-lab.myshopify.com";
const actual=String(process.env.ASB_LAB_SHOP_DOMAIN||"").trim();
if(actual!==EXPECTED){
  console.error("[checkout-lab] REFUSED: dev shop must match ASB Checkout Lab exactly");
  process.exit(2);
}
if(process.env.ASB_LAB_WRITE_MODE && process.env.ASB_LAB_WRITE_MODE!=="disabled"){
  console.error("[checkout-lab] REFUSED: public health service cannot enable order writes");
  process.exit(3);
}
const port=Number(process.env.PORT||10000);
if(!Number.isSafeInteger(port)||port<1||port>65535){
  console.error("[checkout-lab] REFUSED: invalid PORT");
  process.exit(4);
}
const server=http.createServer((req,res)=>{
  const path=new URL(req.url,"http://localhost").pathname;
  res.setHeader("Cache-Control","no-store, max-age=0");
  res.setHeader("X-Content-Type-Options","nosniff");
  if(req.method==="GET"&&(path==="/"||path==="/health")){
    res.writeHead(200,{"Content-Type":"application/json; charset=utf-8"});
    res.end(JSON.stringify({service:"ASB Checkout Lab Bridge",mode:"SAFE_LOCKED",
      shop:EXPECTED,ordersEnabled:false,shippingEnabled:false,notificationsEnabled:false,
      message:"API-only bridge online. Test order creation is not exposed over public HTTP."}));
    return;
  }
  res.writeHead(req.method==="POST"?405:404,{"Content-Type":"application/json"});
  res.end(JSON.stringify({error:"LAB_HTTP_ROUTE_DISABLED"}));
});
server.requestTimeout=10000;
server.headersTimeout=8000;
server.listen(port,"0.0.0.0",()=>console.log("[checkout-lab] safe-locked health server listening"));

const {execFile}=require("node:child_process");
const pathModule=require("node:path");
const {targetOf}=require("../scripts/lib/db-target-guard");
const DB_ID="dpg-dbm8v3qjnfac738pc31g-a";
const DB_NAME="asb_checkout_lab_pg18";
function assertExactLabDatabase(){
  const t=targetOf(process.env.DATABASE_URL);
  const hosts=new Set([DB_ID,DB_ID+".internal",DB_ID+".singapore-postgres.render.com"]);
  if(t.database!==DB_NAME||!hosts.has(t.host)||
     process.env.ASB_MUTATION_DB_NAME!==DB_NAME)
    throw new Error("REFUSED_NOT_ISOLATED_ASB_CHECKOUT_LAB_DATABASE");
}
// The public health server NEVER offers an HTTP order endpoint. The Render
// operator can arm an exact one-shot startup operation on this dedicated
// DEV service. The postgres ledger prevents duplicate orders on restarts.
function launch(argv,extraEnv,onFinish){
  execFile(process.execPath,argv,{env:{...process.env,...extraEnv},
    timeout:150000,maxBuffer:128*1024},(err,stdout,stderr)=>{
    if(stdout)console.log("[checkout-lab] operator task:",String(stdout).slice(0,2500));
    if(stderr)console.error("[checkout-lab] operator task diagnostic:",String(stderr).slice(0,700));
    if(err)console.error("[checkout-lab] operator task blocked/failed",{code:err.code||null});
    onFinish?.(err||null);
  });
}
function runOrder(){
  try{assertExactLabDatabase();}
  catch(e){console.error("[checkout-lab] order blocked: unsafe DB target");return;}
  const runner=pathModule.join(__dirname,"../scripts/lab-one-order-v1.js");
  launch([runner,"--create-single-order"],{
    ASB_LAB_CLI_APPROVAL:"ASB_LAB_ONLY_ONE_TEST_ORDER"
  },(err)=>{if(!err)console.log("[checkout-lab] test order stage completed safely");});
}
if(process.env.ASB_LAB_CATALOG_AUDIT==="RUN_READ_ONLY_CATALOG"){
  const audit=pathModule.join(__dirname,"../scripts/lab-apna-catalog-readonly-v1.js");
  launch([audit],{},()=>{});
}
if(process.env.ASB_LAB_AUDIT_READONLY==="RUN_AUDIT"){
  const audit=pathModule.join(__dirname,"../scripts/lab-reconcile-readonly-v1.js");
  launch([audit],{},()=>{});
}
if(process.env.ASB_LAB_READONLY_PROBE==="RUN_READ_ONLY_CHECK"){
  const probe=pathModule.join(__dirname,"../scripts/lab-readiness-v1.js");
  launch([probe],{},()=>{});
}
if(process.env.ASB_LAB_MIGRATE_ONCE==="RUN_LAB_MIGRATIONS"){
  try{assertExactLabDatabase();}
  catch(e){console.error("[checkout-lab] migration blocked: unsafe DB target");}
  if(process.env.DATABASE_URL){
    try{
      assertExactLabDatabase();
      const migration=pathModule.join(__dirname,"../scripts/migrate.js");
      // Guard has already identified the single Render database by immutable id.
      // Supply exact host only to the existing migration runner's separate guard.
      launch([migration],{ASB_MUTATION_DB_HOST:targetOf(process.env.DATABASE_URL).host},(err)=>{
        if(!err&&process.env.ASB_LAB_ONE_SHOT_RUN==="RUN_NOW_ONCE")runOrder();
      });
    }catch{ /* already blocked; refuse silently */ }
  }
}else if(process.env.ASB_LAB_ONE_SHOT_RUN==="RUN_NOW_ONCE"){
  // For a DB that was explicitly migrated in a previous safe deployment.
  runOrder();
}
