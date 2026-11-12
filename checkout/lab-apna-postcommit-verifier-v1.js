// ASB LAB ONLY: verify independently re-read Shopify order AFTER commit.
// Never trust a successful GraphQL mutation response as proof of reconciliation.
// Caller must provide the full, paginated Shopify Admin API order shape.
"use strict";
const crypto=require("node:crypto");
const {QuoteError,canonical}=require("./quote-crypto-v1");
const {parseMoneyAsPaisa}=require("./ordercreate-v1");
const {ORDER,CYCLE}=require("./lab-apna-signed-amendment-pg-v1");
const FIRST="gid://shopify/ProductVariant/69644381683746";
const ADDED="gid://shopify/ProductVariant/69644381716514";
function insist(v,code){if(!v)throw new QuoteError(code);}
function money(set,code){
  insist(set?.shopMoney?.currencyCode==="PKR",code);
  try{return parseMoneyAsPaisa(set.shopMoney.amount);}
  catch{throw new QuoteError(code);}
}
function postCommitEvidence(order){
  insist(order&&order.id===ORDER&&order.test===true&&order.edited===true&&
    order.currencyCode==="PKR"&&
    order.displayFinancialStatus==="PENDING"&&
    order.displayFulfillmentStatus==="UNFULFILLED"&&
    Array.isArray(order.tags)&&[
      "ASB-LAB-ONLY","NEVER-FULFILL","ASB-ADR002",
      "ASB-APNA-AMENDMENT-TARGET","ASB-CYCLE-"+CYCLE
    ].every(t=>order.tags.includes(t)),
    "LAB_COMMIT_SHOPIFY_IDENTITY_OR_STATE_MISMATCH");
  const lines=order.lineItems;
  insist(lines?.pageInfo?.hasNextPage===false&&
    Array.isArray(lines.nodes)&&lines.nodes.length===2,
    "LAB_COMMIT_EXACT_TWO_VARIANTS_REQUIRED");
  const byId=new Map();
  for(const l of lines.nodes){
    insist(typeof l?.id==="string"&&
      Number.isSafeInteger(l.quantity)&&l.quantity===1&&
      Number.isSafeInteger(l.unfulfilledQuantity)&&l.unfulfilledQuantity===1&&
      typeof l.variant?.id==="string"&&!byId.has(l.variant.id),
      "LAB_COMMIT_DUPLICATE_OR_UNFULFILLED_LINE");
    byId.set(l.variant.id,l);
  }
  insist(byId.size===2&&byId.has(FIRST)&&byId.has(ADDED),
    "LAB_COMMIT_WRONG_VARIANT_SET");
  const orig=new Map((byId.get(FIRST).customAttributes||[]).map(a=>[a.key,a.value]));
  insist(orig.get("_asb_door")==="apna_order"&&
    orig.get("_asb_product")==="ASB-CANON-ONION"&&
    orig.get("_asb_qty")==="500"&&
    orig.get("_asb_line_id")==="LAB-APNA-ONION-500",
    "LAB_COMMIT_ORIGINAL_LINE_PROVENANCE_CHANGED");
  insist(money(order.currentTotalPriceSet,"LAB_COMMIT_TOTAL_INVALID")===13500&&
    money(order.totalOutstandingSet,"LAB_COMMIT_DUE_INVALID")===13500&&
    money(order.currentSubtotalPriceSet,"LAB_COMMIT_SUBTOTAL_INVALID")===13500&&
    money(order.currentTotalTaxSet,"LAB_COMMIT_TAX_INVALID")===0&&
    money(order.currentTotalDiscountsSet,"LAB_COMMIT_DISCOUNTS_INVALID")===0&&
    money(order.currentShippingPriceSet,"LAB_COMMIT_SHIPPING_INVALID")===0&&
    money(order.totalReceivedSet,"LAB_COMMIT_RECEIVED_INVALID")===0,
    "LAB_COMMIT_TOTAL_OR_COMPONENT_DRIFT");
  const fact={
    shopifyOrderGid:ORDER,
    test:true,edited:true,cycleCode:CYCLE,currency:"PKR",
    variants:[
      {variantId:FIRST,packGrams:500,quantity:1},
      {variantId:ADDED,packGrams:1000,quantity:1}
    ],
    originalPaisa:4500,addedPaisa:9000,orderTotalPaisa:13500,
    outstandingPaisa:13500,receivedPaisa:0,taxPaisa:0,
    shippingPaisa:0,discountPaisa:0,
    financialStatus:"PENDING",fulfillmentStatus:"UNFULFILLED"
  };
  const digest=crypto.createHash("sha256").update(canonical(fact),"utf8").digest("hex");
  return {fact,digest};
}
function syntheticUnsentBillVersions({attemptId,packet,evidence,originalQuoteDigest}={}){
  insist(typeof attemptId==="string"&&attemptId.length>0&&
    /^[a-f0-9]{64}$/.test(originalQuoteDigest||"")&&
    packet?.schemaVersion==="ASB_LAB_SYNTHETIC_AUTH_ONLY_V1"&&
    packet.consentMode==="SYNTHETIC_OPERATOR_LAB_ONLY"&&
    packet.realCustomerConsent===false&&
    packet.customerNotificationApproved===false&&
    packet.originalTotalPaisa===4500&&
    packet.additionalPaisa===9000&&packet.proposedTotalPaisa===13500&&
    Array.isArray(packet.originalLines)&&packet.originalLines.length===1&&
    Array.isArray(packet.proposedLines)&&packet.proposedLines.length===2&&
    evidence?.fact?.orderTotalPaisa===13500,
    "LAB_COMMIT_UNISSUED_BILL_INPUT_INVALID");
  const first={
    kind:"synthetic_checkout_source",state:"not_sent",
    attemptId,billVersion:1,currency:"PKR",totalPaisa:4500,
    sourceQuoteDigest:originalQuoteDigest,
    shopifyOrderGid:packet.shopifyOrderGid,
    groupedByDoor:{apna_order:[packet.originalLines[0].lineId]},
    lines:packet.originalLines
  };
  const hash=v=>crypto.createHash("sha256").update(canonical(v),"utf8").digest("hex");
  const firstDigest=hash(first);
  const second={
    kind:"synthetic_reconciled_amendment_draft",state:"not_sent",
    attemptId,billVersion:2,replacesVersion:1,
    supersedesDigest:firstDigest,currency:"PKR",totalPaisa:13500,
    additionalPaisa:9000,shopifyOrderGid:packet.shopifyOrderGid,
    postcommitOrderDigest:evidence.digest,
    groupedByDoor:{apna_order:packet.proposedLines.map(l=>l.lineId)},
    lines:packet.proposedLines,
    customerNotified:false,sendAuthorized:false
  };
  return {versions:[
    {version:1,supersedesVersion:null,totalPaisa:4500,
      state:"source_checkout_not_sent",snapshot:first,sha256:firstDigest},
    {version:2,supersedesVersion:1,totalPaisa:13500,
      state:"reconciled_draft_not_sent",snapshot:second,sha256:hash(second)}
  ]};
}
module.exports={postCommitEvidence,syntheticUnsentBillVersions};
