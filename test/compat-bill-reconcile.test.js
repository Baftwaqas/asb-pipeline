"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const H = require("./support/harness");

const ROOT = path.join(__dirname, "..");
let db, reconcile, worker, writeGroceryOrder, sent;
let seq = 8800000020000;

before(async () => {
  const url = await H.createDatabase("asb_t_compat_bill_reconcile", ROOT);
  H.setEnv(url);
  sent = H.stubOutside(ROOT);
  db = require(path.join(ROOT, "db"));
  reconcile = require(path.join(ROOT, "grocery", "compat-bill-reconcile.js"));
  worker = require(path.join(ROOT, "grocery", "worker.js"));
  writeGroceryOrder = require(path.join(ROOT, "grocery", "write.js")).writeGroceryOrder;
  await db.query(H.FIXTURE_SQL);
});

after(async () => { await db?.shutdown(); });

async function compatCase({ at, message = null, eventStatus = "processed", errorDetail = null }) {
  const oid = ++seq;
  const order = H.shopifyOrder({
    id: oid, name: `#CB-${oid % 10000}`, lines: [H.line(H.GROCERY.aloo, 1)],
    phone: `+92 300 ${String(oid).slice(-7)}`, createdAt: at,
  });
  const eventId = (await db.query(
    `INSERT INTO webhook_events (source,event_id,topic,payload,status,received_at,processed_at,error_detail)
     VALUES ('shopify',$1,'orders/create',$2::jsonb,$3,$4,
             CASE WHEN $3='processed' THEN $4::timestamptz ELSE NULL END,$5)
     RETURNING id`,
    [`compat-${oid}`, JSON.stringify(order), eventStatus, at, errorDetail]
  )).rows[0].id;

  const w = await db.tx((c) => writeGroceryOrder(c, order, H.shopifyOrder({id:oid,name:"x",lines:[],phone:order.shipping_address.phone}).shipping_address.phone.replace(/\D/g,"").replace(/^0/,"92")));
  const sourceId = (await db.query(
    `INSERT INTO shopify_order_sources
       (origin,shop,shopify_order_id,shopify_order_name,shopify_created_at,first_webhook_event_id,
        status,legacy_reason,order_id,customer_id,cycle_id,disposition,bill_state)
     VALUES ('compat',$1,$2,$3,$4,$5,'legacy','compat_inline',$6,$7,$8,$9,'legacy')
     RETURNING id`,
    [H.SHOP,String(oid),order.name,order.created_at,eventId,w.orderId,w.customerId,w.cycleId,w.merged ? "merged" : "created"]
  )).rows[0].id;

  if (message) {
    await db.query(
      `INSERT INTO whatsapp_messages
         (idempotency_key,customer_id,order_id,phone,direction,status,wamid,payload,attempts,msg_type,body_preview,received_at)
       VALUES ($1,$2,$3,$4,'outbound',$5::msg_status,$6,$7::jsonb,1,'text','old L3 bill',now())`,
      [`order_confirmed:shopify:${oid}`,w.customerId,w.orderId,
       order.shipping_address.phone.replace(/\D/g,"").replace(/^0/,"92"),
       message.status,message.wamid || null,JSON.stringify(message.payload || {})]
    );
  }
  return { oid, order, eventId, sourceId, orderId:w.orderId };
}

const opts = (hour) => ({
  shop:H.SHOP,
  from:`2026-10-13T${String(hour).padStart(2,"0")}:00:00Z`,
  to:`2026-10-13T${String(hour).padStart(2,"0")}:10:00Z`,
});

test("compat bill: definite Meta refusal becomes audited pending snapshot and sends once as attempt 2", async () => {
  const c = await compatCase({
    at:"2026-10-13T05:01:00Z",
    message:{status:"failed",payload:{response:{error:{code:131047,message:"window closed"}}}},
  });
  const p = await reconcile.plan(db, opts(5));
  assert.deepEqual([p.rows[0].action,p.rows[0].reason,p.rows[0].meta_error_code],
                   ["recover_bill","meta_error_response_proves_not_accepted","131047"]);

  await assert.rejects(
    db.query(`UPDATE shopify_order_sources SET status='applied', applied_at=now(), bill_state='pending' WHERE id=$1`,[c.sourceId]),
    /status legacy -> applied|bill_state legacy -> pending|authorization/
  );

  const before=sent.length;
  const r=await reconcile.apply(db,{...opts(5),planSha:p.plan_sha256,by:"Waqas",reason:"Meta refused old L3 send"});
  assert.equal(r.recovered,1);
  let s=(await db.query(`SELECT * FROM shopify_order_sources WHERE id=$1`,[c.sourceId])).rows[0];
  assert.deepEqual([s.status,s.bill_state,Boolean(s.bill_authorization_audit_id)],["applied","pending",true]);
  assert.equal((await db.query(`SELECT count(*)::int n FROM shopify_order_bill_snapshots WHERE source_id=$1`,[c.sourceId])).rows[0].n,1);

  await worker.runOnce(db);
  s=(await db.query(`SELECT * FROM shopify_order_sources WHERE id=$1`,[c.sourceId])).rows[0];
  assert.equal(s.bill_state,"sent");
  assert.equal(sent.length,before+1);
  const attempts=(await db.query(`SELECT attempt_no,initiated_by,authorization_audit_id FROM shopify_order_bill_attempts WHERE source_id=$1`,[c.sourceId])).rows;
  assert.deepEqual(attempts.map(x=>[x.attempt_no,x.initiated_by,Boolean(x.authorization_audit_id)]),[[2,"Waqas",true]]);
});

