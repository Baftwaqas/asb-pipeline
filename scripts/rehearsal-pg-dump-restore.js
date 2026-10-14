#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { Client, Pool } = require("pg");

const ROOT = path.resolve(process.env.AWARE_DIR || process.cwd());
const PROD = path.resolve(process.env.PROD_DIR || "");
const PROD_SHA = process.env.PROD_SHA || "3296c0f9acac8f645eda2c52e9ab3e1cdfa8c56e";
const BASE = String(process.env.TEST_PG_URL || "").replace(/\/+$/, "");
const SHOP = "0du4xf-6j.myshopify.com";

if (!PROD || !BASE) throw new Error("PROD_DIR and TEST_PG_URL are required");
const u = new URL(BASE);
if (!["127.0.0.1","localhost"].includes(u.hostname)) throw new Error(`REFUSED non-local TEST_PG_URL host: ${u.hostname}`);

function run(cmd,args,opts={}) {
  const r=spawnSync(cmd,args,{encoding:"utf8",maxBuffer:64*1024*1024,...opts});
  if(r.status!==0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.status}):\n${r.stdout||""}\n${r.stderr||""}`);
  return (r.stdout||"").trim();
}
assert.equal(run("git",["rev-parse","HEAD"],{cwd:PROD}),PROD_SHA,"production checkout SHA mismatch");

const sha256=(s)=>crypto.createHash("sha256").update(s).digest("hex");
function stable(v){
  if(v===null||typeof v!=="object") return JSON.stringify(v);
  if(Array.isArray(v)) return "["+v.map(stable).join(",")+"]";
  return "{"+Object.keys(v).sort().map(k=>JSON.stringify(k)+":"+stable(v[k])).join(",")+"}";
}
const ident=(s)=>'"'+String(s).replace(/"/g,'""')+'"';

async function admin(sql,params=[]){
  const c=new Client({connectionString:`${BASE}/postgres`}); await c.connect();
  try{return await c.query(sql,params);} finally{await c.end();}
}
async function configureComparisonSession(c){
  await c.query("SET TIME ZONE 'UTC'");
  await c.query("SET DateStyle TO 'ISO, YMD'");
  await c.query("SET IntervalStyle TO 'iso_8601'");
  await c.query("SET extra_float_digits TO 3");
  await c.query("SET search_path TO public");
  await c.query("SET bytea_output TO 'hex'");
}
async function conn(name){
  const c=new Client({connectionString:`${BASE}/${name}`});
  await c.connect();
  await configureComparisonSession(c);
  return c;
}
async function drop(name){await admin(`DROP DATABASE IF EXISTS ${ident(name)} WITH (FORCE)`);}

async function dataSnapshot(c){
  const tables=(await c.query(`SELECT c.relname AS table_name
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='public' AND c.relkind IN ('r','p')
    ORDER BY c.relname`)).rows.map(r=>r.table_name);
  const out={};
  for(const t of tables){
    const rows=(await c.query(`SELECT to_jsonb(x)::text AS j FROM ${ident(t)} x`)).rows.map(r=>r.j).sort();
    out[t]={count:rows.length,sha256:sha256(rows.join("\n"))};
  }
  return out;
}

async function catalogSnapshot(c){
  const qs={
    columns:`SELECT c.relname AS table_name,a.attname AS column_name,a.attnum AS ordinal_position,
      format_type(a.atttypid,a.atttypmod) AS data_type,t.typname AS udt_name,
      a.attnotnull,a.attidentity,a.attgenerated,
      pg_get_expr(ad.adbin,ad.adrelid) AS column_default
      FROM pg_attribute a
      JOIN pg_class c ON c.oid=a.attrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_type t ON t.oid=a.atttypid
      LEFT JOIN pg_attrdef ad ON ad.adrelid=a.attrelid AND ad.adnum=a.attnum
      WHERE n.nspname='public' AND c.relkind IN ('r','p')
        AND a.attnum>0 AND NOT a.attisdropped
      ORDER BY c.relname,a.attnum`,
    constraints:`SELECT c.relname AS table_name,x.conname,x.contype,
      x.condeferrable,x.condeferred,x.convalidated,
      pg_get_constraintdef(x.oid,true) AS def
      FROM pg_constraint x
      JOIN pg_class c ON c.oid=x.conrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public'
      ORDER BY c.relname,x.conname`,
    indexes:`SELECT tc.relname AS table_name,ic.relname AS index_name,
      i.indisunique,i.indisprimary,i.indisvalid,i.indisready,
      pg_get_indexdef(i.indexrelid) AS def,
      pg_get_expr(i.indpred,i.indrelid) AS predicate
      FROM pg_index i
      JOIN pg_class tc ON tc.oid=i.indrelid
      JOIN pg_class ic ON ic.oid=i.indexrelid
      JOIN pg_namespace n ON n.oid=tc.relnamespace
      WHERE n.nspname='public'
      ORDER BY tc.relname,ic.relname`,
    views:`SELECT c.relname AS view_name,pg_get_viewdef(c.oid,true) AS def
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('v','m')
      ORDER BY c.relname`,
    functions:`SELECT p.proname,pg_get_function_identity_arguments(p.oid) AS args,
      p.prokind,p.provolatile,p.prosecdef,p.proparallel,p.proconfig,
      pg_get_functiondef(p.oid) AS def
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public'
      ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)`,
    triggers:`SELECT c.relname AS table_name,t.tgname,t.tgenabled,
      pg_get_triggerdef(t.oid,true) AS def
      FROM pg_trigger t
      JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND NOT t.tgisinternal
      ORDER BY c.relname,t.tgname`,
    enums:`SELECT t.typname,e.enumsortorder,e.enumlabel
      FROM pg_type t JOIN pg_enum e ON e.enumtypid=t.oid
      JOIN pg_namespace n ON n.oid=t.typnamespace
      WHERE n.nspname='public'
      ORDER BY t.typname,e.enumsortorder`,
    extensions:`SELECT extname,extversion FROM pg_extension ORDER BY extname`,
    sequences:`SELECT c.relname AS sequencename,
      format_type(s.seqtypid,NULL) AS data_type,
      s.seqstart,s.seqmin,s.seqmax,s.seqincrement,s.seqcycle,s.seqcache,
      ps.last_value
      FROM pg_class c
      JOIN pg_namespace n ON n.oid=c.relnamespace
      JOIN pg_sequence s ON s.seqrelid=c.oid
      LEFT JOIN pg_sequences ps
        ON ps.schemaname=n.nspname AND ps.sequencename=c.relname
      WHERE n.nspname='public' AND c.relkind='S'
      ORDER BY c.relname`,
    sequence_ownership:`SELECT seq.relname AS sequence_name,tbl.relname AS table_name,
      a.attname AS column_name,d.deptype
      FROM pg_class seq
      JOIN pg_namespace ns ON ns.oid=seq.relnamespace
      JOIN pg_depend d
        ON d.classid='pg_class'::regclass AND d.objid=seq.oid
       AND d.deptype IN ('a','i')
      JOIN pg_class tbl ON tbl.oid=d.refobjid
      JOIN pg_attribute a ON a.attrelid=tbl.oid AND a.attnum=d.refobjsubid
      WHERE ns.nspname='public' AND seq.relkind='S'
      ORDER BY seq.relname,tbl.relname,a.attname`,
    relations:`SELECT c.relname,c.relkind,c.relpersistence,
      c.relrowsecurity,c.relforcerowsecurity
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p','S','v','m')
      ORDER BY c.relkind,c.relname`,
    policies:`SELECT c.relname AS table_name,p.polname,p.polpermissive,p.polcmd,
      ARRAY(
        SELECT CASE WHEN x=0 THEN 'PUBLIC' ELSE pg_get_userbyid(x) END
        FROM unnest(p.polroles) x
        ORDER BY 1
      ) AS roles,
      pg_get_expr(p.polqual,p.polrelid) AS using_expr,
      pg_get_expr(p.polwithcheck,p.polrelid) AS check_expr
      FROM pg_policy p
      JOIN pg_class c ON c.oid=p.polrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public'
      ORDER BY c.relname,p.polname`,
    migrations:`SELECT filename,sha256 FROM schema_migrations ORDER BY filename`
  };

  const parts={};
  for(const [k,q] of Object.entries(qs)) parts[k]=(await c.query(q)).rows;
  parts.large_objects=(await c.query(
    `SELECT count(*)::int AS n FROM pg_largeobject_metadata`
  )).rows[0];

  const security={
    relations:(await c.query(`SELECT c.relname,c.relkind,
      pg_get_userbyid(c.relowner) AS owner,c.relacl::text AS acl
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p','S','v','m')
      ORDER BY c.relkind,c.relname`)).rows,
    functions:(await c.query(`SELECT p.proname,
      pg_get_function_identity_arguments(p.oid) AS args,
      pg_get_userbyid(p.proowner) AS owner,p.proacl::text AS acl
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public'
      ORDER BY p.proname,pg_get_function_identity_arguments(p.oid)`)).rows,
    sequences:(await c.query(`SELECT c.relname AS sequencename,
      pg_get_userbyid(c.relowner) AS owner,c.relacl::text AS acl
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='S'
      ORDER BY c.relname`)).rows
  };

  const environment={
    database:(await c.query(`SELECT d.datname,
      pg_encoding_to_char(d.encoding) AS encoding,d.datcollate,d.datctype,
      d.datlocprovider,d.daticulocale,d.datcollversion
      FROM pg_database d WHERE d.datname=current_database()`)).rows[0],
    db_role_settings:(await c.query(`SELECT COALESCE(d.datname,'') AS database_name,
      COALESCE(r.rolname,'') AS role_name,s.setconfig
      FROM pg_db_role_setting s
      LEFT JOIN pg_database d ON d.oid=s.setdatabase
      LEFT JOIN pg_roles r ON r.oid=s.setrole
      ORDER BY 1,2`)).rows,
    role_configs:(await c.query(`SELECT rolname,rolconfig
      FROM pg_roles WHERE rolconfig IS NOT NULL ORDER BY rolname`)).rows,
    runtime:(await c.query(`SELECT
      current_setting('server_version_num') AS server_version_num,
      current_setting('default_toast_compression') AS default_toast_compression,
      current_setting('TimeZone') AS timezone,
      current_setting('search_path') AS search_path,
      current_setting('bytea_output') AS bytea_output`)).rows[0]
  };

  return {
    parts,
    sha256:sha256(stable(parts)),
    security,
    security_sha256:sha256(stable(security)),
    environment,
    environment_sha256:sha256(stable(environment))
  };
}

async function semanticSourceChecks(c){
  assert.equal((await c.query(`SELECT to_regclass('public.shopify_order_sources') AS t`)).rows[0].t,null);
  const mig=(await c.query(`SELECT filename FROM schema_migrations ORDER BY filename`)).rows.map(r=>r.filename);
  assert.equal(mig.at(-1),"016_community_intake.sql");
  const s=(await c.query(`SELECT
    (SELECT count(*)::int FROM orders) orders,
    (SELECT count(*)::int FROM order_items) order_items,
    (SELECT count(*)::int FROM customers) customers,
    (SELECT count(*)::int FROM webhook_events WHERE source='shopify' AND topic='orders/create') order_events,
    (SELECT count(*)::int FROM webhook_events WHERE source='shopify' AND topic='orders/create' AND status='processed') processed_events,
    (SELECT count(*)::int FROM community_intake) community_intake,
    (SELECT count(*)::int FROM whatsapp_messages WHERE direction='outbound') outbound`)).rows[0];
  assert.ok(s.orders>=2); assert.ok(s.order_items>=3); assert.ok(s.customers>=2);
  assert.ok(s.order_events>=5); assert.ok(s.processed_events>=5); assert.ok(s.community_intake>=2); assert.ok(s.outbound>=3);
  const oldFailure=(await c.query(`SELECT we.status,
      EXISTS(SELECT 1 FROM orders o WHERE o.shopify_order_id='8930000000005') AS has_order,
      EXISTS(SELECT 1 FROM whatsapp_messages m
              WHERE m.idempotency_key='order_confirmed:shopify:8930000000005'
                AND m.status::text IN ('sent','delivered','read')) AS bill_evidence
    FROM webhook_events we WHERE we.source='shopify' AND we.event_id='dr-failed-old-code'`)).rows[0];
  assert.deepEqual(oldFailure,{status:"processed",has_order:false,bill_evidence:true},
    "exact old-code failure must remain processed + no order + bill evidence");
  return s;
}

async function populateProduction(){
  const H=require(path.join(PROD,"test","support","harness.js"));
  const url=await H.createDatabase("asb_dr_source",PROD);
  H.setEnv(url); const sent=H.stubOutside(PROD);
  const mod=require(path.join(PROD,"server.js")); const db=require(path.join(PROD,"db"));
  const worker=require(path.join(PROD,"community","worker.js"));
  const registry=require(path.join(PROD,"scripts","community-registry.js"));
  await require(path.join(PROD,"productSync.js")).ensureSchema(db); await db.query(H.FIXTURE_SQL);
  const snap=JSON.parse(fs.readFileSync(path.join(PROD,"db","community","registry-snapshot-2026-10-08.json"),"utf8"));
  await registry.bootstrapSnapshot(db,snap.products,{file:"registry-snapshot-2026-10-08.json",apply:true});
  const server=mod.app.listen(0,"127.0.0.1"); await new Promise(r=>server.once("listening",r));
  const base=`http://127.0.0.1:${server.address().port}`;
  async function send(order,id){assert.equal(await H.postShopify(base,order,{id}),200);return H.waitWebhookDone(db,"shopify",id);}
  try{
    assert.equal(await send(H.shopifyOrder({id:8930000000001,name:"#DR-G1",lines:[H.line(H.GROCERY.aloo,2),H.line(H.GROCERY.mango,1)],
      phone:"+92 304 7500001",createdAt:"2026-10-08T06:00:00+05:00"}),"dr-grocery-1"),"processed");
    assert.equal(await send(H.shopifyOrder({id:8930000000002,name:"#DR-G2",lines:[H.line(H.GROCERY.aloo,1)],
      phone:"+92 304 7500001",createdAt:"2026-10-08T06:02:00+05:00"}),"dr-grocery-2"),"processed");
    assert.equal(await send(H.shopifyOrder({id:8930000000003,name:"#DR-COM",lines:[H.line(H.COMMUNITY.onion5Draft,1)],
      phone:"+92 304 7500002",createdAt:"2026-10-08T06:04:00+05:00"}),"dr-community-only"),"processed");
    assert.equal(await send(H.shopifyOrder({id:8930000000004,name:"#DR-MIX",
      lines:[H.line(H.GROCERY.aloo,3),H.line(H.COMMUNITY.tomato10Draft,1)],phone:"+92 304 7500003",
      createdAt:"2026-10-08T06:06:00+05:00"}),"dr-mixed"),"processed");
    const bad={variant_id:59999999999991,product_id:19999999999991,sku:"DR-BAD-PRICE",
      title:"Synthetic Restore Failure",price:"999999999999999999.00"};
    assert.equal(await send(H.shopifyOrder({id:8930000000005,name:"#DR-FAIL",lines:[H.line(bad,1)],
      phone:"+92 304 7500004",createdAt:"2026-10-08T06:08:00+05:00"}),"dr-failed-old-code"),"processed");
    await worker.runOnce(db); await worker.runOnce(db);
    const checks=await semanticSourceChecks(db); assert.ok(sent.length>=3);
    console.log("SOURCE POPULATED",JSON.stringify({...checks,stubbed_sends:sent.length}));
  } finally {await new Promise(r=>server.close(r)); await db.shutdown();}
  return url;
}

