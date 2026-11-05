// ASB ADR-002: PostgreSQL claim-cycle tests. Scratch DB; no Shopify network.
"use strict";
const {test,before,after}=require("node:test");
const assert=require("node:assert/strict");
const path=require("node:path");
const {Pool}=require("pg");
const H=require("./support/harness");
const {signQuote}=require("../checkout/quote-crypto-v1");
const {createPgRedemptionLedger}=require("../checkout/redemption-ledger-pg-v1");
const {confirmCodOrder,redemptionKeyFor}=require("../checkout/redemption-v1");
const {parseMoneyAsPaisa}=require("../checkout/ordercreate-v1");
const fixtures=require("../checkout/fixtures/asb-checkout-lab.json");

const SHOP="asb-checkout-lab.myshopify.com";
const SECRET="test-only-not-for-production-use-0123456789-test-test";
const IDENTITY={serverAuthenticated:true,phoneVerified:true,householdKey:"LAB-HOUSEHOLD-A",phone:"923009990001"};
const CUSTOMER={householdKey:IDENTITY.householdKey,phone:IDENTITY.phone,
  addressVerified:true,firstName:"ASB",lastName:"Test",shippingAddress:{
    address1:"QA HOUSE TEST ONLY",city:"Karachi",countryCode:"PK"}};
