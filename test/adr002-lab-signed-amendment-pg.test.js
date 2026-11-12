// Scratch PostgreSQL 18 only. Synthetic signed authorization, no Shopify edits.
"use strict";
const {before,after,test}=require("node:test"),assert=require("node:assert/strict");
const fs=require("node:fs"),path=require("node:path");
const {Pool}=require("pg");
const H=require("./support/harness");
const {buildQuote}=require("../scripts/lab-apna-onion-order-v1");
const {verifySignedQuote}=require("../checkout/quote-crypto-v1");
const {createPgLabSignedAmendmentJournal,makeSignedSyntheticPacket,
  SHOP,ORDER,QUOTE,CYCLE}=
  require("../checkout/lab-apna-signed-amendment-pg-v1");
const fixture=require("../checkout/fixtures/asb-checkout-lab.json");
const secret="SYNTHETIC_AMENDMENT_TEST_SECRET_01234567890";
const day="2026-11-16",f500=fixture.products[0].variants[0],f1000=fixture.products[0].variants[1];
const PKR=n=>({shopMoney:{amount:n,currencyCode:"PKR"}});
const baseOrder={
  id:ORDER,test:true,currencyCode:"PKR",
  displayFinancialStatus:"PENDING",displayFulfillmentStatus:"UNFULFILLED",
  tags:["ASB-LAB-ONLY","NEVER-FULFILL","ASB-ADR002",
    "ASB-APNA-AMENDMENT-TARGET","ASB-CYCLE-"+CYCLE],
  currentTotalPriceSet:PKR("45.00"),totalOutstandingSet:PKR("45.00"),
  lineItems:{nodes:[{id:"gid://shopify/LineItem/7500",quantity:1,
    unfulfilledQuantity:1,variant:{id:f500.gid,sku:f500.sku},
    customAttributes:[
      {key:"_asb_door",value:"apna_order"},
      {key:"_asb_product",value:"ASB-CANON-ONION"},
      {key:"_asb_qty",value:"500"},
      {key:"_asb_line_id",value:"LAB-APNA-ONION-500"}
    ]}],pageInfo:{hasNextPage:false}}
};
const catalog=[{id:fixture.products[0].productGid,status:"DRAFT",
  variants:{nodes:[
    {id:f500.gid,sku:f500.sku,price:"45.00"},
    {id:f1000.gid,sku:f1000.sku,price:"90.00"}
  ],pageInfo:{hasNextPage:false}}}];
