// ASB Order Amendment Preflight V1. PURE, NON-ACTIVATING, LAB-ONLY.
// This validates additive replacements; it DOES NOT reserve inventory,
// mutate Shopify, alter a paid/COD bill or supersede a committed quote.
// All inputs MUST be loaded by trusted server code, never from the browser.
"use strict";
const {evaluateApnaCycleLimits}=require("../grocery/apna-limits");
const {QuoteError,canonical}=require("./quote-crypto-v1");
const SHOP="asb-checkout-lab.myshopify.com";
const COMPLETED=new Set(["completed"]);
const AMENDABLE=new Set(["pending","confirmed"]);
const LINE_ID=/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/;

function insist(condition,code){if(!condition)throw new QuoteError(code);}
function text(v){return typeof v==="string"&&v.trim().length>0?v.trim():null;}
function integer(n){return Number.isSafeInteger(n)&&n>=0;}
function validatedLine(line){
  insist(line&&typeof line==="object"&&!Array.isArray(line),"AMENDMENT_INVALID_LINE");
  insist(LINE_ID.test(line.lineId||""),"AMENDMENT_LINE_ID_REQUIRED");
  insist(text(line.door)&&text(line.canonicalProductId)&&text(line.unit),
    "AMENDMENT_LINE_IDENTITY_REQUIRED");
  insist(Number.isSafeInteger(line.qty)&&line.qty>0,"AMENDMENT_INVALID_QUANTITY");
  insist(integer(line.quotedLinePaisa)&&integer(line.ceilingLinePaisa)&&
    line.quotedLinePaisa<=line.ceilingLinePaisa,"AMENDMENT_INVALID_LINE_MONEY");
  return line;
}
function byId(lines){
  insist(Array.isArray(lines)&&lines.length>0&&lines.length<=150,"AMENDMENT_LINES_REQUIRED");
  const m=new Map();
  for(const raw of lines){
    const line=validatedLine(raw);
    insist(!m.has(line.lineId),"AMENDMENT_DUPLICATE_LINE_ID");
    m.set(line.lineId,line);
  }
  return m;
}
function verifyAmendmentPreflight({
  shopDomain,identity,cycle,originalOrder,originalLines,proposedLines,
  existingCycleLines,limitsByProduct,sourceVerified=false,
  historyVerified=false,policyVerified=false
}={}){
  insist(shopDomain===SHOP,"AMENDMENT_LAB_ONLY");
  insist(sourceVerified===true&&historyVerified===true&&policyVerified===true,
    "AMENDMENT_AUTHORITATIVE_EVIDENCE_REQUIRED");
  insist(identity?.serverAuthenticated===true&&identity?.phoneVerified===true&&
    text(identity.householdKey),"AMENDMENT_CUSTOMER_NOT_VERIFIED");
  insist(originalOrder&&originalOrder.shopDomain===SHOP&&
    originalOrder.householdKey===identity.householdKey&&
    text(originalOrder.cycleCode)&&originalOrder.cycleCode===cycle?.code&&
    text(originalOrder.orderId),"AMENDMENT_ORIGINAL_ORDER_MISMATCH");
  insist(COMPLETED.has(originalOrder.redemptionState)&&
    AMENDABLE.has(originalOrder.fulfillmentState)&&
    originalOrder.paymentState==="pending_cod"&&
    /^gid:\/\/shopify\/Order\/[1-9][0-9]*$/.test(originalOrder.shopifyOrderGid||""),
    "AMENDMENT_ORIGINAL_NOT_EDITABLE");
  insist(cycle?.status==="open"&&cycle.cutoffVerifiedByDatabase===true,
    "AMENDMENT_CYCLE_CLOSED_OR_UNVERIFIED");
  insist(Array.isArray(existingCycleLines),"AMENDMENT_HISTORY_REQUIRED");
  const original=byId(originalLines),replacement=byId(proposedLines);
  // The original order remains immutable. An amendment is an additive proposal
  // with stable original line IDs; changes to any previous line require an
  // independent line-adjustment policy and must not be interpreted as additions.
  for(const [id,old] of original){
    const next=replacement.get(id);
    insist(Boolean(next)&&canonical(next)===canonical(old),
      "AMENDMENT_ORIGINAL_LINES_MUST_REMAIN_UNCHANGED");
  }
  const added=[...replacement].filter(([id])=>!original.has(id)).map(([,line])=>line);
  insist(added.length>0,"AMENDMENT_NO_NEW_LINES");
  // V1 permits additional Apna items only. Other doors need independent
  // qualification, pricing, entitlement and payment change verification.
  insist(added.every(x=>x.door==="apna_order"),
    "AMENDMENT_NEW_DOOR_NOT_SUPPORTED");
  // Idempotent delta excludes the original order from previous history and
  // instead evaluates the entire replacement bag as one coherent proposition.
  const results=evaluateApnaCycleLimits({
    householdKey:identity.householdKey,cycleCode:cycle.code,
    incomingLines:proposedLines,existingCycleLines,limitsByProduct,
    editingOrderId:originalOrder.orderId
  });
  insist(results.allowed,"AMENDMENT_APNA_LIMIT_VIOLATION");
  const total=proposedLines.reduce((sum,line)=>{
    insist(Number.isSafeInteger(sum+line.quotedLinePaisa),"AMENDMENT_MONEY_OVERFLOW");
    return sum+line.quotedLinePaisa;
  },0);
  const prior=originalLines.reduce((sum,line)=>sum+line.quotedLinePaisa,0);
  insist(integer(prior)&&total>=prior,"AMENDMENT_TOTAL_INCONSISTENT");
  return Object.freeze({
    state:"preflight_only_not_reserved_not_authorized",
    shopDomain:SHOP,orderId:originalOrder.orderId,
    shopifyOrderGid:originalOrder.shopifyOrderGid,
    cycleCode:cycle.code,addedLines:added.length,
    proposedTotalPaisa:total,additionalPaisa:total-prior,
    quantityResults:results
  });
}
module.exports={verifyAmendmentPreflight};
