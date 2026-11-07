// ADR-002 Shopify orderCreate input adapter (2026-10 GraphQL Admin).
// PURE DEV MODULE. Calling this function does not place an order.
// The caller MUST retrieve a signed, SERVER-stored quotation and validate
// catalogue/tier/Apna/cutoff rules inside an atomic redemption transaction.
"use strict";
const {QuoteError} = require("./quote-crypto-v1");

const DOORS = new Set(["apna_order","community_order","dish_to_cart","budget_to_cart","bhao_tao"]);
const PROVENANCE = {
  apna_order:"apna_selection", community_order:"community_pack",
  dish_to_cart:"recipe", budget_to_cart:"budget_plan", bhao_tao:"bhao_offer"
};
const GID = /^gid:\/\/shopify\/ProductVariant\/[1-9][0-9]*$/;
const SHOPIFY_MUTATION = [
  "mutation AsbCreateCodOrder($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {",
  "  orderCreate(order: $order, options: $options) {",
  "    userErrors { field message }",
  "    order { id displayFinancialStatus currentTotalPriceSet { shopMoney { amount currencyCode } } }",
  "  }",
  "}"
].join("\n");

function requiredString(value, key) {
  if (typeof value !== "string" || !value.trim()) throw new QuoteError("MISSING_" + key);
  return value.trim();
}
function paisa(p, key) {
  if (!Number.isSafeInteger(p) || p < 0) throw new QuoteError("INVALID_" + key);
  return p;
}
function qty(n) {
  if (!Number.isSafeInteger(n) || n <= 0) throw new QuoteError("INVALID_QTY");
  return n;
}
function add(a,b) {
  if (!Number.isSafeInteger(a+b)) throw new QuoteError("MONEY_OVERFLOW");
  return a+b;
}
function money(p) {
  paisa(p,"PAISA");
  return Math.floor(p/100) + "." + String(p%100).padStart(2,"0");
}
function parseMoneyAsPaisa(amount) {
  if (typeof amount !== "string" || !/^[0-9]+(?:\.[0-9]{1,2})?$/.test(amount))
    throw new QuoteError("SHOPIFY_INVALID_MONEY");
  const [whole,dec=""]=amount.split(".");
  const total=BigInt(whole)*100n+BigInt(dec.padEnd(2,"0"));
  if(total>BigInt(Number.MAX_SAFE_INTEGER))throw new QuoteError("MONEY_OVERFLOW");
  return Number(total);
}
function moneyBag(p) {return {shopMoney:{amount:money(p),currencyCode:"PKR"}};}
function validCycle(quote){
  const cycle=requiredString(quote.cycleCode,"CYCLE");
  const date=requiredString(quote.deliveryDate,"DELIVERY_DATE");
  if(!/^\d{4}-\d{2}-\d{2}$/.test(date))throw new QuoteError("INVALID_DELIVERY_DATE");
  const [year,month,day]=date.split("-").map(Number);
  const utc=new Date(Date.UTC(year,month-1,day));
  if (utc.toISOString().slice(0,10)!==date) throw new QuoteError("INVALID_DELIVERY_DATE");
  const d=utc.getUTCDay();
  if((d!==1 && d!==4)||!cycle.startsWith(d===1?"MON-":"THU-"))
    throw new QuoteError("WRONG_DELIVERY_CYCLE");
  if (!cycle.endsWith(date)) throw new QuoteError("CYCLE_DATE_MISMATCH");
}
function normalizeAddress(customer) {
  if(!customer || customer.addressVerified !== true)
    throw new QuoteError("DELIVERY_ADDRESS_NOT_VERIFIED");
  const address=customer.shippingAddress;
  if(!address||address.countryCode!=="PK")throw new QuoteError("INVALID_SHIPPING_ADDRESS");
  const line=requiredString(address.address1,"ADDRESS1");
  if(!address.city || address.city.toLowerCase()!=="karachi")
    throw new QuoteError("INVALID_DELIVERY_CITY");
  const firstName=requiredString(customer.firstName,"FIRST_NAME");
  const lastName=typeof customer.lastName==="string"&&customer.lastName.trim()?customer.lastName.trim():"Customer";
  const rawPhone=requiredString(customer.phone,"CUSTOMER_PHONE");
  // ASB stores verified Pakistani numbers without +. Shopify's Admin API
  // expects a country-prefixed E.164 phone for an order/address.
  // Do NOT change the signed household identity or create a new phone number.
  const phone=/^\\+?92[0-9]{10}$/.test(rawPhone)?
    "+"+rawPhone.replace(/^\\+/,""):null;
  if(!phone)throw new QuoteError("INVALID_CUSTOMER_PHONE");
  const shipping={firstName,lastName,address1:line,city:"Karachi",countryCode:"PK",phone};
  if(address.address2)shipping.address2=String(address.address2);
  return {shipping,phone};
}
function packLabel(line) {
  const label=line.sellUnitLabel && typeof line.sellUnitLabel==="string" ? line.sellUnitLabel.trim() :
    String(line.qty) + (line.unit==="g"?" g":" piece");
  return label.slice(0,100);
}
function asbLineProperties(line,adjusted,credit) {
  const p=[
    ["_asb_line_id",line.lineId],["_asb_door",line.door],
    ["_asb_product",line.canonicalProductId],["_asb_measure",line.unit],
    ["_asb_qty",String(line.qty)],["_asb_line_ceiling_paisa",String(line.ceilingLinePaisa)],
    ["_asb_quote_line_paisa",String(line.quotedLinePaisa)],
    ["_asb_cash_credit_paisa",String(credit)]
  ];
  if(line.heroTier) {
    p.push(["_asb_hero_week",requiredString(line.heroTier.heroWeekId,"HERO_WEEK")]);
    p.push(["_asb_hero_tier",requiredString(line.heroTier.tierId,"HERO_TIER")]);
  }
  p.push(["_asb_provenance",JSON.stringify(line.provenance)]);
  return p.map(([name,value])=>({name,value}));
}
/**
 * A customer sees unrounded line prices and an explicit cash-rounding credit.
 * Shopify must have exactly the collectible COD total. Apply <Rs1 credit as
 * actual downward adjustment across line prices, preserving original price
 * and line ceiling in its properties for audit; never use a negative shipping
 * line or pretend a Shopify discount was applied.
 */