let pool,original,household;
function client({order=baseOrder,products=catalog,granted=true}={}){
  const counters={check:0,scopes:0,order:0,catalog:0,write:0};
  const cli={
    async checkShop(){counters.check++;return {shopDomain:SHOP};},
    async readGrantedScopesForLab(){counters.scopes++;
      return {shopDomain:SHOP,ready:granted};},
    async readLabOrderForAmendment({orderGid}){counters.order++;
      assert.equal(orderGid,ORDER);return order;},
    async readProductsForPolicy({productGids}){counters.catalog++;
      assert.deepEqual(productGids,[fixture.products[0].productGid]);return products;}
  };
  return {cli,counters};
}
function journal(cli=client().cli){
  return createPgLabSignedAmendmentJournal({
    pool,shopDomain:SHOP,devDomainAllowlist:[SHOP],
    quoteSecret:secret,shopifyClient:cli
  });
}
before(async()=>{
  const url=await H.createDatabase("asb_test_lab_signed_amendment",
    path.join(__dirname,".."),{grocery:false});
  pool=new Pool({connectionString:url,max:12});
  const sql=fs.readFileSync(path.join(__dirname,"..","db","migrations",
    "029_lab_signed_apna_amendments.sql"),"utf8");
  await pool.query(sql); // migration is otherwise held
  const cycle={cycleCode:CYCLE,deliveryDate:day,
    cutoff:new Date("2026-11-15T16:00:00Z")};
  original=buildQuote(cycle,new Date("2026-11-12T06:08:00Z"),secret);
  household=original.customerReference;
  await pool.query(
    "INSERT INTO cycles(code,cycle_date,delivery_date,opens_at,locks_at,status)"+
    " VALUES($1,$2,$2,clock_timestamp()-interval '1 hour',"+
    " clock_timestamp()+interval '1 day','open')",[CYCLE,day]);
  await pool.query(
    "INSERT INTO checkout_quotes(quote_id,version,shop_domain,household_key,"+
    " cycle_code,delivery_date,issued_at,expires_at,signed_quote)"+
    " VALUES($1,1,$2,$3,$4,$5,$6,$7,$8::jsonb)",
    [QUOTE,SHOP,household,CYCLE,day,original.issuedAt,
      original.expiresAt,JSON.stringify(original)]);
  await pool.query(
    "INSERT INTO checkout_redemptions("+
    " quote_id,quote_version,shop_domain,household_key,cycle_code,"+
    " redemption_key,state,policy_version,expected_cod_paisa,"+
    " shopify_order_gid,completed_at)"+
    " VALUES($1,1,$2,$3,$4,$5,'completed','LAB-SYNTHETIC',4500,$6,clock_timestamp())",
    [QUOTE,SHOP,household,CYCLE,"asb-adr002-"+"1".repeat(40),ORDER]);
});
after(async()=>{if(pool)await pool.end();});
test("signed packet contains full exact replacement and explicitly no real customer consent",()=>{
  const packet=makeSignedSyntheticPacket({
    originalQuote:original,order:baseOrder,secret});
  assert.equal(packet.schemaVersion,"ASB_LAB_SYNTHETIC_AUTH_ONLY_V1");
  assert.equal(packet.consentMode,"SYNTHETIC_OPERATOR_LAB_ONLY");
  assert.equal(packet.realCustomerConsent,false);
  assert.equal(packet.customerNotificationApproved,false);
  assert.equal(packet.proposedLines.length,2);
  assert.equal(packet.proposedLines[0].qty,500);
  assert.equal(packet.proposedLines[1].qty,1000);
  assert.equal(packet.proposedLines[1].shopifyVariantGid,f1000.gid);
  assert.equal(packet.proposedTotalPaisa,13500);
  assert.equal(verifySignedQuote(packet,secret),true);
  const tampered={...packet,proposedTotalPaisa:13501};
  assert.equal(verifySignedQuote(tampered,secret),false);
});
test("one immutable authorisation is committed under same household-cycle lock",async()=>{
  const x=client();
  const one=await journal(x.cli).authorizeReadVerifiedSynthetic();
  assert.equal(one.state,"synthetic_authorized_uncommitted");
  assert.equal(one.shopifyModified,false);
  assert.equal(one.billSent,false);
  assert.equal(one.idempotent,false);
  assert.deepEqual(x.counters,{check:1,scopes:1,order:1,catalog:1,write:0});
  const row=(await pool.query(
    "SELECT * FROM checkout_lab_apna_signed_amendments")).rows[0];
  assert.equal(row.state,"synthetic_authorized_uncommitted");
  assert.equal(row.signed_amendment.realCustomerConsent,false);
  assert.equal(verifySignedQuote(row.signed_amendment,secret),true);
  const originalClaim=(await pool.query(
    "SELECT expected_cod_paisa,state,shopify_order_gid"+
    " FROM checkout_redemptions WHERE quote_id=$1",[QUOTE])).rows[0];
  assert.equal(Number(originalClaim.expected_cod_paisa),4500);
  assert.equal(originalClaim.state,"completed");
  assert.equal(originalClaim.shopify_order_gid,ORDER);
});
test("parallel retries converge to same authorization; no second record",async()=>{
  const j=journal(),[a,b]=await Promise.all([
    j.authorizeReadVerifiedSynthetic(),j.authorizeReadVerifiedSynthetic()]);
  assert.equal(a.authorizationId,b.authorizationId);
  assert.equal(a.idempotent,true);
  assert.equal(b.idempotent,true);
  const n=(await pool.query(
    "SELECT count(*)::int AS n FROM checkout_lab_apna_signed_amendments")).rows[0].n;
  assert.equal(n,1);
});
test("reject payment, delivery, test identity, variant price drift and missing grants",async()=>{
  const originalRow=(await pool.query(
    "SELECT count(*)::int AS n FROM checkout_lab_apna_signed_amendments")).rows[0].n;
  for(const override of [
    {order:{...baseOrder,test:false}},
    {order:{...baseOrder,displayFinancialStatus:"PAID"}},
    {order:{...baseOrder,displayFulfillmentStatus:"FULFILLED"}},
    {products:[{...catalog[0],variants:{
      ...catalog[0].variants,nodes:[
        {...catalog[0].variants.nodes[0]},
        {...catalog[0].variants.nodes[1],price:"95.00"}
      ]}}]},
    {granted:false}
  ]){
    await assert.rejects(()=>journal(client(override).cli).authorizeReadVerifiedSynthetic(),
      /LAB_AMENDMENT_SHOPIFY_NOT_ELIGIBLE|LAB_AMENDMENT_VARIANT_PRICE_CHANGED|LAB_AMENDMENT_APP_SCOPES_NOT_VERIFIED/);
  }
  assert.equal((await pool.query(
    "SELECT count(*)::int AS n FROM checkout_lab_apna_signed_amendments")).rows[0].n,
    originalRow);
});
test("closed cycle fails, even with valid signature and Shopify data",async()=>{
  await pool.query("UPDATE cycles SET status='locked' WHERE code=$1",[CYCLE]);
  try{
    await assert.rejects(()=>journal().authorizeReadVerifiedSynthetic(),
      /LAB_AMENDMENT_CYCLE_CLOSED/);
  }finally{await pool.query("UPDATE cycles SET status='open' WHERE code=$1",[CYCLE]);}
});
test("database rejects tampering or deleting signed record",async()=>{
  await assert.rejects(()=>pool.query(
    "UPDATE checkout_lab_apna_signed_amendments SET proposed_total_paisa=1"),
    /CHECK|LAB_SIGNED_AMENDMENT_APPEND_ONLY/);
  await assert.rejects(()=>pool.query(
    "DELETE FROM checkout_lab_apna_signed_amendments"),
    /LAB_SIGNED_AMENDMENT_APPEND_ONLY/);
});
test("cannot use this authorization with a different Shopify shop",()=>{
  assert.throws(()=>createPgLabSignedAmendmentJournal({
    pool,shopDomain:"production.myshopify.com",
    devDomainAllowlist:["production.myshopify.com"],
    quoteSecret:secret,shopifyClient:client().cli
  }),/LAB_AMENDMENT_WRONG_STORE/);
});
