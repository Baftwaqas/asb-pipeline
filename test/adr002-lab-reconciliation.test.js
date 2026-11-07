// Pure tests for dev-only manual reconciliation decisions. No external API.
"use strict";
const test=require("node:test");
const assert=require("node:assert/strict");
const {signQuote}=require("../checkout/quote-crypto-v1");
const {redemptionKeyFor}=require("../checkout/redemption-v1");
const {assessLabClaims,IDS,ORDER_B,SHOP}=
  require("../checkout/lab-reconciliation-audit-v1");
const SECRET="TEST_ONLY_HMAC_SECRET_FOR_RECONCILIATION_CHECK_0123456789";
function quote(id,household){
  return signQuote({quoteId:id,version:1,customerReference:household,
    issuedAt:"2026-11-07T05:00:00.000Z",
    expiresAt:"2026-11-07T05:10:00.000Z",
    cycleCode:"MON-2026-11-09",deliveryDate:"2026-11-09",
    currency:"PKR",lines:[],quotedTotalPaisa:155620},SECRET);
}
function rows(){
  return IDS.map((id,i)=>({
    quote_id:id,signed_quote:quote(id,i?"LAB-TEST-HOUSEHOLD-ONLY-B":"LAB-TEST-HOUSEHOLD-ONLY"),
    state:i?"completed":"needs_reconcile",shop_domain:SHOP,
    quote_version:1,redemption_key:redemptionKeyFor(id,1),
    shopify_order_gid:i?ORDER_B:null,expected_cod_paisa:i?"155600":null,
    reconcile_reason:i?null:"SHOPIFY_ERROR_OR_UNKNOWN_RESULT"
  }));
}
test("reconciliation: A is held and B returns original order; both prohibit automatic retry",()=>{
  const result=assessLabClaims(rows(),{quoteSecret:SECRET});
  assert.deepEqual(result.caseA,{state:"needs_reconcile",
    shopifyOrderRecorded:false,decision:"HOLD_FOR_MANUAL_REVIEW",automaticRetryAllowed:false});
  assert.deepEqual(result.caseB,{state:"completed",orderId:ORDER_B,
    payablePaisa:155600,decision:"DUPLICATE_MUST_RETURN_ORIGINAL_ORDER",
    automaticRetryAllowed:false});
});
test("reconciliation: missing claim or extra claim is a hard failure",()=>{
  assert.throws(()=>assessLabClaims(rows().slice(0,1),{quoteSecret:SECRET}),/EXPECTED_TWO_LAB_CLAIMS/);
  assert.throws(()=>assessLabClaims([...rows(),rows()[0]],{quoteSecret:SECRET}),/EXPECTED_TWO_LAB_CLAIMS/);
});
test("reconciliation: A cannot silently become available for a retry",()=>{
  const x=rows();x[0].state="active";
  assert.throws(()=>assessLabClaims(x,{quoteSecret:SECRET}),/LAB_UNCERTAIN_CLAIM_NOT_QUARANTINED/);
  const y=rows();y[0].shopify_order_gid="gid://shopify/Order/123";
  assert.throws(()=>assessLabClaims(y,{quoteSecret:SECRET}),/LAB_UNCERTAIN_CLAIM_NOT_QUARANTINED/);
});
test("reconciliation: B must be exact order and full collectible paisa",()=>{
  const x=rows();x[1].shopify_order_gid="gid://shopify/Order/987";
  assert.throws(()=>assessLabClaims(x,{quoteSecret:SECRET}),/LAB_COMPLETED_COD_MISMATCH/);
  const y=rows();y[1].expected_cod_paisa="155620";
  assert.throws(()=>assessLabClaims(y,{quoteSecret:SECRET}),/LAB_COMPLETED_COD_MISMATCH/);
});
test("reconciliation: tampered signed quote and redemption key are rejected",()=>{
  const x=rows();x[1].signed_quote.lines=[{qty:9999}];
  assert.throws(()=>assessLabClaims(x,{quoteSecret:SECRET}),/INVALID_SIGNATURE|LAB_QUOTE_SIGNATURE_INVALID/);
  const y=rows();y[1].redemption_key="asb-adr002-"+"0".repeat(40);
  assert.throws(()=>assessLabClaims(y,{quoteSecret:SECRET}),/LAB_REDEMPTION_KEY_MISMATCH/);
});
test("reconciliation: wrong shop cannot be audited",()=>{
  assert.throws(()=>assessLabClaims(rows(),{quoteSecret:SECRET,
    shopDomain:"another.myshopify.com"}),/WRONG_LAB_SHOP/);
});
