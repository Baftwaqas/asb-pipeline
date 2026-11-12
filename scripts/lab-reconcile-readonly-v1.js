#!/usr/bin/env node
// ASB Checkout Lab -- READ ONLY reconciliation and idempotency proof.
// Absolutely NO Shopify orderCreate / receipt / production DB mutation.
"use strict";
const assert=require("node:assert/strict");
const {Pool}=require("pg");
const {guardedTarget}=require("./lab-readiness-v1");
const {assessLabClaims,IDS,SHOP,ORDER_B}=require("../checkout/lab-reconciliation-audit-v1");
const {createPgRedemptionLedger}=require("../checkout/redemption-ledger-pg-v1");
const {confirmCodOrder}=require("../checkout/redemption-v1");
const {QuoteError}=require("../checkout/quote-crypto-v1");

async function runAudit({pool,quoteSecret}={}){
  if(!pool || typeof pool.query!=="function"||
     typeof quoteSecret!=="string"||Buffer.byteLength(quoteSecret,"utf8")<32)
    throw new QuoteError("LAB_AUDIT_PREREQUISITES_REQUIRED");
  const {rows}=await pool.query(
    `SELECT q.quote_id,q.signed_quote,
            r.state,r.shop_domain,r.quote_version,r.redemption_key,
            r.shopify_order_gid,r.expected_cod_paisa,r.reconcile_reason
       FROM checkout_quotes q JOIN checkout_redemptions r ON r.quote_id=q.quote_id
      WHERE q.quote_id = ANY($1::text[]) ORDER BY q.quote_id`,[IDS]);
  const assessment=assessLabClaims(rows,{quoteSecret,shopDomain:SHOP});
  const ledger=createPgRedemptionLedger({pool,shopDomain:SHOP,
    devDomainAllowlist:[SHOP],
    verifyPolicyInTransaction:async()=>{throw new QuoteError("POLICY_MUST_NOT_RUN_READONLY");}});
  const b=rows.find(x=>x.quote_id===IDS[1]),quote=b.signed_quote;
  const identity={serverAuthenticated:true,phoneVerified:true,
    householdKey:quote.customerReference,phone:"923000000000"};
  const customer={householdKey:identity.householdKey,phone:identity.phone,
    addressVerified:true,firstName:"ASB",lastName:"LAB ONLY",
    shippingAddress:{address1:"ASB SYNTHETIC QA - DO NOT DELIVER",city:"Karachi",countryCode:"PK"}};
  let attemptedShopifyWrites=0;
  const noopShopify={createOrder:async()=>{
    attemptedShopifyWrites++;
    throw new Error("UNEXPECTED_SHOPIFY_WRITE_IN_READONLY_AUDIT");
  }};
  const replay=await confirmCodOrder({
    request:{quoteId:quote.quoteId,version:quote.version,signature:quote.serverSignature},
    identity,quoteStore:{loadCurrentQuote:async()=>quote,loadCustomer:async()=>customer},
    ledger,shopify:noopShopify,quoteSecret,
    now:()=>new Date(Date.parse(quote.expiresAt)+1000),taxesDisabledApproved:true
  });
  assert.equal(replay.status,"already_created");
  assert.equal(replay.shopifyOrderGid,ORDER_B);
  assert.equal(attemptedShopifyWrites,0);
  const a=rows.find(x=>x.quote_id===IDS[0]);
  const lookedUp=await ledger.lookupCompletedQuote({quote:a.signed_quote,
    identity:{serverAuthenticated:true,phoneVerified:true,
      householdKey:a.signed_quote.customerReference},
    redemptionKey:a.redemption_key});
  assert.equal(lookedUp.state,"not_completed");
  // Critically: never clear, revive or retry case A merely because no current
  // Shopify order has been observed. The claim remains needs_reconcile.
  return {assessment,replay:{status:replay.status,orderId:replay.shopifyOrderGid},
    attemptedShopifyWrites};
}

async function main(){
  const host=guardedTarget();
  const pool=new Pool({connectionString:process.env.DATABASE_URL,max:2,
    connectionTimeoutMillis:8000,
    ssl:host.host.endsWith(".internal")||host.host.startsWith("dpg-")?false:{rejectUnauthorized:false}});
  try{
    const result=await runAudit({pool,quoteSecret:process.env.ASB_QUOTE_SECRET});
    console.log("[lab-audit] "+JSON.stringify(result));
    console.log("[lab-audit] DB_READ_ONLY; SHOPIFY_WRITES=0; CASE_A_STILL_QUARANTINED");
  }finally{await pool.end();}
}
if(require.main===module)main().catch(err=>{
  // Only sanitized error codes. Never log database URLs, tokens or HMAC material.
  const code=String(err?.code||"AUDIT_VALIDATION_FAILED");
  console.error("[lab-audit] BLOCKED "+(/^[A-Z_]{4,52}$/.test(code)?code:"AUDIT_VALIDATION_FAILED"));
  process.exitCode=3;
});
module.exports={runAudit};
