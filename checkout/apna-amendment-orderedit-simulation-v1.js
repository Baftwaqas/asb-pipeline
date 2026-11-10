// ASB Phase 3: Shopify order-edit PLAN and simulated bill reconciliation only.
// NO API client, HTTP route, external mutation, payment capture, bill send or live activation.
// These GraphQL documents are templates, not executable authorization.
"use strict";
const crypto=require("node:crypto");
const {QuoteError,canonical}=require("./quote-crypto-v1");
const {parseMoneyAsPaisa}=require("./ordercreate-v1");

const SHOP="asb-checkout-lab.myshopify.com";
const ORDER=/^gid:\/\/shopify\/Order\/[1-9][0-9]*$/;
const VARIANT=/^gid:\/\/shopify\/ProductVariant\/[1-9][0-9]*$/;
const CALCULATED=/^gid:\/\/shopify\/CalculatedOrder\/[1-9][0-9]*$/;
const BEGIN="mutation ASBAmendmentBegin($id: ID!){ orderEditBegin(id:$id){ calculatedOrder{id totalPriceSet{shopMoney{amount currencyCode}}} userErrors{field message} } }";
const ADD="mutation ASBAmendmentAdd($id: ID!,$variantId: ID!,$quantity: Int!,$allowDuplicates: Boolean){ orderEditAddVariant(id:$id,variantId:$variantId,quantity:$quantity,allowDuplicates:$allowDuplicates){ calculatedOrder{id totalPriceSet{shopMoney{amount currencyCode}}} userErrors{field message} } }";
const COMMIT="mutation ASBAmendmentCommit($id: ID!,$notifyCustomer: Boolean,$staffNote: String){ orderEditCommit(id:$id,notifyCustomer:$notifyCustomer,staffNote:$staffNote){ order{id displayFinancialStatus displayFulfillmentStatus currentTotalPriceSet{shopMoney{amount currencyCode}} totalOutstandingSet{shopMoney{amount currencyCode}}} userErrors{field message} } }";
function requireIt(x,code){if(!x)throw new QuoteError(code);}
function sha(x){return crypto.createHash("sha256").update(canonical(x),"utf8").digest("hex");}
function nonnegative(x){return Number.isSafeInteger(x)&&x>=0;}
function money(m,code){
  requireIt(m?.currencyCode==="PKR",code);
  try{return parseMoneyAsPaisa(m.amount);}catch{throw new QuoteError(code);}
}
function checkedSum(lines){
  requireIt(Array.isArray(lines)&&lines.length<=150,"AMENDMENT_BILL_INVALID_LINES");
  let total=0;
  for(const x of lines){
    requireIt(nonnegative(x?.quotedLinePaisa)&&Number.isSafeInteger(total+x.quotedLinePaisa),
      "AMENDMENT_BILL_INVALID_MONEY");
    total+=x.quotedLinePaisa;
  }
  return total;
}
function ownLine(line){return line&&typeof line==="object"&&typeof line.lineId==="string"&&
  typeof line.door==="string"&&typeof line.canonicalProductId==="string"&&
  typeof line.unit==="string"&&Number.isSafeInteger(line.qty)&&line.qty>0&&
  VARIANT.test(line.shopifyVariantGid||"");}
