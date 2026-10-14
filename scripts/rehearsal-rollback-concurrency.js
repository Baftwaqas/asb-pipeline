#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { fork } = require("node:child_process");
const { Client } = require("pg");
const H = require("../test/support/harness");

const AWARE_DIR = path.resolve(process.env.AWARE_DIR || process.cwd());
const ROLLBACK_DIR = path.resolve(process.env.ROLLBACK_DIR || "");
const ROLLBACK_SHA = process.env.ROLLBACK_SHA;
const AWARE_SHA = process.env.AWARE_SHA;
const ITERATIONS = Number(process.env.RACE_ITERATIONS || 25);

if (!ROLLBACK_DIR || !ROLLBACK_SHA || !AWARE_SHA) {
  throw new Error("ROLLBACK_DIR, ROLLBACK_SHA and AWARE_SHA are required");
}

const { execFileSync } = require("node:child_process");
const actualAware = execFileSync("git", ["rev-parse","HEAD"], { cwd:AWARE_DIR, encoding:"utf8" }).trim();
assert.equal(actualAware, AWARE_SHA, "aware checkout SHA mismatch");
const actualRollback = execFileSync("git", ["rev-parse","HEAD"], { cwd:ROLLBACK_DIR, encoding:"utf8" }).trim();
assert.equal(actualRollback, ROLLBACK_SHA, "rollback checkout SHA mismatch");

function child(repoDir, url, role) {
  const helper = path.join(AWARE_DIR, "scripts", "rehearsal-server-helper.js");
  const p = fork(helper, [repoDir, url, role], {
    cwd: repoDir,
    env: { ...process.env },
    stdio: ["ignore","pipe","pipe","ipc"],
  });
  p.stdout.on("data", (d) => process.stdout.write(`[${role}] ${d}`));
  p.stderr.on("data", (d) => process.stderr.write(`[${role}] ${d}`));
  return p;
}

function ready(p) {
  return new Promise((resolve, reject) => {
    const t=setTimeout(()=>reject(new Error("child server ready timeout")),10000);
    p.once("error", reject);
    p.once("exit", (code) => { if (code && code !== 0) reject(new Error(`child exited ${code}`)); });
    p.on("message", (m) => {
      if (m?.type === "ready") { clearTimeout(t); resolve(`http://127.0.0.1:${m.port}`); }
    });
  });
}

async function stop(p) {
  if (!p || p.killed) return;
  const done = new Promise((resolve) => p.once("exit", resolve));
  p.send({type:"stop"});
  await Promise.race([done, new Promise((resolve)=>setTimeout(resolve,3000))]);
  if (p.exitCode === null) p.kill("SIGKILL");
}

async function q(c, sql, params=[]) { return (await c.query(sql,params)).rows; }

async function waitSettled(c, ids) {
  await H.waitFor(async () => {
    const ev = await q(c,
      `SELECT count(*)::int n
         FROM webhook_events
        WHERE event_id = ANY($1::text[]) AND status <> 'received'`, [ids]);
    if (ev[0].n !== ids.length) return null;
    const src = await q(c,
      `SELECT count(*)::int n
         FROM shopify_order_sources
        WHERE shopify_order_id = ANY($1::text[])
          AND status NOT IN ('received','processing','retryable_error')
          AND bill_state NOT IN ('pending','sending')`, [ids.map(x=>x.split(":").pop())]);
    return src[0].n >= 1;
  }, {timeoutMs:12000,everyMs:25});
}

async function setupDb(name) {
  const url=await H.createDatabase(name,AWARE_DIR);
  const c=new Client({connectionString:url});
  await c.connect();
  await c.query(H.FIXTURE_SQL);
  return {url,c};
}

async function racePosts(i, awareBase, rollbackBase, awarePayload, rollbackPayload, awareHook, rollbackHook) {
  // Alternate creation order so one build is not always favored by the JS scheduler.
  if (i % 2 === 0) {
    return Promise.all([
      H.postShopify(awareBase,awarePayload,{id:awareHook}),
      H.postShopify(rollbackBase,rollbackPayload,{id:rollbackHook}),
    ]);
  }
  const r=await Promise.all([
    H.postShopify(rollbackBase,rollbackPayload,{id:rollbackHook}),
    H.postShopify(awareBase,awarePayload,{id:awareHook}),
  ]);
  return [r[1],r[0]];
}