function pgContainer(){
  const raw=run("docker",["ps","--filter","ancestor=postgres:18","--format","{{.ID}}"]);
  const ids=raw.split(/\s+/).filter(Boolean);
  if(ids.length!==1) throw new Error(`expected one postgres:18 container, found ${ids.length}: ${raw}`);
  return ids[0];
}
function makeDump(cid){
  run("docker",["exec",cid,"rm","-f","/tmp/asb-dr.dump"]);
  run("docker",["exec",cid,"pg_dump","-U","postgres","--format=custom","--no-owner","--no-privileges",
    "--serializable-deferrable","--file=/tmp/asb-dr.dump","asb_dr_source"]);
  const local=path.join(process.cwd(),"asb-dr-synthetic.dump"); run("docker",["cp",`${cid}:/tmp/asb-dr.dump`,local]);
  const buf=fs.readFileSync(local); assert.ok(buf.length>10000);
  const list=run("docker",["exec",cid,"pg_restore","--list","/tmp/asb-dr.dump"]);
  assert.match(list,/TABLE DATA public orders/); assert.match(list,/TABLE DATA public webhook_events/);
  return {size:buf.length,sha256:sha256(buf)};
}
function restoreDump(cid,name){
  run("docker",["exec",cid,"dropdb","-U","postgres","--if-exists","--force",name]);
  run("docker",["exec",cid,"createdb","-U","postgres","-T","template0",name]);
  run("docker",["exec",cid,"pg_restore","-U","postgres","-d",name,"--no-owner","--no-privileges",
    "--single-transaction","--exit-on-error","/tmp/asb-dr.dump"]);
}

