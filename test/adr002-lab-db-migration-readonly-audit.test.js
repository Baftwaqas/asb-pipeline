"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs");
const crypto=require("node:crypto");
const path=require("node:path");
const {
  envCheck,report,requiredTables,proposedTables,held
}=require("../scripts/lab-db-migration-audit-readonly-v1");
const sha=f=>crypto.createHash("sha256").update(fs.readFileSync(
  path.join(__dirname,"..","db","migrations",f),"utf8")).digest("hex");
function state(overrides={}){
  return {
    tables:[...requiredTables],
    applied:[{filename:"023_checkout_quote_redemptions.sql",
      sha256:sha("023_checkout_quote_redemptions.sql")}],
    version:"180005",dbName:"asb_checkout_lab_pg18",dbSize:33554432,
    original:{
      quote_id:"ASB-LAB-APNA-ONION-500-MON-2026-11-16",
      shop_domain:"asb-checkout-lab.myshopify.com",
      shopify_order_gid:"gid://shopify/Order/19011998580770",
      cycle_code:"MON-2026-11-16",state:"completed",
      expected_cod_paisa:"4500"
    },
    role:{can_create:true},...overrides
  };
}
test("exact lab DB may be SCHEMA READY but NEVER migration authorized without backup",()=>{
  const r=report(state());
  assert.equal(r.postgres18,true);
  assert.equal(r.correctDb,true);
  assert.equal(r.prerequisiteSchemaAndHashOk,true);
  assert.equal(r.proposedTablesAbsent,true);
  assert.equal(r.olderSimulationMigrationsUnapplied,true);
  assert.equal(r.sourceOrderRecordMatches,true);
  assert.equal(r.backupVerified,false);
  assert.equal(r.mayApply029030,false);
});
test("wrong migration checksum, previous application, or missing table blocks readiness",()=>{
  assert.equal(report(state({applied:[{filename:"023_checkout_quote_redemptions.sql",sha256:"0".repeat(64)}]}))
    .prerequisiteSchemaAndHashOk,false);
  assert.equal(report(state({tables:requiredTables.slice(1)}))
    .prerequisiteSchemaAndHashOk,false);
  assert.equal(report(state({tables:[...requiredTables,proposedTables[0]]}))
    .proposedTablesAbsent,false);
  assert.equal(report(state({applied:[{filename:"023_checkout_quote_redemptions.sql",
    sha256:sha("023_checkout_quote_redemptions.sql")},{filename:held[4],sha256:"a".repeat(64)}]}))
    .proposedTablesAbsent,false);
  assert.equal(report(state({applied:[{filename:"023_checkout_quote_redemptions.sql",
    sha256:sha("023_checkout_quote_redemptions.sql")},{filename:held[1],sha256:"a".repeat(64)}]}))
    .olderSimulationMigrationsUnapplied,false);
});
test("unrecognized original order or missing 500g claim fail",()=>{
  assert.equal(report(state({original:{...state().original,state:"needs_reconcile"}}))
    .sourceOrderRecordMatches,false);
  assert.equal(report(state({original:null})).sourceOrderRecordMatches,false);
});
test("operator flags must disable all Shopify writes and use the exact lab target",()=>{
  const env={
    ASB_LAB_DB_AUDIT:"READONLY_SCHEMA_GATE",
    ASB_ENV:"development",
    ASB_LAB_SHOP_DOMAIN:"asb-checkout-lab.myshopify.com",
    ASB_LAB_WRITE_MODE:"disabled",
    ASB_LAB_REAL_COMMIT:"disabled",
    ASB_LAB_APNA_ONE_SHOT:"disabled",
    ASB_LAB_APNA_EDIT_PREVIEW:"disabled",
    ASB_LAB_MIGRATE_ONCE:"disabled",
    ASB_LAB_ONE_SHOT_RUN:"disabled",
    DATABASE_URL:"postgres://test:test@dpg-dbm8v3qjnfac738pc31g-a/asb_checkout_lab_pg18",
    ASB_MUTATION_DB_NAME:"asb_checkout_lab_pg18"
  };
  assert.equal(envCheck(env).database,"asb_checkout_lab_pg18");
  for(const [key,value] of [
    ["ASB_LAB_WRITE_MODE","lab-commit-single-attempt"],
    ["ASB_LAB_SHOP_DOMAIN","apnasastabazaar.myshopify.com"],
    ["ASB_LAB_REAL_COMMIT","REVIEWED_ONE_SHOT_ONLY"],
    ["ASB_LAB_MIGRATE_ONCE","RUN_LAB_MIGRATIONS"],
    ["ASB_LAB_DB_AUDIT","disabled"]
  ])assert.throws(()=>envCheck({...env,[key]:value}),/LAB_DB_AUDIT_NOT_ARMED/);
  assert.throws(()=>envCheck({...env,DATABASE_URL:
    "postgres://test:test@production.pg.example/asb_checkout_lab_pg18"}),
    /LAB_DB_AUDIT_WRONG_TARGET/);
});
test("026–030 all remain in migration HOLD",()=>{
  const holds=fs.readFileSync(path.join(__dirname,"..","db","migrations","HOLD"),"utf8").split(/\r?\n/);
  assert.equal(held.length,5);
  for(const f of held)assert.ok(holds.includes(f),f);
});