async function sameOrderScenario() {
  const {url,c}=await setupDb("asb_race_same_order");
  const aware=child(AWARE_DIR,url,"aware-same");
  const rollback=child(ROLLBACK_DIR,url,"rollback-same");
  const [awareBase,rollbackBase]=await Promise.all([ready(aware),ready(rollback)]);
  let liveWins=0, compatWins=0;
  try {
    for(let i=0;i<ITERATIONS;i++) {
      const oid=8900000000000+i;
      const phone=`+92 301 ${String(7200000+i).slice(-7)}`;
      const order=H.shopifyOrder({id:oid,name:`#RACE-S-${i}`,lines:[H.line(H.GROCERY.aloo,1)],phone});
      const ah=`aware:same:${oid}`, rh=`rollback:same:${oid}`;
      const statuses=await racePosts(i,awareBase,rollbackBase,order,order,ah,rh);
      assert.deepEqual(statuses,[200,200],`same-order HTTP status iteration ${i}`);

      await H.waitFor(async()=>{
        const s=await q(c,`SELECT origin,status,bill_state,order_id FROM shopify_order_sources WHERE shopify_order_id=$1`,[String(oid)]);
        if(s.length!==1) return null;
        if(["received","processing","retryable_error"].includes(s[0].status)) return null;
        if(["pending","sending"].includes(s[0].bill_state)) return null;
        return s[0];
      },{timeoutMs:12000,everyMs:25});

      const sources=await q(c,`SELECT origin,status,bill_state,order_id FROM shopify_order_sources WHERE shopify_order_id=$1`,[String(oid)]);
      assert.equal(sources.length,1,`same-order source count iteration ${i}`);
      assert.ok(sources[0].order_id,`same-order source linked iteration ${i}`);
      if(sources[0].origin==="live") liveWins++; else if(sources[0].origin==="compat") compatWins++;
      else assert.fail(`unexpected source origin ${sources[0].origin}`);

      const orders=await q(c,`SELECT id FROM orders WHERE shopify_order_id=$1`,[String(oid)]);
      assert.equal(orders.length,1,`same-order one ASB order iteration ${i}`);
      assert.equal(String(orders[0].id),String(sources[0].order_id));

      const qty=await q(c,
        `SELECT sum(oi.qty_ordered)::float q
           FROM order_items oi JOIN orders o ON o.id=oi.order_id
          WHERE o.shopify_order_id=$1`,[String(oid)]);
      assert.equal(qty[0].q,1,`same-order quantity exactly once iteration ${i}`);

      const bills=await q(c,
        `SELECT idempotency_key,status::text
           FROM whatsapp_messages
          WHERE idempotency_key LIKE $1
          ORDER BY id`,[`order_confirmed:shopify:${oid}%`]);
      assert.equal(bills.length,1,`same-order exactly one customer confirmation iteration ${i}`);
    }
    console.log(`PASS same Shopify order: ${ITERATIONS} simultaneous races; live wins=${liveWins}, compat wins=${compatWins}`);
  } finally {
    await Promise.allSettled([stop(aware),stop(rollback)]);
    await c.end();
  }
}

async function sameHouseholdScenario() {
  const {url,c}=await setupDb("asb_race_same_household");
  const aware=child(AWARE_DIR,url,"aware-house");
  const rollback=child(ROLLBACK_DIR,url,"rollback-house");
  const [awareBase,rollbackBase]=await Promise.all([ready(aware),ready(rollback)]);
  try {
    for(let i=0;i<ITERATIONS;i++) {
      const awareId=8910000000000+(i*2);
      const rollbackId=awareId+1;
      const phone=`+92 302 ${String(7300000+i).slice(-7)}`;
      const ao=H.shopifyOrder({id:awareId,name:`#RACE-A-${i}`,lines:[H.line(H.GROCERY.aloo,1)],phone});
      const ro=H.shopifyOrder({id:rollbackId,name:`#RACE-R-${i}`,
        lines:[H.line(H.GROCERY.aloo,3),H.line(H.GROCERY.mango,1)],phone});
      const ah=`aware:house:${awareId}`, rh=`rollback:house:${rollbackId}`;
      const statuses=await racePosts(i,awareBase,rollbackBase,ao,ro,ah,rh);
      assert.deepEqual(statuses,[200,200],`same-household HTTP status iteration ${i}`);

      await H.waitFor(async()=>{
        const s=await q(c,
          `SELECT shopify_order_id,status,bill_state,order_id,disposition
             FROM shopify_order_sources
            WHERE shopify_order_id=ANY($1::text[])
            ORDER BY shopify_order_id`,[[String(awareId),String(rollbackId)]]);
        if(s.length!==2) return null;
        if(s.some(x=>["received","processing","retryable_error"].includes(x.status))) return null;
        if(s.some(x=>["pending","sending"].includes(x.bill_state))) return null;
        return s;
      },{timeoutMs:12000,everyMs:25});

      const sources=await q(c,
        `SELECT shopify_order_id,origin,status,bill_state,order_id,disposition
           FROM shopify_order_sources
          WHERE shopify_order_id=ANY($1::text[])
          ORDER BY shopify_order_id`,[[String(awareId),String(rollbackId)]]);
      assert.equal(sources.length,2);
      assert.equal(String(sources[0].order_id),String(sources[1].order_id),`same household one bag iteration ${i}`);
      assert.deepEqual(sources.map(x=>x.disposition).sort(),["created","merged"],`created+merged iteration ${i}`);

      const bagId=sources[0].order_id;
      const bags=await q(c,`SELECT count(*)::int n FROM orders WHERE id=$1`,[bagId]);
      assert.equal(bags[0].n,1);

      const qty=await q(c,
        `SELECT p.sku,sum(oi.qty_ordered)::float q
           FROM order_items oi JOIN products p ON p.id=oi.product_id
          WHERE oi.order_id=$1 GROUP BY p.sku ORDER BY p.sku`,[bagId]);
      assert.deepEqual(qty,[{sku:"ASB-FRT-001",q:1},{sku:"ASB-VEG-001",q:4}],
        `same household exact merged quantities iteration ${i}`);

      for(const oid of [awareId,rollbackId]) {
        const bills=await q(c,
          `SELECT idempotency_key FROM whatsapp_messages
            WHERE idempotency_key LIKE $1`,[`order_confirmed:shopify:${oid}%`]);
        assert.equal(bills.length,1,`one bill for Shopify order ${oid}, iteration ${i}`);
      }
    }
    console.log(`PASS different Shopify orders / same household: ${ITERATIONS} simultaneous races; one bag, exact quantities, two bills every time`);
  } finally {
    await Promise.allSettled([stop(aware),stop(rollback)]);
    await c.end();
  }
}

(async()=>{
  console.log(`Running true cross-build concurrency rehearsal: ${ITERATIONS} + ${ITERATIONS} simultaneous races`);
  await sameOrderScenario();
  await sameHouseholdScenario();
  console.log(`TRUE L3/017 CONCURRENCY REHEARSAL PASSED (${ITERATIONS*2} race iterations)`);
})().catch((e)=>{
  console.error(e && e.stack || e);
  process.exit(1);
});
