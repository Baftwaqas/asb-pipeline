#!/usr/bin/env node
// Operator-only, narrowly scoped ASB Checkout LAB recovery-backed amendment.
// Three separately armed phases: reviewed schema, synthetic authorization,
// and the single Shopify order #1002 commit. No public HTTP order route.
// In production/store mismatches REFUSE before connecting or writing.
// IMPORTANT: schemas 029/030 remain in HOLD for every normal migration run.
// This script is NEVER invoked unless Render operator explicitly arms one phase.
"use strict";
const fs=require("node:fs");
const path=require("node:path");
const crypto=require("node:crypto");
const {Pool}=require("pg");
const {targetOf,assertMutationTarget}=require("./lib/db-target-guard");
const {createDevCredentialsShopifyClient}=
  require("../checkout/dev-shopify-credentials-v1");
const {createPgLabSignedAmendmentJournal,SHOP,ORDER,QUOTE,CYCLE}=
  require("../checkout/lab-apna-signed-amendment-pg-v1");
const {makeLabCommitCoordinator}=
  require("../checkout/lab-apna-real-commit-pg-v1");

const DB="asb_checkout_lab_pg18";
const HOST="dpg-dbm8v3qjnfac738pc31g-a";
const BACKUP_SHA="0290E1AF988578FF3E74ADFC899770CE49E393ABB02F234126B8E7FF2F5C52C2";
const MODES=Object.freeze([
  "INSTALL_REVIEWED_LAB_029_030",
  "AUTHORIZE_ONE_SYNTHETIC_AMENDMENT",
  "COMMIT_ORDER_1002_ONCE",
  "RECOVER_ORDER_1002_READONLY"
]);
const HELD=Object.freeze([
  "026_apna_amendment_reservations.sql",
  "027_apna_amendment_bill_simulations.sql",
  "028_apna_edit_commit_intents.sql",
  "029_lab_signed_apna_amendments.sql",
  "030_lab_apna_commit_and_bill_history.sql"
]);
const TWO=HELD.slice(3);
function need(v,code){if(!v)throw Error(code);}
function sha(s){return crypto.createHash("sha256").update(s,"utf8").digest("hex");}
function files(){
  const dir=path.join(__dirname,"..","db","migrations");
  const hold=fs.readFileSync(path.join(dir,"HOLD"),"utf8")
    .split(/\r?\n/).map(x=>x.trim()).filter(x=>x&&!x.startsWith("#"));
  need(HELD.every(x=>hold.includes(x)),"REVIEWED_LAB_MIGRATION_HOLD_CHANGED");
  return TWO.map(name=>{
    const sql=fs.readFileSync(path.join(dir,name),"utf8");
    need(/(?:^|\n)BEGIN;\s*\n/.test(sql)&&/\nCOMMIT;\s*$/.test(sql),
      "REVIEWED_LAB_MIGRATION_BOUNDARY_INVALID");
    need(sql.includes("CREATE TABLE checkout_lab_")&&
      !/\b(DROP|TRUNCATE|GRANT|COPY|\\connect)\b/i.test(sql),
      "REVIEWED_LAB_MIGRATION_UNSAFE_DDL");
    return {name,sql:sql.replace(/(?:^|\n)BEGIN;\s*\n/,"\n").replace(/\nCOMMIT;\s*$/,"\n"),digest:sha(sql)};
  });
}
function preflight(env=process.env){
  const mode=env.ASB_LAB_REVIEWED_OP;
  need(MODES.includes(mode)&&env.ASB_ENV==="development"&&
    env.ASB_LAB_SHOP_DOMAIN===SHOP&&
    env.ASB_LAB_WRITE_MODE==="disabled"&&
    env.ASB_LAB_REAL_COMMIT==="disabled"&&
    env.ASB_LAB_APNA_ONE_SHOT==="disabled"&&
    env.ASB_LAB_APNA_EDIT_PREVIEW==="disabled"&&
    env.ASB_LAB_MIGRATE_ONCE==="disabled"&&
    env.ASB_LAB_ONE_SHOT_RUN==="disabled"&&
    env.ASB_LAB_AMENDMENT_READONLY==="disabled"&&
    env.ASB_LAB_DB_AUDIT==="disabled",
    "REVIEWED_LAB_OPERATOR_MODE_NOT_SAFE");
  const target=targetOf(env.DATABASE_URL);
  need(target.database===DB&&
    [HOST,HOST+".internal",HOST+".singapore-postgres.render.com"].includes(target.host)&&
    env.ASB_MUTATION_DB_NAME===DB,
    "REVIEWED_LAB_OPERATOR_WRONG_DB");
  assertMutationTarget({databaseUrl:env.DATABASE_URL,
    expectedHost:target.host,expectedDatabase:DB,operation:"REVIEWED_ASB_LAB"});
  need(env.ASB_LAB_BACKUP_RESTORE_WITNESS===BACKUP_SHA,
    "REVIEWED_LAB_RESTORED_BACKUP_WITNESS_REQUIRED");
  need(env.ASB_LAB_OFFSITE_COPY_VERIFIED==="YES_ENCRYPTED_CLOUD_COPY_VISIBLE",
    "REVIEWED_LAB_OFFSITE_BACKUP_NOT_VERIFIED");
  return {mode,target};
}
function poolFor(target){
  return new Pool({connectionString:process.env.DATABASE_URL,max:1,
    connectionTimeoutMillis:10000,statement_timeout:30000,
    ssl:target.host.endsWith(".internal")||target.host===HOST?
      false:{rejectUnauthorized:false}});
}
function shopify(){
  return createDevCredentialsShopifyClient({
    shopDomain:SHOP,devDomainAllowlist:[SHOP],
    clientId:process.env.ASB_LAB_APP_CLIENT_ID,
    clientSecret:process.env.ASB_LAB_APP_CLIENT_SECRET
  });
}
async function readGate(db,{requireUninstalled=false,allowClosedForRecovery=false}={}){
  const x=(await db.query(
    "SELECT current_database() AS db,current_setting('server_version_num') AS ver"
  )).rows[0];
  need(x.db===DB&&Number(x.ver)>=180000&&Number(x.ver)<190000,
    "REVIEWED_LAB_DB_IDENTITY_CHANGED");
  const cycle=(await db.query(
    "SELECT status::text,delivery_date::text AS day,opens_at,locks_at,"+
    "clock_timestamp() AS now FROM cycles WHERE code=$1",[CYCLE]
  )).rows[0];
  need(cycle&&cycle.day==="2026-11-16"&&
    (allowClosedForRecovery ||
      (cycle.status==="open"&&cycle.now>=cycle.opens_at&&cycle.now<cycle.locks_at)),
    "REVIEWED_LAB_CUTOFF_CLOSED");
  const orig=(await db.query(
    "SELECT r.shop_domain,r.shopify_order_gid,r.expected_cod_paisa,r.state,"+
    "r.cycle_code,q.state AS quote_state,q.version AS quote_version"+
    " FROM checkout_redemptions r JOIN checkout_quotes q ON r.quote_id=q.quote_id"+
    " WHERE q.quote_id=$1",[QUOTE]
  )).rows[0];
  need(orig?.shop_domain===SHOP&&orig.shopify_order_gid===ORDER&&
    orig.cycle_code===CYCLE&&orig.state==="completed"&&
    Number(orig.expected_cod_paisa)===4500&&
    orig.quote_state==="active"&&orig.quote_version===1,
    "REVIEWED_LAB_SOURCE_CHANGED");
  const all=(await db.query("SELECT filename,sha256 FROM schema_migrations")).rows;
  const applied=new Map(all.map(x=>[x.filename,x.sha256]));
  const original=files();
  const sha023=sha(fs.readFileSync(path.join(__dirname,"..",
    "db","migrations","023_checkout_quote_redemptions.sql"),"utf8"));
  need(applied.get("023_checkout_quote_redemptions.sql")===sha023,
    "REVIEWED_LAB_PRE_REDEMPTION_MIGRATION_DRIFT");
  need(HELD.slice(0,3).every(x=>!applied.has(x)),
    "REVIEWED_LAB_SIMULATION_MIGRATIONS_MUST_NOT_APPLY");
  const installed=original.filter(x=>applied.has(x.name));
  need(installed.length===0||installed.length===2,
    "REVIEWED_LAB_PARTIAL_MIGRATION_STATE");
  need(installed.every(x=>applied.get(x.name)===x.digest),
    "REVIEWED_LAB_MIGRATION_SHA_DRIFT");
  const names=[
    "checkout_lab_apna_signed_amendments","checkout_lab_apna_real_commit_attempts",
    "checkout_lab_apna_commit_audit","checkout_lab_apna_bill_history"
  ];
  const tablePresence=(await db.query(
    "SELECT count(*)::int AS n FROM information_schema.tables"+
    " WHERE table_schema='public' AND table_name=ANY($1::text[])",[names]
  )).rows[0].n;
  need(tablePresence===(installed.length===2?4:0),
    "REVIEWED_LAB_PARTIAL_SCHEMA_PRESENT");
  if(requireUninstalled)need(installed.length===0,"REVIEWED_LAB_ALREADY_INSTALLED");
  return {installed:installed.length,files:original};
}
async function installSchema(pool){
  const client=await pool.connect();let tx=false;
  try{
    await client.query("BEGIN");tx=true;
    // One transaction, one advisory lock, no generic migration runner.
    await client.query("SELECT pg_advisory_xact_lock(20261115,1002)");
    const gate=await readGate(client);
    if(gate.installed===2){
      await client.query("COMMIT");tx=false;
      return {state:"SCHEMA_ALREADY_RECORDED"};
    }
    for(const m of gate.files){
      await client.query(m.sql);
      await client.query(
        "INSERT INTO schema_migrations(filename,sha256,ms) VALUES($1,$2,0)",
        [m.name,m.digest]);
    }
    const schema=(await client.query(
      "SELECT COUNT(*)::int AS n FROM information_schema.tables"+
      " WHERE table_schema='public' AND table_name LIKE 'checkout_lab_apna_%'"
    )).rows[0];
    need(schema.n===4,"REVIEWED_LAB_POST_INSTALL_TABLES_NOT_EXACT");
    await client.query("COMMIT");tx=false;
    return {state:"SCHEMA_029_030_INSTALLED_ATOMICALLY"};
  }catch(e){if(tx)try{await client.query("ROLLBACK");}catch{}throw e;
  }finally{client.release();}
}
async function main(){
  const {mode,target}=preflight();
  const pool=poolFor(target);
  try{
    if(mode==="INSTALL_REVIEWED_LAB_029_030"){
      const out=await installSchema(pool);
      console.log("[asb-reviewed-operator] "+out.state+
        " ONLY_LAB=true SHOPIFY_WRITES=0");
      return;
    }
    // Any later phase requires a complete, SHA-recorded installed schema
    // and an open, unexpired source checkout cycle.
    const client=await pool.connect();
    try{
      await client.query("BEGIN READ ONLY");
      const gate=await readGate(client,{
        allowClosedForRecovery:mode==="RECOVER_ORDER_1002_READONLY"
      });
      need(gate.installed===2,"REVIEWED_LAB_SCHEMA_NOT_INSTALLED");
      await client.query("COMMIT");
    }catch(e){try{await client.query("ROLLBACK");}catch{}throw e;
    }finally{client.release();}
    const api=shopify();
    if(mode==="AUTHORIZE_ONE_SYNTHETIC_AMENDMENT"){
      const grant=await createPgLabSignedAmendmentJournal({
        pool,shopDomain:SHOP,devDomainAllowlist:[SHOP],shopifyClient:api,
        quoteSecret:process.env.ASB_QUOTE_SECRET
      }).authorizeReadVerifiedSynthetic();
      need(grant.proposedTotalPaisa===13500,
        "REVIEWED_LAB_AUTH_AMOUNT_CHANGED");
      console.log("[asb-reviewed-operator] SYNTHETIC_AUTH_VERIFIED "+
        "IDEMPOTENT="+grant.idempotent+" SHOPIFY_WRITES=0 BILL_SENDS=0");
      return;
    }
    const rows=(await pool.query(
      "SELECT authorization_id::text AS id FROM checkout_lab_apna_signed_amendments"+
      " WHERE shopify_order_gid=$1",[ORDER])).rows;
    need(rows.length===1,"REVIEWED_LAB_AUTHORIZATION_NOT_UNIQUE");
    const coordinator=makeLabCommitCoordinator({
      pool,shopDomain:SHOP,devDomainAllowlist:[SHOP],shopifyClient:api,
      quoteSecret:process.env.ASB_QUOTE_SECRET
    });
    if(mode==="RECOVER_ORDER_1002_READONLY"){
      const out=await coordinator.recoverByReadOnly({authorizationId:rows[0].id});
      console.log("[asb-reviewed-operator] READONLY_RECOVERY="+out.state+
        " BILL_SENT=false COMMIT_REQUESTS=0");
      return;
    }
    need(mode==="COMMIT_ORDER_1002_ONCE","REVIEWED_LAB_INVALID_PHASE");
    // Flags armed inside the private one-shot child process ONLY.
    // Parent HTTP bridge MUST remain WRITE_MODE=disabled at all times.
    process.env.ASB_LAB_WRITE_MODE="lab-commit-single-attempt";
    process.env.ASB_LAB_REAL_COMMIT="REVIEWED_ONE_SHOT_ONLY";
    const out=await coordinator.executeOnce({
      authorizationId:rows[0].id,
      operatorGate:"REVIEWED_LAB_ONE_SHOT_COMMIT"
    });
    need(["verified","needs_reconcile","intent_recorded"].includes(out.state),
      "REVIEWED_LAB_COMMIT_INDETERMINATE");
    console.log("[asb-reviewed-operator] COMMIT_RESULT="+out.state+
      " DISPATCHED="+(out.commitDispatched===true)+
      " RECOVERY_ONLY="+(out.recoveryOnly===true)+
      " COMMIT_MAY_RETRY=NO BILL_SENT=false");
  }finally{await pool.end();}
}
if(require.main===module)main().catch(err=>{
  // Deliberately no raw error text: tokens, query, household, quote or PII.
  const raw=String(err?.code||err?.message||"REVIEWED_LAB_UNKNOWN");
  console.error("[asb-reviewed-operator] BLOCKED_REASON="+
    (/^[A-Z0-9_]{3,95}$/.test(raw)?raw:"REVIEWED_LAB_OPERATOR_FAILURE"));
  process.exitCode=2;
});
module.exports={preflight,files,readGate,installSchema,MODES};