async function compareSourceRestore(source,restored){
  const [sd,rd,sc,rc]=await Promise.all([
    dataSnapshot(source),dataSnapshot(restored),catalogSnapshot(source),catalogSnapshot(restored)
  ]);
  assert.deepEqual(rd,sd,"canonical UTC/ISO table data must match after restore");
  assert.equal(rc.sha256,sc.sha256,"structural catalog hash must match after restore");
  assert.deepEqual(rc.parts,sc.parts,"structural catalog details must match after restore");

  return {
    data_sha256:sha256(stable(sd)),
    catalog_sha256:sc.sha256,
    tables:Object.keys(sd).length,
    rows:Object.values(sd).reduce((n,x)=>n+x.count,0),
    source_security_sha256:sc.security_sha256,
    restored_security_sha256:rc.security_sha256,
    security_metadata_equal:sc.security_sha256===rc.security_sha256,
    source_environment_sha256:sc.environment_sha256,
    restored_environment_sha256:rc.environment_sha256,
    environment_metadata_equal:sc.environment_sha256===rc.environment_sha256
  };
}

async function forwardMigrateAndBackfill(restoreUrl){
  run(process.execPath,[path.join(ROOT,"scripts","migrate.js")],{cwd:ROOT,env:{...process.env,DATABASE_URL:restoreUrl}});
  const pool=new Pool({
    connectionString:restoreUrl,
    max:2,
    options:"-c TimeZone=UTC -c DateStyle=ISO,YMD -c IntervalStyle=iso_8601 -c extra_float_digits=3"
  });
  const db={query:(t,p)=>pool.query(t,p),tx:async(fn)=>{const c=await pool.connect();try{await c.query("BEGIN");
    const r=await fn(c);await c.query("COMMIT");return r;}catch(e){await c.query("ROLLBACK");throw e;}finally{c.release();}}};
  try{
    const mig=(await db.query(`SELECT filename FROM schema_migrations ORDER BY filename`)).rows.map(r=>r.filename);
    assert.deepEqual(mig.slice(-4),["017_shopify_order_sources.sql","018_customer_shopify_id_nonunique.sql",
      "019_customer_identity_invariants.sql","020_compat_bill_recovery.sql"]);
    const backfill=require(path.join(ROOT,"grocery","backfill.js"));
    const p1=await backfill.plan(db,{shop:SHOP}),p2=await backfill.plan(db,{shop:SHOP});
    assert.equal(p1.plan_sha256,p2.plan_sha256); assert.ok(p1.rows.length>=5);
    const oldFailurePlan=p1.rows.find(r=>r.shopify_order_id==="8930000000005");
    assert.ok(oldFailurePlan,"old failed-write order must be present in backfill");
    assert.deepEqual(
      [oldFailurePlan.legacy_reason,oldFailurePlan.order_id,oldFailurePlan.legacy_bill_evidence],
      ["event_processed_unmapped",null,true],
      "old write-failure + improvised bill must be quarantined, never replayed/rebilled"
    );
    const applied=await backfill.apply(db,{shop:SHOP,by:"synthetic-dr-ci",
      reason:"synthetic pg_dump/pg_restore disaster recovery proof",planSha:p1.plan_sha256});
    assert.equal(applied.plan_sha256,p1.plan_sha256); assert.equal((await backfill.markerOf(db)).plan_sha256,p1.plan_sha256);
    assert.deepEqual(await backfill.verify(db,SHOP),[]);
    assert.equal((await db.query(`SELECT count(*)::int n FROM orders o WHERE o.shopify_order_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM shopify_order_sources s WHERE s.shopify_order_id=o.shopify_order_id)`)).rows[0].n,0);
    assert.equal((await db.query(`SELECT count(*)::int n FROM app_settings
      WHERE key IN ('grocery_source_worker_enabled','grocery_bill_send_enabled')`)).rows[0].n,0);
    const rw=require(path.join(ROOT,"grocery","rollback-reconcile.js"));
    const cb=require(path.join(ROOT,"grocery","compat-bill-reconcile.js"));
    const window={shop:SHOP,from:"2026-10-08T00:00:00Z",to:"2026-10-09T00:00:00Z"};
    const rw1=await rw.plan(db,window),rw2=await rw.plan(db,window),cb1=await cb.plan(db,window),cb2=await cb.plan(db,window);
    assert.equal(rw1.plan_sha256,rw2.plan_sha256); assert.equal(cb1.plan_sha256,cb2.plan_sha256);
    assert.equal(rw1.rows.length,0); assert.equal(cb1.rows.length,0);
    return {migrations:mig.length,backfill_rows:p1.rows.length,backfill_plan_sha256:p1.plan_sha256,
      rollback_reconcile_plan_sha256:rw1.plan_sha256,compat_bill_plan_sha256:cb1.plan_sha256,backfill_counts:p1.counts};
  } finally {await pool.end();}
}

