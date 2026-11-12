// PostgreSQL 18 scratch DB only; the migration is HELD for all deployments.
"use strict";
const {before,after,test}=require("node:test");
const assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const {Pool}=require("pg");
const H=require("./support/harness");
const {createPgApnaAmendmentReservation}=
  require("../checkout/apna-amendment-reservation-pg-v1");
const SHOP="asb-checkout-lab.myshopify.com";
let pool,day,cycleCode,number=0;
function nextMonday(){
  const d=new Date(Date.now()+5*86400000);
  d.setUTCHours(0,0,0,0);
  while(d.getUTCDay()!==1)d.setUTCDate(d.getUTCDate()+1);
  return d.toISOString().slice(0,10);
}
const line=(id,qty,paisa)=>({lineId:id,door:"apna_order",
  canonicalProductId:"ASB-CANON-ONION",unit:"g",qty,
  quotedLinePaisa:paisa,ceilingLinePaisa:paisa});
const policy={"ASB-CANON-ONION":{unit:"g",minQuantity:500,
  maxQuantity:2000,allowedSizes:[500,1000]}};
async function original(household){
  const n=++number,quoteId="LAB-AMEND-ORIGINAL-"+n;
  const orderGid="gid://shopify/Order/"+(9000000+n);
  const quote={quoteId,version:1,customerReference:household,
    cycleCode,deliveryDate:day,lines:[line("ONION-ORIGINAL",500,4500)]};
  await pool.query(`INSERT INTO checkout_quotes
     (quote_id,version,shop_domain,household_key,cycle_code,
      delivery_date,issued_at,expires_at,signed_quote)
     VALUES($1,1,$2,$3,$4,$5,clock_timestamp()-interval '1 minute',
       clock_timestamp()+interval '1 hour',$6::jsonb)`,
    [quoteId,SHOP,household,cycleCode,day,JSON.stringify(quote)]);
  await pool.query(`INSERT INTO checkout_redemptions
     (quote_id,quote_version,shop_domain,household_key,cycle_code,
      redemption_key,state,policy_version,expected_cod_paisa,
      shopify_order_gid,completed_at)
      VALUES($1,1,$2,$3,$4,$5,'completed','SYNTHETIC',4500,
       $6,clock_timestamp())`,
    [quoteId,SHOP,household,cycleCode,
      "asb-adr002-"+String(n).padStart(40,"0"),orderGid]);
  return {quoteId,orderGid,household};
}
function adapter(reference,{added=1000,price=9000,stage="confirmed",payment="pending_cod",
  authoritative=true,otherHistory=[]}={}){
  return async({proposalId})=>{
    const existing=line("ONION-ORIGINAL",500,4500);
    const additional=line("ONION-"+proposalId,added,price);
    return {proposalId,policyVersion:"SYNTHETIC-APNA-LAB",
      originalOrder:{shopDomain:SHOP,householdKey:reference.household,
        cycleCode,orderId:reference.quoteId,shopifyOrderGid:reference.orderGid,
        redemptionState:"completed",fulfillmentState:stage,paymentState:payment},
      originalLines:[existing],proposedLines:[existing,additional],
      existingCycleLines:[{...existing,orderId:reference.quoteId,
        householdKey:reference.household,cycleCode,status:"confirmed"},...otherHistory],
      limitsByProduct:policy,sourceVerified:authoritative,
      policyVerified:authoritative,historyVerified:authoritative};
  };
}
function key(n){return "asb-amendment-"+n.toString(16).padStart(40,"0");}
function service(ref,options){return createPgApnaAmendmentReservation({
  pool,shopDomain:SHOP,devDomainAllowlist:[SHOP],
  loadTrustedProposalInTransaction:adapter(ref,options)
});}
function args(ref,n){return {originalQuoteId:ref.quoteId,
  proposalId:"PROPOSAL-"+n,idempotencyKey:key(n),
  identity:{householdKey:ref.household,serverAuthenticated:true,phoneVerified:true}};}
async function reservationCount(ref){
  return Number((await pool.query(
    "SELECT count(*)::int AS n FROM checkout_apna_amendment_reservations WHERE original_quote_id=$1",
    [ref.quoteId])).rows[0].n);
}

before(async()=>{
  const url=await H.createDatabase("asb_test_apna_amendment_reservation",
    path.join(__dirname,".."),{grocery:false});
  pool=new Pool({connectionString:url,max:10});
  // Normal migration runner SKIPS migration 026; only this disposable scratch
  // database applies it explicitly, while protecting all connected Neon DBs.
  const sql=fs.readFileSync(path.join(__dirname,"..","db","migrations",
    "026_apna_amendment_reservations.sql"),"utf8");
  await pool.query(sql);
  day=nextMonday();cycleCode="MON-"+day;
  await pool.query(`INSERT INTO cycles
    (code,cycle_date,opens_at,locks_at,delivery_date,status)
    VALUES($1,$2,clock_timestamp()-interval '1 day',
      clock_timestamp()+interval '1 day',$2,'open')`,[cycleCode,day]);
});
after(async()=>{if(pool)await pool.end();});