function buildOrderCreateInput({quote, customer, redemptionKey, taxesDisabledApproved=false} = {}) {
  if(!quote||typeof quote!=="object")throw new QuoteError("INVALID_QUOTE");
  if(taxesDisabledApproved!==true)throw new QuoteError("TAX_POLICY_NOT_VERIFIED");
  const quoteId=requiredString(quote.quoteId,"QUOTE_ID");
  const version=qty(quote.version);
  requiredString(quote.customerReference,"CUSTOMER_REF");
  requiredString(redemptionKey,"REDEMPTION_KEY");
  if(quote.currency!=="PKR")throw new QuoteError("WRONG_CURRENCY");
  validCycle(quote);
  if(!customer || quote.customerReference!==customer.householdKey)
    throw new QuoteError("HOUSEHOLD_MISMATCH");
  if(!Array.isArray(quote.lines)||quote.lines.length===0)
    throw new QuoteError("EMPTY_ORDER");
  const {shipping,phone}=normalizeAddress(customer);
  if (quote.paymentSecurityState && quote.paymentSecurityState!=="unsecured_cod")
    throw new QuoteError("PAYMENT_SECURITY_REQUIRES_RECONCILIATION");

  const lines=[],ids=new Set();
  let sum=0, ceilingSum=0;
  for(const item of quote.lines){
    const lineId=requiredString(item?.lineId,"LINE_ID");
    if(ids.has(lineId))throw new QuoteError("DUPLICATE_LINE_ID");
    ids.add(lineId);
    if(!DOORS.has(item.door))throw new QuoteError("UNRECOGNIZED_DOOR");
    if(item.merchandiseKind!==(item.door==="bhao_tao"?"non_grocery":"grocery"))
      throw new QuoteError("WRONG_DOOR_PRODUCT_TYPE");
    if(item.provenance?.kind!==PROVENANCE[item.door])
      throw new QuoteError("INVALID_PROVENANCE");
    if(item.door==="dish_to_cart" && (!Array.isArray(item.provenance.recipeIds) || !item.provenance.recipeIds.length))
      throw new QuoteError("RECIPE_PROVENANCE_REQUIRED");
    if(item.door==="budget_to_cart" && !item.provenance.planId)
      throw new QuoteError("BUDGET_PROVENANCE_REQUIRED");
    if(item.door==="bhao_tao" && !item.provenance.offerId)
      throw new QuoteError("BHAO_OFFER_REQUIRED");
    if(!GID.test(item.shopifyVariantGid||""))throw new QuoteError("MISSING_VARIANT_GID");
    requiredString(item.canonicalProductId,"CANON_PRODUCT");
    if(item.unit!=="g"&&item.unit!=="piece")throw new QuoteError("INVALID_UNIT");
    qty(item.qty);
    const price=paisa(item.quotedLinePaisa,"LINE_PRICE");
    const cap=paisa(item.ceilingLinePaisa,"LINE_CEILING");
    if(price>cap)throw new QuoteError("PRICE_EXCEEDS_LINE_CEILING");
    if(item.heroTier && !["community_order","dish_to_cart","budget_to_cart"].includes(item.door))
      throw new QuoteError("HERO_TIER_FORBIDDEN");
    if(item.heroTier && (!item.heroTier.heroWeekId || !item.heroTier.tierId))
      throw new QuoteError("HERO_TIER_INCOMPLETE");
    sum=add(sum,price);
    ceilingSum=add(ceilingSum,cap);
    lines.push(item);
  }
  if(sum!==paisa(quote.quotedTotalPaisa,"QUOTE_TOTAL") ||
    ceilingSum!==paisa(quote.ceilingTotalPaisa,"CEILING_TOTAL"))
    throw new QuoteError("QUOTE_SUM_MISMATCH");
  if(sum>ceilingSum)throw new QuoteError("QUOTE_ABOVE_CEILING");
  const codPaisa=Math.floor(sum/100)*100;
  if(codPaisa<=0)throw new QuoteError("ZERO_COD_PAYABLE");
  const roundingCreditPaisa=sum-codPaisa;

  const adjusted=lines.map(l=>l.quotedLinePaisa);
  let left=roundingCreditPaisa;
  for(let i=adjusted.length-1;i>=0&&left>0;i--){
    const delta=Math.min(adjusted[i],left);
    adjusted[i]-=delta;
    left-=delta;
  }
  if(left!==0)throw new QuoteError("ROUNDING_ALLOCATION_FAILED");
  let actual=0;
  const lineItems=lines.map((line,i)=>{
    const credit=line.quotedLinePaisa-adjusted[i];
    actual=add(actual,adjusted[i]);
    const title=requiredString(line.productName||line.canonicalProductId,"PRODUCT_NAME").slice(0,80)+
      " — "+packLabel(line)+" ("+line.door+")";
    const output={
      variantId:line.shopifyVariantGid,quantity:1,title,
      priceSet:moneyBag(adjusted[i]),taxable:false,requiresShipping:true,
      properties:asbLineProperties(line,adjusted[i],credit)
    };
    if(line.unit==="g") output.weight={value:line.qty/1000,unit:"KILOGRAMS"};
    return output;
  });
  if(actual!==codPaisa)throw new QuoteError("COD_TOTAL_MISMATCH");
  const attributes=[
    {key:"asb_quote_id",value:quoteId},{key:"asb_quote_version",value:String(version)},
    {key:"asb_redemption_key",value:redemptionKey},
    {key:"asb_cycle_code",value:quote.cycleCode},
    {key:"asb_delivery_date",value:quote.deliveryDate},
    {key:"asb_quote_subtotal_paisa",value:String(sum)},
    {key:"asb_cod_rounding_credit_paisa",value:String(roundingCreditPaisa)},
    {key:"asb_payment_method",value:"COD"},
  ];
  return {
    expectedCodPaisa:codPaisa, roundingCreditPaisa,
    quoteSubtotalPaisa:sum, quotedCeilingPaisa:ceilingSum,
    query:SHOPIFY_MUTATION,
    variables:{
      order:{
        currency:"PKR",phone,shippingAddress:shipping,
        lineItems,
        shippingLines:[{title:"ASB Free Delivery — Monday/Thursday",code:"ASB_FREE",priceSet:moneyBag(0)}],
        financialStatus:"PENDING",taxesIncluded:false,
        sourceIdentifier:redemptionKey,sourceName:"ASB Five Door",
        customAttributes:attributes,tags:["ASB-ADR002","ASB-COD","ASB-CYCLE-"+quote.cycleCode]
      },
      options:{inventoryBehaviour:"BYPASS",sendReceipt:false,sendFulfillmentReceipt:false}
    }
  };
}
module.exports={buildOrderCreateInput,money,parseMoneyAsPaisa,SHOPIFY_MUTATION};
