#!/usr/bin/env node
"use strict";

const assert = require("node:assert/strict");
const path = require("node:path");
const { fork, execFileSync } = require("node:child_process");
const H = require("../test/support/harness");

const AWARE_DIR = path.resolve(process.env.AWARE_DIR || process.cwd());
const ROLLBACK_DIR = path.resolve(process.env.ROLLBACK_DIR || "");
const ROLLBACK_SHA = process.env.ROLLBACK_SHA;
if (!ROLLBACK_DIR || !ROLLBACK_SHA) throw new Error("ROLLBACK_DIR and ROLLBACK_SHA are required");
assert.equal(execFileSync("git",["rev-parse","HEAD"],{cwd:ROLLBACK_DIR,encoding:"utf8"}).trim(),ROLLBACK_SHA);

function child(repoDir,url,role){
  const helper=path.join(AWARE_DIR,"scripts","rehearsal-server-helper.js");
  const p=fork(helper,[repoDir,url,role],{cwd:repoDir,env:{...process.env},stdio:["ignore","pipe","pipe","ipc"]});
  p.stdout.on("data",d=>process.stdout.write(`[${role}] ${d}`));
  p.stderr.on("data",d=>process.stderr.write(`[${role}] ${d}`));
  return p;
}
function ready(p){
  return new Promise((resolve,reject)=>{
    const t=setTimeout(()=>reject(new Error("child server ready timeout")),10000);
    p.once("error",reject);
    p.on("message",m=>{if(m?.type==="ready"){clearTimeout(t);resolve(`http://127.0.0.1:${m.port}`);}});
  });
}
async function stop(p){
  if(!p||p.killed)return;
  const done=new Promise(r=>p.once("exit",r));
  p.send({type:"stop"});
  await Promise.race([done,new Promise(r=>setTimeout(r,3000))]);
  if(p.exitCode===null)p.kill("SIGKILL");
}
function receiptBody(statuses){
  return {object:"whatsapp_business_account",entry:[{id:"1",changes:[{field:"messages",value:{
    messaging_product:"whatsapp",metadata:{phone_number_id:"000000"},statuses
  }}]}]};
}
const st=(id,status,ts,recipient="923000000001")=>({id,status,timestamp:String(ts),recipient_id:recipient});