test("one immutable amendment proposal is reserved; existing checkout remains untouched",async()=>{
  const r=await original("LAB-AMEND-HH-1");
  const one=await service(r).reserve(args(r,1));
  assert.equal(one.state,"reserved_preflight");
  assert.equal(one.additionalPaisa,9000);
  assert.equal(one.shopifyModified,false);assert.equal(one.billModified,false);
  assert.equal(await reservationCount(r),1);
  const claim=(await pool.query(
    "SELECT state,shopify_order_gid,expected_cod_paisa FROM checkout_redemptions WHERE quote_id=$1",
    [r.quoteId])).rows[0];
  assert.equal(claim.state,"completed");
  assert.equal(claim.shopify_order_gid,r.orderGid);
  assert.equal(Number(claim.expected_cod_paisa),4500);
  const same=await service(r).reserve(args(r,1));
  assert.equal(same.idempotent,true);
  assert.equal(same.reservationId,one.reservationId);
  assert.equal(await reservationCount(r),1);
});

test("concurrent DISTINCT amendments serialize; exactly one immutable proposal survives",async()=>{
  const r=await original("LAB-AMEND-HH-RACE");
  const s=service(r);
  const [a,b]=await Promise.allSettled([s.reserve(args(r,2)),s.reserve(args(r,3))]);
  assert.equal([a,b].filter(x=>x.status==="fulfilled").length,1);
  assert.equal([a,b].filter(x=>x.status==="rejected").length,1);
  assert.match(String([a,b].find(x=>x.status==="rejected").reason),
    /AMENDMENT_ALREADY_RESERVED_DIFFERENT_PROPOSAL/);
  assert.equal(await reservationCount(r),1);
});

test("parallel identical retries share exactly one reservation identity",async()=>{
  const r=await original("LAB-AMEND-HH-IDEMPOTENT");
  const s=service(r);
  const [a,b]=await Promise.all([s.reserve(args(r,4)),s.reserve(args(r,4))]);
  assert.equal(a.reservationId,b.reservationId);
  assert.deepEqual([a.idempotent,b.idempotent].sort(),[false,true]);
  assert.equal(await reservationCount(r),1);
});

test("2.5kg and unverified history fail closed without a durable reservation",async()=>{
  const r=await original("LAB-AMEND-HH-OVER");
  await assert.rejects(()=>service(r,{added:1000,otherHistory:[
    {...line("ONION-OTHER",1000,9000),orderId:"OTHER",householdKey:r.household,
      cycleCode,status:"pending"}
  ]}).reserve(args(r,5)),/AMENDMENT_APNA_LIMIT_VIOLATION/);
  assert.equal(await reservationCount(r),0);
  await assert.rejects(()=>service(r,{authoritative:false}).reserve(args(r,6)),
    /AMENDMENT_AUTHORITATIVE_EVIDENCE_REQUIRED/);
  assert.equal(await reservationCount(r),0);
});

test("wrong identity, paid/fulfilled order, and closed cutoff fail closed",async()=>{
  const r=await original("LAB-AMEND-HH-REFUSE");
  await assert.rejects(()=>service(r).reserve({
    ...args(r,7),identity:{householdKey:"OTHER",
      serverAuthenticated:true,phoneVerified:true}
  }),/AMENDMENT_ORIGINAL_CLAIM_NOT_ELIGIBLE/);
  await assert.rejects(()=>service(r,{payment:"paid"}).reserve(args(r,8)),
    /AMENDMENT_ORIGINAL_NOT_EDITABLE/);
  await assert.rejects(()=>service(r,{stage:"fulfilled"}).reserve(args(r,9)),
    /AMENDMENT_ORIGINAL_NOT_EDITABLE/);
  assert.equal(await reservationCount(r),0);
  await pool.query("UPDATE cycles SET status='locked' WHERE code=$1",[cycleCode]);
  try{
    await assert.rejects(()=>service(r).reserve(args(r,10)),/AMENDMENT_CYCLE_CLOSED/);
    assert.equal(await reservationCount(r),0);
  }finally{await pool.query("UPDATE cycles SET status='open' WHERE code=$1",[cycleCode]);}
});

test("database blocks silent mutation/deletion of reserved proposal",async()=>{
  const r=await original("LAB-AMEND-HH-IMMUTABLE");
  await service(r).reserve(args(r,11));
  await assert.rejects(()=>pool.query(
    "UPDATE checkout_apna_amendment_reservations SET additional_paisa=1 WHERE original_quote_id=$1",
    [r.quoteId]),/APNA_AMENDMENT_RESERVATION_IMMUTABLE/);
  await assert.rejects(()=>pool.query(
    "DELETE FROM checkout_apna_amendment_reservations WHERE original_quote_id=$1",
    [r.quoteId]),/APNA_AMENDMENT_RESERVATION_IMMUTABLE/);
  assert.equal(await reservationCount(r),1);
});

test("no production shop fallback, no fabricated staff proof",async()=>{
  assert.throws(()=>createPgApnaAmendmentReservation({
    pool,shopDomain:"apnasastabazaar.myshopify.com",
    devDomainAllowlist:["apnasastabazaar.myshopify.com"],
    loadTrustedProposalInTransaction:async()=>({})
  }),/AMENDMENT_LAB_ONLY/);
  const r=await original("LAB-AMEND-HH-UNAUTH");
  await assert.rejects(()=>service(r).reserve({
    ...args(r,12),identity:{householdKey:r.household,serverAuthenticated:true,
      phoneVerified:false}
  }),/AMENDMENT_CUSTOMER_NOT_VERIFIED/);
});