(async()=>{
  console.log("=== BUILD EXACT PRE-017 PRODUCTION-LIKE SOURCE ===");
  await drop("asb_dr_source"); await drop("asb_dr_restore"); await populateProduction();
  const source=await conn("asb_dr_source");
  assert.equal((await catalogSnapshot(source)).parts.migrations.at(-1).filename,"016_community_intake.sql");
  console.log("=== PG18 CUSTOM-FORMAT DUMP ===");
  const cid=pgContainer(),dump=makeDump(cid); console.log(`DUMP OK size=${dump.size} sha256=${dump.sha256}`);
  console.log("=== RESTORE INTO BRAND-NEW TEMPLATE0 DATABASE ===");
  restoreDump(cid,"asb_dr_restore"); const restored=await conn("asb_dr_restore");
  const restoreProof=await compareSourceRestore(source,restored); await semanticSourceChecks(restored);
  console.log("RESTORE EXACT",JSON.stringify(restoreProof)); await source.end(); await restored.end();
  console.log("=== FORWARD-MIGRATE RESTORED COPY ONLY: 017 -> 020 ===");
  const forward=await forwardMigrateAndBackfill(`${BASE}/asb_dr_restore`);
  console.log("FORWARD RECOVERY OK",JSON.stringify(forward));
  const final=await conn("asb_dr_restore"),finalCatalog=await catalogSnapshot(final); await final.end();
  console.log(JSON.stringify({result:"SYNTHETIC_PG_DUMP_RESTORE_DRILL_PASSED",production_base:PROD_SHA,postgres:"18",
    dump:{format:"custom",no_owner:true,no_privileges:true,serializable_deferrable:true,size:dump.size,sha256:dump.sha256},
    restored_pre017:restoreProof,forward,final_catalog_sha256:finalCatalog.sha256},null,2));
})().catch(e=>{console.error(e&&e.stack||e);process.exit(1);});
