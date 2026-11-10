"use strict";
// ASB lab order-edit readiness check. Read only and deliberately NOT authorization.
// All evidence must originate from authenticated server-side Shopify/Admin + DB
// sources, never request form fields or a different Shopify connector's token.
const SHOP="asb-checkout-lab.myshopify.com";
const SCOPE_QUERY="query AsbCurrentInstallationScopes { currentAppInstallation { accessScopes { handle } } }";
const REQUIRED_TAGS=["ASB-LAB-ONLY","NEVER-FULFILL","ASB-ADR002"];
const REQUIRED_SCOPES=["read_orders","write_order_edits"];
const ORDER_GID=/^gid:\/\/shopify\/Order\/[1-9][0-9]*$/;

function iso(t){const n=Date.parse(t);return Number.isFinite(n)?n:NaN;}
function evaluateLabOrderEditReadiness({
  shopDomain,order,cycle,nowIso,
  sourceVerified=false,dbClockVerified=false,
  accessScopes,scopesVerifiedByTargetApp=false,
  originalBillVerified=false,
  customerConsentVerified=false,
  signedAmendmentVerified=false
}={}){
  const blockers=[];
  function deny(test,code){if(!test)blockers.push(code);}
  deny(shopDomain===SHOP,"WRONG_OR_UNVERIFIED_SHOP");
  deny(sourceVerified===true,"SHOPIFY_ORDER_SOURCE_NOT_VERIFIED");
  deny(order && ORDER_GID.test(order.id||""),"ORDER_ID_NOT_VERIFIED");
  const tags=new Set(Array.isArray(order?.tags)?order.tags:[]);
  for(const t of REQUIRED_TAGS)deny(tags.has(t),"TEST_ORDER_TAG_MISSING_"+t);
  deny(order?.financialStatus==="PENDING","ORDER_NOT_PENDING_COD");
  deny(order?.fulfillmentStatus==="UNFULFILLED","ORDER_NOT_UNFULFILLED");
  deny(order?.currencyCode==="PKR","ORDER_NOT_PKR");
  deny(dbClockVerified===true&&Number.isFinite(iso(nowIso)),
    "AUTHORITATIVE_DB_CLOCK_REQUIRED");
  deny(cycle?.verifiedFromDb===true&&cycle?.status==="open",
    "BOOKING_CYCLE_NOT_OPEN");
  deny(typeof cycle?.code==="string" && tags.has("ASB-CYCLE-"+cycle.code),
    "ORDER_CYCLE_TAG_MISMATCH");
  const current=iso(nowIso),open=iso(cycle?.opensAt),lock=iso(cycle?.locksAt);
  deny(Number.isFinite(current)&&Number.isFinite(open)&&
    Number.isFinite(lock)&&current>=open&&current<lock,
    "BOOKING_CUTOFF_REACHED_OR_UNVERIFIED");
  const date=typeof cycle?.deliveryDate==="string"?
    Date.parse(cycle.deliveryDate+"T23:59:59.999Z"):NaN;
  deny(Number.isFinite(current)&&Number.isFinite(date)&&current<=date,
    "DELIVERY_CYCLE_ALREADY_PASSED");
  deny(scopesVerifiedByTargetApp===true,
    "TARGET_APP_GRANTED_SCOPES_NOT_CHECKED");
  const handles=new Set(Array.isArray(accessScopes)?accessScopes:[]);
  for(const scope of REQUIRED_SCOPES)deny(handles.has(scope),"APP_SCOPE_MISSING_"+scope);
  deny(originalBillVerified===true,"ORIGINAL_BILL_NOT_RECONCILED");
  deny(customerConsentVerified===true,"CUSTOMER_AMENDMENT_CONSENT_MISSING");
  deny(signedAmendmentVerified===true,"SIGNED_AMENDMENT_QUOTE_MISSING");
  return Object.freeze({
    status:blockers.length?"BLOCKED":"READ_ONLY_PRECHECK_ONLY",
    blockers:Object.freeze(blockers),
    shopDomain:SHOP,
    mayCommit:false,maySendBill:false,mayRequestScopes:false,
    note:"Even a passing precheck does NOT authorize Shopify orderEditBegin, orderEditCommit, or bill sending."
  });
}
module.exports={evaluateLabOrderEditReadiness,SCOPE_QUERY};