test("compat bill: prior sent evidence is recorded and never re-sent", async () => {
  const c=await compatCase({
    at:"2026-10-13T06:01:00Z",
    message:{status:"sent",wamid:"wamid.OLD-COMPAT-SENT",payload:{response:{messages:[{id:"wamid.OLD-COMPAT-SENT"}]}}},
  });
  const p=await reconcile.plan(db,opts(6));
  assert.equal(p.rows[0].action,"record_sent_evidence");
  const before=sent.length;
  const r=await reconcile.apply(db,{...opts(6),planSha:p.plan_sha256,by:"Waqas",reason:"record old accepted bill"});
  assert.equal(r.recorded_sent,1);
  const s=(await db.query(`SELECT status,bill_state,legacy_bill_evidence FROM shopify_order_sources WHERE id=$1`,[c.sourceId])).rows[0];
  assert.deepEqual([s.status,s.bill_state,s.legacy_bill_evidence],["legacy","legacy",true]);
  await worker.runOnce(db);
  assert.equal(sent.length,before);
});

test("compat bill: ambiguous failed send is review-only", async () => {
  const c=await compatCase({
    at:"2026-10-13T07:01:00Z",
    message:{status:"failed",payload:{response:null}},
  });
  const p=await reconcile.plan(db,opts(7));
  assert.deepEqual([p.rows[0].action,p.rows[0].reason],
                   ["review","failed_send_without_definite_non_send_evidence"]);
  const before=sent.length;
  const r=await reconcile.apply(db,{...opts(7),planSha:p.plan_sha256,by:"Waqas",reason:"ambiguous old send"});
  assert.deepEqual([r.recovered,r.review_only],[0,1]);
  const s=(await db.query(`SELECT status,bill_state FROM shopify_order_sources WHERE id=$1`,[c.sourceId])).rows[0];
  assert.deepEqual([s.status,s.bill_state],["legacy","legacy"]);
  assert.equal(sent.length,before);
});

test("compat bill: explicit pre-send compose failure can be recovered with attempt 1", async () => {
  const c=await compatCase({
    at:"2026-10-13T08:01:00Z",
    eventStatus:"failed",
    errorDetail:"rollback-compat-017: no database-composed bill available",
  });
  const p=await reconcile.plan(db,opts(8));
  assert.deepEqual([p.rows[0].action,p.rows[0].reason],["recover_bill","l3_failed_before_send"]);
  const before=sent.length;
  await reconcile.apply(db,{...opts(8),planSha:p.plan_sha256,by:"Waqas",reason:"compose fixed"});
  await worker.runOnce(db);
  const a=(await db.query(`SELECT attempt_no FROM shopify_order_bill_attempts WHERE source_id=$1`,[c.sourceId])).rows;
  assert.deepEqual(a.map(x=>x.attempt_no),[1]);
  assert.equal(sent.length,before+1);
});

test("compat bill: evidence change after dry run invalidates the approved plan", async () => {
  const c=await compatCase({
    at:"2026-10-13T09:01:00Z",
    message:{status:"failed",payload:{response:{error:{code:100,message:"bad param"}}}},
  });
  const p=await reconcile.plan(db,opts(9));
  assert.equal(p.rows[0].action,"recover_bill");
  await db.query(
    `UPDATE whatsapp_messages SET status='sent', wamid='wamid.LATE-EVIDENCE'
      WHERE idempotency_key=$1`,[`order_confirmed:shopify:${c.oid}`]
  );
  await assert.rejects(
    reconcile.apply(db,{...opts(9),planSha:p.plan_sha256,by:"Waqas",reason:"stale evidence"}),
    /plan changed since approval/
  );
  const s=(await db.query(`SELECT status,bill_state FROM shopify_order_sources WHERE id=$1`,[c.sourceId])).rows[0];
  assert.deepEqual([s.status,s.bill_state],["legacy","legacy"]);
});
