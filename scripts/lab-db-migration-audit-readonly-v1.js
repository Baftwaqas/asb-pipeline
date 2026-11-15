#!/usr/bin/env node
// ASB Checkout Lab: pre-migration inventory ONLY. Must not create, change,
// export, migrate, or dump data. Prints no customer information or credentials.
// Explicitly BLOCKS migration 029/030 when there is no verified recoverable backup.
"use strict";
const fs=require("node:fs");
const path=require("node:path");
const crypto=require("node:crypto");
const {Client}=require("pg");
const {targetOf}=require("./lib/db-target-guard");

const DB="asb_checkout_lab_pg18";
const HOST="dpg-dbm8v3qjnfac738pc31g-a";
const SHOP="asb-checkout-lab.myshopify.com";
const ORDER="gid://shopify/Order/19011998580770";
const QUOTE="ASB-LAB-APNA-ONION-500-MON-2026-11-16";
const requiredTables=[
  "checkout_quotes","checkout_redemptions",
  "checkout_household_cycle_locks","cycles","schema_migrations"
];
const proposedTables=[
  "checkout_lab_apna_signed_amendments",
  "checkout_lab_apna_real_commit_attempts",
  "checkout_lab_apna_commit_audit",
  "checkout_lab_apna_bill_history"
];
const held=[
  "026_apna_amendment_reservations.sql",
  "027_apna_amendment_bill_simulations.sql",
  "028_apna_edit_commit_intents.sql",
  "029_lab_signed_apna_amendments.sql",
  "030_lab_apna_commit_and_bill_history.sql"
];
const migratedPrereqs=["023_checkout_quote_redemptions.sql"];
function safe(ok,code){if(!ok)throw Error(code);}
function envCheck(env=process.env){
  safe(env.ASB_LAB_DB_AUDIT==="READONLY_SCHEMA_GATE"&&
    env.ASB_ENV==="development"&&
    env.ASB_LAB_SHOP_DOMAIN===SHOP&&
    env.ASB_LAB_WRITE_MODE==="disabled"&&
    env.ASB_LAB_REAL_COMMIT==="disabled"&&
    env.ASB_LAB_APNA_ONE_SHOT==="disabled"&&
    env.ASB_LAB_APNA_EDIT_PREVIEW==="disabled"&&
    env.ASB_LAB_MIGRATE_ONCE==="disabled"&&
    env.ASB_LAB_ONE_SHOT_RUN==="disabled",
    "LAB_DB_AUDIT_NOT_ARMED");
  const db=targetOf(env.DATABASE_URL);
  safe(db.database===DB&&
    [HOST,HOST+".internal",HOST+".singapore-postgres.render.com"].includes(db.host)&&
    env.ASB_MUTATION_DB_NAME===DB,"LAB_DB_AUDIT_WRONG_TARGET");
  return db;
}
function shaOf(file){
  return crypto.createHash("sha256").update(
    fs.readFileSync(path.join(__dirname,"..","db","migrations",file),"utf8")
  ).digest("hex");
}
function repositoryHolds(){
  const hold=fs.readFileSync(
    path.join(__dirname,"..","db","migrations","HOLD"),"utf8")
    .split(/\r?\n/).map(x=>x.trim())
    .filter(x=>x&&!x.startsWith("#"));
  safe(held.every(x=>hold.includes(x)), "LAB_DB_AUDIT_HELD_FILE_MISSING");
  return held.length;
}
function report({tables,applied,version,dbName,dbSize,original,role}){
  const present=new Set(tables);
  const migrations=new Map(applied.map(r=>[r.filename,r.sha256]));
  const allPrereqs=requiredTables.every(x=>present.has(x))&&
    migratedPrereqs.every(x=>migrations.get(x)===shaOf(x));
  const proposedAbsent=proposedTables.every(x=>!present.has(x))&&
    ["029_lab_signed_apna_amendments.sql",
     "030_lab_apna_commit_and_bill_history.sql"]
      .every(x=>!migrations.has(x));
  const heldAbsent=["026_apna_amendment_reservations.sql",
    "027_apna_amendment_bill_simulations.sql",
    "028_apna_edit_commit_intents.sql"].every(x=>!migrations.has(x));
  const storeRecord=original?.shop_domain===SHOP&&
    original?.shopify_order_gid===ORDER&&
    original?.quote_id===QUOTE&&
    original?.cycle_code==="MON-2026-11-16"&&
    original?.state==="completed"&&Number(original.expected_cod_paisa)===4500;
  return Object.freeze({
    postgres18:String(version).startsWith("18"),
    correctDb:dbName===DB,
    tablesPresent:requiredTables.filter(x=>present.has(x)).length,
    tablesRequired:requiredTables.length,
    prerequisiteSchemaAndHashOk:allPrereqs,
    proposedTablesAbsent:proposedAbsent,
    olderSimulationMigrationsUnapplied:heldAbsent,
    sourceOrderRecordMatches:storeRecord,
    ddlRights:role?.can_create===true,
    dbSizeBytes:Number(dbSize),
    // Managed backup cannot be assumed on the Free plan.
    backupVerified:false,
    mayApply029030:false
  });
}
async function main(){
  const target=envCheck();
  repositoryHolds();
  const cli=new Client({
    connectionString:process.env.DATABASE_URL,
    ssl:target.host.endsWith(".internal")||target.host===HOST?
      false:{rejectUnauthorized:false},
    connectionTimeoutMillis:10000,
    statement_timeout:15000
  });
  let started=false;
  try{
    await cli.connect();
    await cli.query("BEGIN READ ONLY");started=true;
    const basics=(await cli.query(
      "SELECT current_database() AS db,current_setting('server_version_num') AS ver,"+
      " pg_database_size(current_database()) AS bytes,"+
      " has_schema_privilege(current_user,'public','CREATE') AS can_create"
    )).rows[0];
    const tables=(await cli.query(
      "SELECT table_name FROM information_schema.tables"+
      " WHERE table_schema='public' AND table_type='BASE TABLE'"
    )).rows.map(x=>x.table_name);
    safe(tables.includes("schema_migrations"),
      "LAB_DB_AUDIT_MIGRATION_LEDGER_MISSING");
    // Only filenames/checksums, not migration code or user data.
    const applied=(await cli.query(
      "SELECT filename,sha256 FROM public.schema_migrations"
    )).rows;
    let original=null;
    if(requiredTables.every(x=>tables.includes(x))){
      original=(await cli.query(
        "SELECT q.quote_id,r.shop_domain,r.shopify_order_gid,"+
        " r.cycle_code,r.state,r.expected_cod_paisa"+
        " FROM checkout_redemptions r"+
        " JOIN checkout_quotes q ON q.quote_id=r.quote_id"+
        " WHERE r.shopify_order_gid=$1 AND q.quote_id=$2",
        [ORDER,QUOTE]
      )).rows[0]||null;
    }
    await cli.query("COMMIT");started=false;
    const out=report({
      tables,applied,version:basics.ver,dbName:basics.db,
      dbSize:basics.bytes,original,role:basics
    });
    const yes=v=>v?"PASS":"FAIL";
    console.log("[lab-db-gate] POSTGRES18="+yes(out.postgres18)+
      " EXACT_DATABASE="+yes(out.correctDb));
    console.log("[lab-db-gate] REQUIRED_TABLES="+out.tablesPresent+
      "/"+out.tablesRequired+" SOURCE_CHECKOUT_RECORD="+
      yes(out.sourceOrderRecordMatches));
    console.log("[lab-db-gate] PREREQUISITE_SCHEMA_AND_SHA="+
      yes(out.prerequisiteSchemaAndHashOk)+
      " DDL_PRIVILEGE="+yes(out.ddlRights));
    console.log("[lab-db-gate] MIGRATIONS_029_030_ABSENT="+
      yes(out.proposedTablesAbsent)+
      " SIMULATION_026_028_UNAPPLIED="+
      yes(out.olderSimulationMigrationsUnapplied));
    console.log("[lab-db-gate] DATABASE_SIZE_BYTES="+out.dbSizeBytes);
    console.log("[lab-db-gate] BACKUP_VERIFIED=NO"+
      " MIGRATIONS_029_030_APPLY=BLOCKED"+
      " READ_ONLY=true SQL_WRITES=0");
    if(!out.postgres18||!out.correctDb||
       !out.prerequisiteSchemaAndHashOk||!out.proposedTablesAbsent||
       !out.olderSimulationMigrationsUnapplied||
       !out.sourceOrderRecordMatches)
      process.exitCode=2;
  }catch(e){
    if(started)try{await cli.query("ROLLBACK");}catch{}
    const code=String(e?.code||e?.message||"LAB_DB_GATE_ERROR");
    console.error("[lab-db-gate] BLOCKED_REASON="+
      (/^[A-Z0-9_]{3,90}$/.test(code)?code:"UNCLASSIFIED_SCHEMA_AUDIT_FAILURE"));
    process.exitCode=2;
  }finally{await cli.end().catch(()=>{});}
}
if(require.main===module)main();
module.exports={envCheck,report,requiredTables,proposedTables,held};
