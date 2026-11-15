"use strict";
const {test}=require("node:test");
const assert=require("node:assert/strict");
const path=require("node:path");
const {Pool}=require("pg");
const H=require("./support/harness");
const {buildQuote}=require("../scripts/lab-apna-onion-order-v1");
const {SHOP,ORDER,QUOTE,CYCLE}=
  require("../checkout/lab-apna-signed-amendment-pg-v1");
const {preflight,files,installSchema,readGate}=
  require("../scripts/lab-apna-reviewed-operator-v1");
const SECRET="SCRATCH_POSTGRES_ONLY_SECRET_0123456789_ABCDEFGHIJKLMN";

function baselineEnv(){
  return {
    ASB_LAB_REVIEWED_OP:"INSTALL_REVIEWED_LAB_029_030",
    ASB_ENV:"development",ASB_LAB_SHOP_DOMAIN:SHOP,
    ASB_LAB_WRITE_MODE:"disabled",ASB_LAB_REAL_COMMIT:"disabled",
    ASB_LAB_APNA_ONE_SHOT:"disabled",ASB_LAB_APNA_EDIT_PREVIEW:"disabled",
    ASB_LAB_MIGRATE_ONCE:"disabled",ASB_LAB_ONE_SHOT_RUN:"disabled",
    ASB_LAB_AMENDMENT_READONLY:"disabled",ASB_LAB_DB_AUDIT:"disabled",
    ASB_MUTATION_DB_NAME:"asb_checkout_lab_pg18",
    ASB_LAB_BACKUP_RESTORE_WITNESS:
      "0290E1AF988578FF3E74ADFC899770CE49E393ABB02F234126B8E7FF2F5C52C2",
    ASB_LAB_OFFSITE_COPY_VERIFIED:"YES_ENCRYPTED_CLOUD_COPY_VISIBLE",
    DATABASE_URL:"postgres://safe:test@dpg-dbm8v3qjnfac738pc31g-a/asb_checkout_lab_pg18"
  };
}
test("operator refuses incorrect store, backup, write-mode, database and offsite evidence",()=>{
  const e=baselineEnv();
  assert.equal(preflight(e).mode,e.ASB_LAB_REVIEWED_OP);
  for(const [k,v] of [
    ["ASB_LAB_SHOP_DOMAIN","asb-production.myshopify.com"],
    ["ASB_LAB_WRITE_MODE","lab-commit-single-attempt"],
    ["ASB_LAB_REAL_COMMIT","REVIEWED_ONE_SHOT_ONLY"],
    ["ASB_ENV","production"],
    ["ASB_LAB_BACKUP_RESTORE_WITNESS","bogus"],
    ["ASB_LAB_OFFSITE_COPY_VERIFIED","disabled"],
    ["ASB_LAB_REVIEWED_OP","NOT_A_MODE"],
    ["ASB_LAB_APNA_EDIT_PREVIEW","STAGE_WITHOUT_COMMIT"],
    ["ASB_LAB_MIGRATE_ONCE","RUN_LAB_MIGRATIONS"]
  ])assert.throws(()=>preflight({...e,[k]:v}));
  assert.throws(()=>preflight({...e,DATABASE_URL:
    "postgres://safe:test@prod.example.com/asb_checkout_lab_pg18"}));
  assert.throws(()=>preflight({...e,DATABASE_URL:
    "postgres://safe:test@dpg-dbm8v3qjnfac738pc31g-a/production"}));
});
test("reviewed DDL files explicitly held by global runner, intact and only two",()=>{
  const list=files();
  assert.equal(list.length,2);
  assert.match(list[0].name,/^029_/);
  assert.match(list[1].name,/^030_/);
  assert.ok(list.every(x=>x.sql.includes("CREATE TABLE checkout_lab_")));
  assert.ok(list.every(x=>!x.sql.includes("\nCOMMIT;")));
});
test("backup-backed lab schema install is atomic, idempotent, and leaves all simulations on hold",async t=>{
  if(!process.env.TEST_PG_URL)return t.skip("Requires disposable PostgreSQL 18 CI service");
  const root=path.join(__dirname,"..");
  const url=await H.createDatabase("asb_checkout_lab_pg18",root,{grocery:false});
  const pool=new Pool({connectionString:url,max:3});
  t.after(()=>pool.end());
  const now=new Date();
  const quote=buildQuote({cycleCode:CYCLE,deliveryDate:"2026-11-16",
    cutoff:new Date(now.getTime()+3600000)},now,SECRET);
  await pool.query(
    "INSERT INTO cycles(code,cycle_date,delivery_date,opens_at,locks_at,status)"+
    " VALUES($1,'2026-11-16','2026-11-16',clock_timestamp()-interval '1 hour',"+
    "clock_timestamp()+interval '1 hour','open')",[CYCLE]);
  await pool.query(
    "INSERT INTO checkout_quotes(quote_id,version,shop_domain,household_key,"+
    "cycle_code,delivery_date,issued_at,expires_at,signed_quote)"+
    " VALUES($1,1,$2,$3,$4,'2026-11-16',$5,$6,$7::jsonb)",
    [QUOTE,SHOP,quote.customerReference,CYCLE,quote.issuedAt,quote.expiresAt,
      JSON.stringify(quote)]);
  await pool.query(
    "INSERT INTO checkout_redemptions("+
    "quote_id,quote_version,shop_domain,household_key,cycle_code,"+
    "redemption_key,state,policy_version,expected_cod_paisa,shopify_order_gid)"+
    " VALUES($1,1,$2,$3,$4,$5,'completed','SCRATCH',4500,$6)",
    [QUOTE,SHOP,quote.customerReference,CYCLE,"asb-adr002-"+"1".repeat(40),ORDER]);
  assert.equal((await readGate(pool)).installed,0);
  assert.equal((await installSchema(pool)).state,"SCHEMA_029_030_INSTALLED_ATOMICALLY");
  assert.equal((await installSchema(pool)).state,"SCHEMA_ALREADY_RECORDED");
  assert.equal((await readGate(pool)).installed,2);
  const rows=(await pool.query("SELECT filename FROM schema_migrations WHERE filename LIKE '02%_lab_%' OR filename LIKE '030_%' ORDER BY filename")).rows;
  assert.deepEqual(rows.map(x=>x.filename),[
    "029_lab_signed_apna_amendments.sql",
    "030_lab_apna_commit_and_bill_history.sql"
  ]);
  const props=(await pool.query(
    "SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema='public'"+
    " AND table_name LIKE 'checkout_lab_apna_%'")).rows[0];
  assert.equal(props.n,4);
  const noSim=(await pool.query("SELECT COUNT(*)::int AS n FROM schema_migrations"+
    " WHERE filename ~ '^02[678]_'")).rows[0];
  assert.equal(noSim.n,0);
  // After cutoff, new schema/auth/commits are blocked, but recovery of an
  // already durable commit intent must remain possible.
  await pool.query("UPDATE cycles SET locks_at=clock_timestamp()-interval '1 minute' WHERE code=$1",[CYCLE]);
  await assert.rejects(()=>readGate(pool),/REVIEWED_LAB_CUTOFF_CLOSED/);
  assert.equal((await readGate(pool,{allowClosedForRecovery:true})).installed,2);
});
