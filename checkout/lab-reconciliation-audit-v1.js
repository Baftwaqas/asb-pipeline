// ASB Checkout Lab — pure, read-only reconciliation assessment.
// Explicitly distinguishes "no Shopify order observed" from a safe release
// of an unresolved payment/order reservation. Nothing is automatically retried.
"use strict";
const {QuoteError,verifySignedQuote}=require("./quote-crypto-v1");
const {redemptionKeyFor}=require("./redemption-v1");
const SHOP="asb-checkout-lab.myshopify.com";
const ORDER_B="gid://shopify/Order/18999612604450";
const IDS=[
  "ASB-LAB-ONCE-MON-2026-11-09",
  "ASB-LAB-ONCE-B-MON-2026-11-09"
];

function requireThat(value,code){
  if(!value)throw new QuoteError(code);
}
function assessLabClaims(rows,{quoteSecret,shopDomain=SHOP}={}){
  requireThat(shopDomain===SHOP,"WRONG_LAB_SHOP");
  requireThat(Array.isArray(rows)&&rows.length===2,"EXPECTED_TWO_LAB_CLAIMS");
  const result={};
  for(let i=0;i<IDS.length;i++){
    const r=rows.find(x=>x.quote_id===IDS[i]);
    requireThat(r&&r.quote_id===IDS[i],"LAB_QUOTE_MISSING");
    requireThat(r.shop_domain===SHOP && r.quote_version===1,"LAB_CLAIM_IDENTITY_MISMATCH");
    requireThat(r.signed_quote?.quoteId===IDS[i] &&
      r.signed_quote?.customerReference===(i?"LAB-TEST-HOUSEHOLD-ONLY-B":"LAB-TEST-HOUSEHOLD-ONLY"),
      "LAB_QUOTE_IDENTITY_MISMATCH");
    requireThat(verifySignedQuote(r.signed_quote,quoteSecret),"LAB_QUOTE_SIGNATURE_INVALID");
    requireThat(r.redemption_key===redemptionKeyFor(IDS[i],1),"LAB_REDEMPTION_KEY_MISMATCH");
    if(i===0){
      requireThat(r.state==="needs_reconcile" &&
        !r.shopify_order_gid && typeof r.reconcile_reason==="string" &&
        r.reconcile_reason.length>0,
        "LAB_UNCERTAIN_CLAIM_NOT_QUARANTINED");
      result.caseA={state:r.state,shopifyOrderRecorded:false,
        decision:"HOLD_FOR_MANUAL_REVIEW",automaticRetryAllowed:false};
    }else{
      requireThat(r.state==="completed"&&r.shopify_order_gid===ORDER_B &&
        Number(r.expected_cod_paisa)===155600,
        "LAB_COMPLETED_COD_MISMATCH");
      result.caseB={state:r.state,orderId:ORDER_B,payablePaisa:155600,
        decision:"DUPLICATE_MUST_RETURN_ORIGINAL_ORDER",automaticRetryAllowed:false};
    }
  }
  return result;
}
module.exports={assessLabClaims,IDS,ORDER_B,SHOP};
