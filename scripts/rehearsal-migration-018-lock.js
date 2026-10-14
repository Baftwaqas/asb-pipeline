#!/usr/bin/env node
"use strict";

// Proves migration 018 fails fast instead of queueing customer writes.
// Ephemeral PostgreSQL only.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { Client } = require("pg");

const ROOT = path.resolve(process.env.AWARE_DIR || process.cwd());
const BASE = String(process.env.TEST_PG_URL || "").replace(/\/+$/, "");
if (!BASE) throw new Error("TEST_PG_URL is required");
const host = new URL(BASE).hostname;
if (!["127.0.0.1","localhost"].includes(host)) throw new Error(`REFUSED non-local TEST_PG_URL host: ${host}`);

const sha=(s)=>crypto.createHash("sha256").update(s,"utf8").digest("hex");
const url=`${BASE}/asb_m018_lock`;

async function admin(sql){
  const c=new Client({connectionString:`${BASE}/postgres`});
  await c.connect(); try{return await c.query(sql);} finally{await c.end();}
}

async function applyThrough017(){
  await admin(`DROP DATABASE IF EXISTS asb_m018_lock WITH (FORCE)`);
  await admin(`CREATE DATABASE asb_m018_lock`);
  const c=new Client({connectionString:url}); await c.connect();
  try{
    await c.query(`CREATE TABLE schema_migrations (
      filename TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now(), ms INTEGER)`);
    const dir=path.join(ROOT,"db","migrations");
    const held=new Set(fs.readFileSync(path.join(dir,"HOLD"),"utf8").split(/\r?\n/)
      .map(x=>x.trim()).filter(x=>x && !x.startsWith("#")));
    const files=fs.readdirSync(dir).filter(x=>/^\d{3}.*\.sql$/.test(x)).sort()
      .filter(x=>x<"018_customer_shopify_id_nonunique.sql" && !held.has(x));
    for(const f of files){
      const body=fs.readFileSync(path.join(dir,f),"utf8");
      await c.query(body);
      await c.query(`INSERT INTO schema_migrations(filename,sha256,ms) VALUES($1,$2,0)`,[f,sha(body)]);
    }
    assert.equal(files.at(-1),"017_shopify_order_sources.sql");
  } finally {await c.end();}
}

(async()=>{
  await applyThrough017();
  const blocker=new Client({connectionString:url});
  const migrator=new Client({connectionString:url});
  await blocker.connect(); await migrator.connect();
  const m18=fs.readFileSync(path.join(ROOT,"db","migrations","018_customer_shopify_id_nonunique.sql"),"utf8");

  try{
    await blocker.query("BEGIN");
    const id=(await blocker.query(`SELECT id FROM customers ORDER BY id LIMIT 1`)).rows[0]?.id;
    if(id) await blocker.query(`UPDATE customers SET name=name WHERE id=$1`,[id]);
    else {
      await blocker.query(`INSERT INTO customers(phone,name) VALUES('923000180018','lock holder')`);
    }

    const started=Date.now();
    let err=null;
    try { await migrator.query(m18); } catch(e) { err=e; }
    const elapsed=Date.now()-started;

    assert.ok(err,"018 must fail while customers is locked");
    assert.ok(
      err.code==="55P03" || /lock timeout|canceling statement due to lock timeout/i.test(err.message),
      `expected lock timeout, got code=${err.code} message=${err.message}`
    );
    assert.ok(elapsed>=4000 && elapsed<9000,`018 should fail near 5s, elapsed=${elapsed}ms`);

    const before=(await migrator.query(
      `SELECT EXISTS(
         SELECT 1 FROM pg_constraint WHERE conrelid='customers'::regclass
           AND conname='customers_shopify_customer_id_key') AS still_unique,
              to_regclass('public.idx_customers_shopify_customer_id') AS new_index`
    )).rows[0];
    assert.equal(before.still_unique,true,"failed 018 must roll back constraint change");
    assert.equal(before.new_index,null,"failed 018 must not leave its replacement index");

    await blocker.query("ROLLBACK");

    await migrator.query(m18);
    const after=(await migrator.query(
      `SELECT EXISTS(
         SELECT 1 FROM pg_constraint WHERE conrelid='customers'::regclass
           AND conname='customers_shopify_customer_id_key') AS still_unique,
              to_regclass('public.idx_customers_shopify_customer_id') IS NOT NULL AS new_index`
    )).rows[0];
    assert.equal(after.still_unique,false);
    assert.equal(after.new_index,true);

    console.log(`MIGRATION 018 LOCK-TIMEOUT PROOF PASSED elapsed_ms=${elapsed}`);
  } finally {
    try{await blocker.query("ROLLBACK");}catch(_){}
    await Promise.allSettled([blocker.end(),migrator.end()]);
  }
})().catch(e=>{console.error(e&&e.stack||e);process.exit(1);});