(async()=>{
  const url=await H.createDatabase("asb_inflight_overlap",AWARE_DIR);
  H.setEnv(url);
  process.env.GROCERY_SOURCE_WORKER="on";
  process.env.GROCERY_BILL_SEND="on";
  const sent=H.stubOutside(AWARE_DIR);
  const db=require(path.join(AWARE_DIR,"db"));
  const sources=require(path.join(AWARE_DIR,"grocery","sources.js"));
  const apply=require(path.join(AWARE_DIR,"grocery","apply.js"));
  const billing=require(path.join(AWARE_DIR,"grocery","billing.js"));
  const worker=require(path.join(AWARE_DIR,"grocery","worker.js"));
  const receipts=require(path.join(AWARE_DIR,"grocery","receipts.js"));
  await db.query(H.FIXTURE_SQL);

  async function reserve(order,eventId){
    const raw=JSON.stringify(order);
    return db.tx(async c=>{
      const ev=(await c.query(
        `INSERT INTO webhook_events(source,event_id,topic,payload,status)
         VALUES('shopify',$1,'orders/create',$2::jsonb,'received') RETURNING id`,
        [eventId,raw])).rows[0];
      const r=await sources.reserve(c,{shop:H.SHOP,eventRowId:ev.id,rawText:raw,payload:order});
      assert.equal(r.kind,"owner");
      return {sourceId:r.sourceId,eventRowId:ev.id};
    });
  }

  const rollback=child(ROLLBACK_DIR,url,"rollback-inflight");
  const rollbackBase=await ready(rollback);
  try {
    // 1. 017 crashed after claiming source -> processing. L3 duplicate must not touch it.
    const pOrder=H.shopifyOrder({id:8920000000001,name:"#IF-PROC",lines:[H.line(H.GROCERY.aloo,1)],
      phone:"+92 303 7400001"});
    const p=await reserve(pOrder,"if-proc-original");
    const lease=await apply.claim(db,p.sourceId);
    assert.ok(lease?.leaseToken);
    let s=(await db.query(`SELECT status,bill_state,lease_token FROM shopify_order_sources WHERE id=$1`,[p.sourceId])).rows[0];
    assert.equal(s.status,"processing");
    assert.equal(await H.postShopify(rollbackBase,pOrder,{id:"if-proc-l3"}),200);
    s=(await db.query(`SELECT status,bill_state,lease_token FROM shopify_order_sources WHERE id=$1`,[p.sourceId])).rows[0];
    assert.equal(s.status,"processing");
    assert.equal(String(s.lease_token),String(lease.leaseToken));
    await db.query(`UPDATE shopify_order_sources SET lease_until=now()-interval '1 second' WHERE id=$1`,[p.sourceId]);
    assert.equal(await apply.expireLeases(db),1);
    await db.query(`UPDATE shopify_order_sources SET next_attempt_at=now() WHERE id=$1`,[p.sourceId]);
    await worker.runOnce(db);
    s=(await db.query(`SELECT status,bill_state FROM shopify_order_sources WHERE id=$1`,[p.sourceId])).rows[0];
    assert.deepEqual([s.status,s.bill_state],["applied","sent"]);
    assert.equal((await db.query(
      `SELECT count(*)::int n FROM whatsapp_messages WHERE idempotency_key LIKE 'order_confirmed:shopify:8920000000001%'`
    )).rows[0].n,1);
    console.log("PASS processing lease: L3 untouched it; expired lease recovered and applied/billed once");

    // 2. 017 crashed after bill claim -> sending. L3 duplicate must not bill it.
    process.env.GROCERY_BILL_SEND="off";
    const bOrder=H.shopifyOrder({id:8920000000002,name:"#IF-SEND",lines:[H.line(H.GROCERY.mango,1)],
      phone:"+92 303 7400002"});
    const b=await reserve(bOrder,"if-send-original");
    await worker.runOnce(db);
    process.env.GROCERY_BILL_SEND="on";
    let bs=(await db.query(`SELECT status,bill_state FROM shopify_order_sources WHERE id=$1`,[b.sourceId])).rows[0];
    assert.deepEqual([bs.status,bs.bill_state],["applied","pending"]);
    const claim=await billing.claim(db,b.sourceId);
    assert.ok(claim?.attemptId);
    assert.equal(await H.postShopify(rollbackBase,bOrder,{id:"if-send-l3"}),200);
    bs=(await db.query(`SELECT status,bill_state,bill_current_attempt_id FROM shopify_order_sources WHERE id=$1`,[b.sourceId])).rows[0];
    assert.deepEqual([bs.status,bs.bill_state,String(bs.bill_current_attempt_id)],["applied","sending",String(claim.attemptId)]);
    assert.equal(await billing.expireClaims(db,{olderThanMin:0}),1);
    bs=(await db.query(`SELECT bill_state,bill_outcome FROM shopify_order_sources WHERE id=$1`,[b.sourceId])).rows[0];
    assert.deepEqual([bs.bill_state,bs.bill_outcome],["unknown","claim_expired"]);
    const beforeUnknown=sent.length;
    await worker.runOnce(db);
    assert.equal(sent.length,beforeUnknown,"unknown claim is never automatically resent");
    assert.equal(await billing.finalize(db,claim.attemptId,claim.token,{
      outcome:"accepted",retryable:false,wamid:"wamid.IF-LATE",ok:true,phase:"response",data:{}
    }).then(x=>x.outcome||x),"late_accepted");
    assert.equal((await db.query(`SELECT bill_state FROM shopify_order_sources WHERE id=$1`,[b.sourceId])).rows[0].bill_state,"sent");
    console.log("PASS sending claim: L3 untouched it; expiry became unknown; no auto-resend; late accepted result reconciled");

    // 3a. L3 must never regress an already-read message on a late lower-rank receipt.
    await db.query(
      `INSERT INTO whatsapp_messages
       (idempotency_key,phone,direction,status,wamid,msg_type,body_preview,sent_at,delivered_at,read_at,received_at)
       VALUES('if:read','923037400003','outbound','read','wamid.IF-READ','text','x',
              now()-interval '3 min',now()-interval '2 min',now()-interval '1 min',now()-interval '3 min')`);
    assert.equal(await H.postWhatsApp(rollbackBase,receiptBody([st("wamid.IF-READ","sent",1791878400,"923037400003")])),200);
    await new Promise(r=>setTimeout(r,150));
    const mr=(await db.query(
      `SELECT status::text,delivered_at,read_at FROM whatsapp_messages WHERE wamid='wamid.IF-READ'`
    )).rows[0];
    assert.equal(mr.status,"read","late sent must not downgrade read");
    assert.ok(mr.delivered_at,"late sent must not clear delivered_at");
    assert.ok(mr.read_at,"late sent must not clear read_at");
    const jr=(await db.query(
      `SELECT status,applied_at FROM whatsapp_receipt_backlog WHERE wamid='wamid.IF-READ' AND status='sent'`
    )).rows[0];
    assert.ok(jr,"L3 must durably journal receipt before ACK");
    assert.equal(jr.applied_at,null,"L3 leaves 017-specific proof processing for 017 replay");

    // 3b. Receipt before outbound row must survive L3 and apply when 017 returns.
    assert.equal(await H.postWhatsApp(rollbackBase,receiptBody([st("wamid.IF-EARLY","delivered",1791878460,"923037400004")])),200);
    await new Promise(r=>setTimeout(r,150));
    assert.equal((await db.query(
      `SELECT count(*)::int n FROM whatsapp_receipt_backlog WHERE wamid='wamid.IF-EARLY' AND status='delivered'`
    )).rows[0].n,1,"early receipt must be journalled despite no message row");
    await db.query(
      `INSERT INTO whatsapp_messages
       (idempotency_key,phone,direction,status,wamid,msg_type,body_preview,received_at)
       VALUES('if:early','923037400004','outbound','queued','wamid.IF-EARLY','text','x',now())`);
    assert.equal(await receipts.replay(db,{wamid:"wamid.IF-EARLY"}),1);
    const me=(await db.query(
      `SELECT status::text,delivered_at FROM whatsapp_messages WHERE wamid='wamid.IF-EARLY'`
    )).rows[0];
    assert.deepEqual([me.status,Boolean(me.delivered_at)],["delivered",true]);
    console.log("PASS receipt overlap: L3 journals before ACK, never regresses status, and 017 replays early receipt");

    console.log("IN-FLIGHT L3/017 REHEARSAL PASSED");
  } finally {
    await stop(rollback);
    await db.shutdown();
  }
})().catch(e=>{console.error(e&&e.stack||e);process.exit(1);});