let pool,cycleCode,deliveryDate,now;
function dateISO(d){return d.toISOString().slice(0,10);}
function nextMonday(d){
  const mid=new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()));
  mid.setUTCDate(mid.getUTCDate()+((8-mid.getUTCDay())%7||7));
  return dateISO(mid);
}
function makeQuote(id="LAB-Q1",over={}){
  const line={
    lineId:"L-ONION-500",door:"apna_order",
    shopifyVariantGid:fixtures.products[0].variants[0].gid,
    canonicalProductId:fixtures.products[0].canonicalProductId,
    sku:fixtures.products[0].variants[0].sku,
    productName:"ASB LAB Onion",merchandiseKind:"grocery",unit:"g",qty:500,
    sellUnitLabel:"500 g",heroTier:null,provenance:{kind:"apna_selection"},
    ceilingLinePaisa:4500,quotedLinePaisa:4500
  };
  return signQuote({
    quoteId:id,version:1,issuedAt:new Date(now.getTime()-60000).toISOString(),
    expiresAt:new Date(now.getTime()+3600000).toISOString(),
    cycleCode,deliveryDate,customerReference:IDENTITY.householdKey,currency:"PKR",
    lines:[line],quotedTotalPaisa:4500,ceilingTotalPaisa:4500,...over
  },SECRET);
}
async function seed(q) {
  await pool.query(
    `INSERT INTO checkout_quotes
     (quote_id,version,shop_domain,household_key,cycle_code,delivery_date,issued_at,expires_at,signed_quote)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [q.quoteId,q.version,SHOP,q.customerReference,q.cycleCode,q.deliveryDate,q.issuedAt,q.expiresAt,JSON.stringify(q)]
  );
}
const POLICIES=async({quote,shopDomain})=>{
  assert.equal(shopDomain,SHOP);
  // A real authoritative verifier will also read published rules and order
  // history under the same transaction lock; this test deliberately validates
  // only the synthetic fixture, never uses customer-input policy decisions.
  const ref=fixtures.products[0];
  assert.equal(quote.lines.length,1);
  assert.equal(quote.lines[0].shopifyVariantGid,ref.variants[0].gid);
  assert.equal(quote.lines[0].qty,ref.variants[0].quantityGrams);
  assert.equal(quote.lines[0].quotedLinePaisa,ref.variants[0].pricePaisa);
  return {approved:true,policyVersion:"TEST-FIXTURE-V1"};
};
function ledger(policy=POLICIES,domain=SHOP,allowlist=[SHOP]){
  return createPgRedemptionLedger({
    pool,shopDomain:domain,devDomainAllowlist:allowlist,
    verifyPolicyInTransaction:policy
  });
}
const claim=(l,q=makeQuote())=>l.claimQuote({quote:q,identity:IDENTITY,redemptionKey:redemptionKeyFor(q.quoteId,q.version)});

before(async()=>{
  const url=await H.createDatabase("asb_test_adr002_ledger",path.join(__dirname,".."),{grocery:false});
  pool=new Pool({connectionString:url,max:8});
  now=new Date();
  deliveryDate=nextMonday(now);
  cycleCode="MON-"+deliveryDate;
  await pool.query(
    `INSERT INTO cycles(code,cycle_date,opens_at,locks_at,delivery_date,status)
      VALUES($1,$2,clock_timestamp()-interval '1 day',clock_timestamp()+interval '1 day',$2,'open')`,
    [cycleCode,deliveryDate]);
});
after(async()=>{if(pool)await pool.end();});

test("T0: dev-domain and policy verifier are required; no production fallthrough",()=>{
  assert.throws(()=>ledger(POLICIES,SHOP,[]),/DEV_STORE_NOT_EXPLICITLY_ALLOWLISTED/);
  assert.throws(()=>ledger(POLICIES,"apnasastabazaar.myshopify.com",[]),/DEV_STORE_NOT_EXPLICITLY_ALLOWLISTED/);
  assert.throws(()=>createPgRedemptionLedger({pool,shopDomain:SHOP,devDomainAllowlist:[SHOP]}),
    /AUTHORITATIVE_POLICY_VERIFIER_REQUIRED/);
});

test("T0: concurrently redeeming the SAME signed quote creates one durable claim",async()=>{
  const q=makeQuote("LAB-Q1");await seed(q);
  const l=ledger();
  const [a,b]=await Promise.all([claim(l,q),claim(l,q)]);
  assert.deepEqual([a.state,b.state].sort(),["claimed","creating"].sort());
  assert.equal(a.claimId||b.claimId,b.claimId||a.claimId);
  const rows=(await pool.query("SELECT state,quote_version,policy_version,shop_domain FROM checkout_redemptions")).rows;
  assert.equal(rows.length,1);
  assert.deepEqual([rows[0].state,rows[0].policy_version,rows[0].shop_domain],
    ["creating","TEST-FIXTURE-V1",SHOP]);
  const success=await l.completeQuote({claimId:a.claimId,shopifyOrderGid:"gid://shopify/Order/7000001",
    redemptionKey:redemptionKeyFor(q.quoteId,q.version),expectedCodPaisa:4500});
  assert.equal(success.state,"completed");
  assert.equal((await claim(l,q)).shopifyOrderGid,"gid://shopify/Order/7000001");
  await assert.rejects(()=>l.completeQuote({claimId:a.claimId,shopifyOrderGid:"gid://shopify/Order/7000002",
    redemptionKey:redemptionKeyFor(q.quoteId,q.version),expectedCodPaisa:4500}),/COMPLETION_CONFLICT/);
});

test("T0: second quote for same household/cycle fails even with distinct signed quote",async()=>{
  const q=makeQuote("LAB-Q2");await seed(q);
  await assert.rejects(()=>claim(ledger(),q),/CHECKOUT_ALREADY_RESERVED/);
  const n=(await pool.query("SELECT count(*)::int n FROM checkout_redemptions")).rows[0].n;
  assert.equal(n,1);
});

test("T0: missing policy approval leaves no durable creating claim",async()=>{
  const q=makeQuote("LAB-Q3");await seed(q);
  await assert.rejects(()=>claim(ledger(async()=>({approved:false})),q),/SERVER_POLICY_NOT_APPROVED/);
  assert.equal((await pool.query("SELECT count(*)::int n FROM checkout_redemptions")).rows[0].n,1);
});

test("T0: cutoff is checked by Postgres itself, not caller supplied time",async()=>{
  const q=makeQuote("LAB-Q4");await seed(q);
  await pool.query("UPDATE cycles SET status='locked' WHERE code=$1",[cycleCode]);
  try{
    await assert.rejects(()=>claim(ledger(),q),/DELIVERY_CYCLE_NOT_OPEN/);
  }finally{
    await pool.query("UPDATE cycles SET status='open' WHERE code=$1",[cycleCode]);
  }
});

test("T0: revoked quote is refused even if signature remains valid",async()=>{
  const q=makeQuote("LAB-Q5");await seed(q);
  await pool.query("UPDATE checkout_quotes SET state='revoked' WHERE quote_id=$1",[q.quoteId]);
  await assert.rejects(()=>claim(ledger(),q),/STORED_SIGNED_QUOTE_MISMATCH/);
});

test("T0: unknown Shopify network outcome remains reserved for manual reconciliation",async()=>{
  // Use a separate customer/cycle to avoid the first claim's household lock.
  const q=makeQuote("LAB-Q6",{customerReference:"LAB-HOUSEHOLD-B"});await seed(q);
  const i={...IDENTITY,householdKey:"LAB-HOUSEHOLD-B"};
  const l=ledger();
  const key=redemptionKeyFor(q.quoteId,q.version);
  const c=await l.claimQuote({quote:q,identity:i,redemptionKey:key});
  assert.equal(c.state,"claimed");
  await l.needsReconcile({claimId:c.claimId,reason:"UNKNOWN_NETWORK_OR_PERSISTENCE_OUTCOME"});
  const retry=await l.claimQuote({quote:q,identity:i,redemptionKey:key});
  assert.equal(retry.state,"needs_reconcile");
  await assert.rejects(()=>l.completeQuote({claimId:c.claimId,redemptionKey:key,
    shopifyOrderGid:"gid://shopify/Order/7000003",expectedCodPaisa:4500}),/RECONCILIATION_REQUIRED/);
});

test("T1: signed fixture + real PG ledger + mocked Shopify create one COD order on retry",async()=>{
  // Third independent synthetic household for this integration path.
  const q=makeQuote("LAB-Q7",{customerReference:"LAB-HOUSEHOLD-C"});await seed(q);
  const i={...IDENTITY,householdKey:"LAB-HOUSEHOLD-C",phone:"923009990003"};
  const customer={...CUSTOMER,householdKey:i.householdKey,phone:i.phone};
  const l=ledger();
  let calls=0;
  const shopify={async createOrder({variables}){
    calls++;
    const amount=variables.order.lineItems.reduce((acc,x)=>acc+parseMoneyAsPaisa(x.priceSet.shopMoney.amount),0);
    return {data:{orderCreate:{userErrors:[],order:{
      id:"gid://shopify/Order/7000007",displayFinancialStatus:"PENDING",
      currentTotalPriceSet:{shopMoney:{currencyCode:"PKR",amount:(amount/100).toFixed(2)}}
    }}}};
  }};
  const kwargs={
    request:{quoteId:q.quoteId,version:q.version,signature:q.serverSignature},
    identity:i,quoteStore:{loadCurrentQuote:async()=>q,loadCustomer:async()=>customer},
    ledger:l,shopify,quoteSecret:SECRET,now:()=>new Date(),taxesDisabledApproved:true
  };
  const one=await confirmCodOrder(kwargs),two=await confirmCodOrder(kwargs);
  assert.equal(one.status,"created");
  assert.equal(two.status,"already_created");
  assert.equal(calls,1);
  assert.equal(one.codPaisa,4500);
});
