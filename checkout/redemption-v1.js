// ASB ADR-002 - fail-closed COD order redemption coordinator (DEV ONLY).
// No HTTP route and no DB schema provided here: the injected atomic ledger
// MUST implement the transaction/locks described in the contract. This
// coordinator intentionally never automatically retries an uncertain orderCreate.
"use strict";
const crypto = require("node:crypto");
const {QuoteError,verifySignedQuote} = require("./quote-crypto-v1");
const {buildOrderCreateInput,parseMoneyAsPaisa} = require("./ordercreate-v1");

function nonempty(value,name) {
  if(typeof value!=="string"||!value.trim())throw new QuoteError("MISSING_"+name);
  return value.trim();
}
function redemptionKeyFor(quoteId,version) {
  return "asb-adr002-"+crypto.createHash("sha256").update(quoteId+":"+version).digest("hex").slice(0,40);
}
function timeMs(value,key) {
  if(typeof value!=="string"||!Number.isFinite(Date.parse(value)))throw new QuoteError("INVALID_"+key);
  return Date.parse(value);
}
/**
 * Only quoteId/version/signature are accepted from the browser. The signed
 * quote, household identity, address, prices, product tier facts and pre-cutoff
 * guards must come from trusted SERVER-side records. App-proxy authentication
 * does not verify an individual customer.
 *
 * ledger.claimQuote must be one atomic Postgres transaction, including:
 *   - current quote version/expiry and shop/household/cycle identity
 *   - authoritative catalogue/price/eligibility/Apna controls
 *   - same-household cycle reservation and unique quote-chain redemption
 *   - a durable 'creating' state before Shopify is contacted
 * Returns {state:'claimed'}, {state:'completed', shopifyOrderGid}, OR
 *         {state:'creating'|'needs_reconcile'}.
 *
 * A real ledger/HTTP route is NOT shipped in this PR.
 */
async function confirmCodOrder({
  request, identity, quoteStore, ledger, shopify,
  quoteSecret, now=()=>new Date(), taxesDisabledApproved=false
}={}) {
  const quoteId=nonempty(request?.quoteId,"QUOTE_ID");
  const version=request?.version;
  if(!Number.isSafeInteger(version)||version<=0)throw new QuoteError("INVALID_QUOTE_VERSION");
  if(typeof request.signature!=="string")throw new QuoteError("MISSING_SIGNATURE");
  if(!identity || identity.serverAuthenticated!==true || !identity.phoneVerified ||
     typeof identity.householdKey!=="string" || !identity.householdKey)
    throw new QuoteError("CUSTOMER_NOT_AUTHENTICATED");
  if(typeof quoteStore?.loadCurrentQuote!=="function" ||
     typeof quoteStore?.loadCustomer!=="function" ||
     typeof ledger?.claimQuote!=="function" ||
     typeof ledger?.completeQuote!=="function" ||
     typeof ledger?.needsReconcile!=="function" ||
     typeof shopify?.createOrder!=="function")
    throw new QuoteError("REQUIRED_SERVER_ADAPTER_MISSING");
  const quote=await quoteStore.loadCurrentQuote(quoteId);
  if(!quote || quote.quoteId!==quoteId || quote.version!==version ||
     request.signature!==quote.serverSignature ||
     !verifySignedQuote(quote,quoteSecret))
    throw new QuoteError("QUOTE_AUTHENTICATION_FAILED");
  const current=now();
  if(!(current instanceof Date)||Number.isNaN(current.valueOf()))
    throw new QuoteError("INVALID_SERVER_CLOCK");
  if(current.valueOf()<timeMs(quote.issuedAt,"ISSUED_AT")||
     current.valueOf()>=timeMs(quote.expiresAt,"EXPIRES_AT"))
    throw new QuoteError("QUOTE_EXPIRED_OR_NOT_YET_VALID");
  if(identity.householdKey!==quote.customerReference)
    throw new QuoteError("HOUSEHOLD_MISMATCH");

  const customer=await quoteStore.loadCustomer(identity.householdKey);
  if(!customer || customer.householdKey!==identity.householdKey ||
     customer.phone!==identity.phone) throw new QuoteError("CUSTOMER_IDENTITY_MISMATCH");
  const redemptionKey=redemptionKeyFor(quoteId,version);
  const payload=buildOrderCreateInput({quote,customer,redemptionKey,taxesDisabledApproved});
  // Claim commits a durable reservation BEFORE any external orderCreate call.
  // It must re-check cutoff and authoritative live policy inside its DB lock.
  const claim=await ledger.claimQuote({quote,identity,redemptionKey,at:current.toISOString()});
  if(!claim || !["claimed","completed","creating","needs_reconcile"].includes(claim.state))
    throw new QuoteError("INVALID_REDEMPTION_STATE");
  if(claim.state==="completed"){
    return {status:"already_created",shopifyOrderGid:nonempty(claim.shopifyOrderGid,"ORDER_GID"),
      redemptionKey};
  }
  if(claim.state!=="claimed")
    return {status:"needs_reconcile",reason:"PREVIOUS_REDEMPTION_NOT_RESOLVED",redemptionKey};
  const claimId=nonempty(claim.claimId,"CLAIM_ID");

  // Once claimed, an unknown network outcome is NEVER retried automatically.
  try {
    const response=await shopify.createOrder({query:payload.query,variables:payload.variables});
    const data=response?.data?.orderCreate;
    if(response?.errors?.length || !data || data.userErrors?.length ||
       !data.order?.id){
      await ledger.needsReconcile({claimId,reason:"SHOPIFY_ERROR_OR_UNKNOWN_RESULT",shopifyOrderGid:data?.order?.id||null});
      return {status:"needs_reconcile",reason:"SHOPIFY_ERROR_OR_UNKNOWN_RESULT",redemptionKey};
    }
    const order=data.order;
    const set=order.currentTotalPriceSet?.shopMoney;
    let reported=null;
    try {reported=set?.currencyCode==="PKR"?parseMoneyAsPaisa(set.amount):null;}
    catch {reported=null;}
    if(reported!==payload.expectedCodPaisa || order.displayFinancialStatus!=="PENDING"){
      await ledger.needsReconcile({claimId,reason:"SHOPIFY_TOTAL_OR_PAYMENT_MISMATCH",shopifyOrderGid:order.id});
      return {status:"needs_reconcile",reason:"SHOPIFY_TOTAL_OR_PAYMENT_MISMATCH",
        shopifyOrderGid:order.id,redemptionKey};
    }
    await ledger.completeQuote({claimId,shopifyOrderGid:order.id,redemptionKey,
      expectedCodPaisa:payload.expectedCodPaisa});
    return {status:"created",shopifyOrderGid:order.id,redemptionKey,
      codPaisa:payload.expectedCodPaisa,roundingCreditPaisa:payload.roundingCreditPaisa};
  } catch (err) {
    // The HTTP request MAY have succeeded even if response processing or DB
    // update failed. Never allow a second createOrder from this quote chain.
    try {
      await ledger.needsReconcile({claimId,reason:"UNKNOWN_NETWORK_OR_PERSISTENCE_OUTCOME"});
    } catch { /* claim remains creating in durable storage; manual recovery */ }
    return {status:"needs_reconcile",reason:"UNKNOWN_NETWORK_OR_PERSISTENCE_OUTCOME",redemptionKey};
  }
}
module.exports={confirmCodOrder,redemptionKeyFor};