function mapLines(lines){
  requireIt(Array.isArray(lines)&&lines.length>0&&lines.length<=150,"AMENDMENT_INVALID_LINES");
  const result=new Map();
  for(const line of lines){
    requireIt(ownLine(line)&&!result.has(line.lineId),"AMENDMENT_INVALID_OR_DUPLICATE_LINE");
    result.set(line.lineId,line);
  }
  return result;
}
function validateReservedProposal({
  reservation,originalOrder,variantBindings,existingBill,
  shopifyVerified=false,bindingsVerified=false,policyVerified=false
}={}){
  requireIt(shopifyVerified&&bindingsVerified&&policyVerified,
    "AMENDMENT_TRUSTED_SOURCES_REQUIRED");
  requireIt(reservation?.state==="reserved_preflight"&&
    reservation.shopDomain===SHOP&&ORDER.test(reservation.shopifyOrderGid||"")&&
    /^[a-f0-9]{64}$/.test(reservation.snapshotSha256||"")&&
    nonnegative(reservation.additionalPaisa)&&
    typeof reservation.reservationId==="string"&&reservation.reservationId.length>0,
    "AMENDMENT_INVALID_RESERVATION");
  const snap=reservation.proposedSnapshot;
  requireIt(snap&&sha(snap)===reservation.snapshotSha256,
    "AMENDMENT_RESERVATION_INTEGRITY_ERROR");
  requireIt(snap.originalQuoteId===reservation.originalQuoteId&&
    typeof snap.policyVersion==="string"&&snap.policyVersion.length>0,
    "AMENDMENT_RELEASE_MISMATCH");
  requireIt(originalOrder?.id===reservation.shopifyOrderGid&&
    originalOrder.displayFinancialStatus==="PENDING"&&
    originalOrder.displayFulfillmentStatus==="UNFULFILLED",
    "AMENDMENT_SHOPIFY_ORDER_NOT_ELIGIBLE");
  const oldValue=money(originalOrder.currentTotalPriceSet?.shopMoney,
    "AMENDMENT_SHOPIFY_ORIGINAL_TOTAL_INVALID");
  requireIt(money(originalOrder.totalOutstandingSet?.shopMoney,
    "AMENDMENT_SHOPIFY_OUTSTANDING_INVALID")===oldValue,
    "AMENDMENT_SHOPIFY_OUTSTANDING_DRIFT");
  requireIt(existingBill?.shopifyOrderGid===originalOrder.id&&
    Number.isSafeInteger(existingBill.version)&&existingBill.version>=1&&
    existingBill.state==="sent"&&
    existingBill.currency==="PKR"&&
    existingBill.totalPaisa===oldValue&&
    checkedSum(existingBill.lines)===oldValue,
    "AMENDMENT_ORIGINAL_BILL_MISMATCH");
  const oldLines=mapLines(snap.originalLines);
  const proposedLines=mapLines(snap.proposedLines);
  requireIt(existingBill.lines.length===oldLines.size,"AMENDMENT_BILL_SOURCE_MISMATCH");
  for(const line of existingBill.lines){
    requireIt(oldLines.has(line.lineId)&&canonical(line)===canonical(oldLines.get(line.lineId)),
      "AMENDMENT_BILL_SOURCE_MISMATCH");
  }
  for(const [id,line] of oldLines){
    requireIt(proposedLines.has(id)&&canonical(line)===canonical(proposedLines.get(id)),
      "AMENDMENT_ORIGINAL_LINE_MUTATION");
  }
  const added=[...proposedLines].filter(([id])=>!oldLines.has(id)).map(([,line])=>line);
  requireIt(added.length>0&&added.every(x=>x.door==="apna_order"),
    "AMENDMENT_ADDITION_NOT_APNA");
  requireIt(checkedSum(added)===reservation.additionalPaisa,
    "AMENDMENT_RESERVED_AMOUNT_MISMATCH");
  requireIt(Number.isSafeInteger(oldValue+reservation.additionalPaisa),
    "AMENDMENT_PRICE_OVERFLOW");

  const bindings=new Map();
  requireIt(Array.isArray(variantBindings),"AMENDMENT_VARIANT_BINDINGS_REQUIRED");
  for(const b of variantBindings){
    requireIt(b.shopDomain===SHOP&&VARIANT.test(b.variantGid||"")&&
      typeof b.canonicalProductId==="string"&&
      Number.isSafeInteger(b.packQuantity)&&b.packQuantity>0&&
      ["g","piece"].includes(b.unit)&&
      nonnegative(b.pricePaisa)&&b.active===true&&
      !bindings.has(b.variantGid),"AMENDMENT_VARIANT_BINDING_UNTRUSTED");
    bindings.set(b.variantGid,b);
  }
  const additions=added.map(line=>{
    const bind=bindings.get(line.shopifyVariantGid);
    requireIt(bind&&bind.canonicalProductId===line.canonicalProductId&&
      bind.unit===line.unit&&line.qty%bind.packQuantity===0,
      "AMENDMENT_VARIANT_PACK_MISMATCH");
    const count=line.qty/bind.packQuantity;
    requireIt(Number.isSafeInteger(count)&&count>0&&count<=2147483647&&
      Number.isSafeInteger(bind.pricePaisa*count)&&
      bind.pricePaisa*count===line.quotedLinePaisa,
      "AMENDMENT_SHOPIFY_VARIANT_PRICE_DRIFT");
    return {lineId:line.lineId,variantId:bind.variantGid,quantity:count,
      gramsOrPieces:line.qty,expectedPricePaisa:line.quotedLinePaisa};
  });
  return Object.freeze({
    mode:"SIMULATION_ONLY_NOT_AUTHORIZED",
    shopDomain:SHOP,reservationId:reservation.reservationId,
    shopifyOrderGid:originalOrder.id,
    previousBillVersion:existingBill.version,
    previousBillDigest:sha(existingBill),
    originalPaisa:oldValue,
    additionalPaisa:reservation.additionalPaisa,
    expectedFinalPaisa:oldValue+reservation.additionalPaisa,
    fullBillLines:snap.proposedLines,
    additions,
    begin:{query:BEGIN,variables:{id:originalOrder.id}},
    // CalculatedOrder ID is acquired from orderEditBegin and must never be
    // passed as a client-provided ID. No transport is implemented here.
    addMutation:ADD,commitMutation:COMMIT,
    commitVariables:{notifyCustomer:false,
      staffNote:"ASB LAB simulated amendment "+reservation.reservationId}
  });
}
function validateSimulatedPreview({plan,calculatedOrder,simulationOnly=false}={}){
  requireIt(simulationOnly===true&&plan?.mode==="SIMULATION_ONLY_NOT_AUTHORIZED",
    "AMENDMENT_SIMULATION_ONLY");
  requireIt(CALCULATED.test(calculatedOrder?.id||""),
    "AMENDMENT_CALCULATED_ORDER_REQUIRED");
  requireIt(money(calculatedOrder.totalPriceSet?.shopMoney,
    "AMENDMENT_CALCULATED_MONEY_INVALID")===plan.expectedFinalPaisa,
    "AMENDMENT_CALCULATED_TOTAL_MISMATCH");
  return {state:"precommit_preview_matches_not_committed",
    calculatedOrderId:calculatedOrder.id,expectedTotalPaisa:plan.expectedFinalPaisa};
}
function simulateBillReconciliation({
  plan,preview,shopifyCommitPayload,existingBill,
  simulationOnly=false
}={}){
  requireIt(simulationOnly===true&&plan?.mode==="SIMULATION_ONLY_NOT_AUTHORIZED",
    "AMENDMENT_SIMULATION_ONLY");
  requireIt(preview?.state==="precommit_preview_matches_not_committed"&&
    CALCULATED.test(preview.calculatedOrderId||"")&&
    preview.expectedTotalPaisa===plan.expectedFinalPaisa,
    "AMENDMENT_PREVIEW_REQUIRED");
  // This is NEVER a certificate of a live Shopify commit.
  requireIt(Array.isArray(shopifyCommitPayload?.userErrors)&&
    shopifyCommitPayload.userErrors.length===0&&shopifyCommitPayload.order,
    "AMENDMENT_COMMIT_OUTCOME_UNCERTAIN");
  const o=shopifyCommitPayload.order;
  requireIt(o.id===plan.shopifyOrderGid&&
    o.displayFinancialStatus==="PENDING"&&
    o.displayFulfillmentStatus==="UNFULFILLED",
    "AMENDMENT_COMMIT_ORDER_STATE_MISMATCH");
  requireIt(money(o.currentTotalPriceSet?.shopMoney,
    "AMENDMENT_COMMIT_TOTAL_INVALID")===plan.expectedFinalPaisa&&
    money(o.totalOutstandingSet?.shopMoney,
    "AMENDMENT_COMMIT_OUTSTANDING_INVALID")===plan.expectedFinalPaisa,
    "AMENDMENT_COMMIT_TOTAL_MISMATCH");
  requireIt(existingBill&&sha(existingBill)===plan.previousBillDigest&&
    existingBill.version===plan.previousBillVersion,
    "AMENDMENT_STALE_BILL_VERSION");
  requireIt(checkedSum(plan.fullBillLines)===plan.expectedFinalPaisa,
    "AMENDMENT_BILL_TOTAL_MISMATCH");
  const bill={
    schemaVersion:"ASB_AMENDMENT_BILL_SIMULATION_V1",
    state:"SIMULATION_DRAFT_NOT_SENT",
    shopDomain:SHOP,shopifyOrderGid:plan.shopifyOrderGid,
    reservationId:plan.reservationId,billVersion:existingBill.version+1,
    replacesBillVersion:existingBill.version,previousBillDigest:plan.previousBillDigest,
    currency:"PKR",totalPaisa:plan.expectedFinalPaisa,
    amendmentDeltaPaisa:plan.additionalPaisa,
    lines:plan.fullBillLines,
    groupedByDoor:plan.fullBillLines.reduce((acc,line)=>{
      if(!acc[line.door])acc[line.door]=[];
      acc[line.door].push(line.lineId);
      return acc;
    },{})
  };
  return {state:"SIMULATED_RECONCILED_NOT_COMMITTED_NOT_SENT",
    calculatedOrderId:preview.calculatedOrderId,
    draft:bill,draftSha256:sha(bill),
    shopifyModified:false,billSent:false};
}
module.exports={validateReservedProposal,validateSimulatedPreview,
  simulateBillReconciliation,GRAPHQL:{BEGIN,ADD,COMMIT}};
