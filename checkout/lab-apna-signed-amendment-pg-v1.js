// ASB lab-only immutable SIGNED amendment authorisation.
// This is NOT customer consent, not a Shopify commit, not a bill and not
// a permission to bypass the (held) 026-028 reservation/commit coordinator.
"use strict";
const crypto=require("node:crypto");
const {QuoteError,canonical,signQuote,verifySignedQuote}=
  require("./quote-crypto-v1");
const {verifyAmendmentPreflight}=require("./apna-order-amendment-preflight-v1");
const {parseMoneyAsPaisa}=require("./ordercreate-v1");
const fixture=require("./fixtures/asb-checkout-lab.json");
const SHOP="asb-checkout-lab.myshopify.com";
const ORDER="gid://shopify/Order/19011998580770";
const QUOTE="ASB-LAB-APNA-ONION-500-MON-2026-11-16";
const CYCLE="MON-2026-11-16";
const CANONICAL="ASB-CANON-ONION";
const ONEKG=fixture.products[0].variants[1];
const FIRST=fixture.products[0].variants[0];
const VERSION="ASB_LAB_SYNTHETIC_AUTH_ONLY_V1";

function deny(ok,code){if(!ok)throw new QuoteError(code);}
function sha(v){return crypto.createHash("sha256").update(canonical(v),"utf8").digest("hex");}
function sumPaisa(lines){return lines.reduce((acc,line)=>{
  deny(Number.isSafeInteger(line.quotedLinePaisa)&&line.quotedLinePaisa>=0&&
    Number.isSafeInteger(acc+line.quotedLinePaisa),"LAB_AMENDMENT_MONEY_INVALID");
  return acc+line.quotedLinePaisa;
},0);}
function verifyOrder(order){
  deny(order?.id===ORDER&&order.test===true&&
    order.currencyCode==="PKR"&&order.displayFinancialStatus==="PENDING"&&
    order.displayFulfillmentStatus==="UNFULFILLED"&&
    Array.isArray(order.tags)&&["ASB-LAB-ONLY","NEVER-FULFILL",
      "ASB-ADR002","ASB-APNA-AMENDMENT-TARGET","ASB-CYCLE-"+CYCLE]
      .every(t=>order.tags.includes(t)),"LAB_AMENDMENT_SHOPIFY_NOT_ELIGIBLE");
  const original=order.lineItems?.nodes;
  deny(Array.isArray(original)&&original.length===1&&
    order.lineItems.pageInfo?.hasNextPage===false&&
    original[0].variant?.id===FIRST.gid&&
    original[0].quantity===1&&original[0].unfulfilledQuantity===1,
    "LAB_AMENDMENT_SHOPIFY_ITEMS_MISMATCH");
  const attrs=new Map((original[0].customAttributes||[]).map(a=>[a.key,a.value]));
  deny(attrs.get("_asb_door")==="apna_order"&&
    attrs.get("_asb_product")===CANONICAL&&
    attrs.get("_asb_qty")==="500"&&attrs.get("_asb_line_id")==="LAB-APNA-ONION-500",
    "LAB_AMENDMENT_SHOPIFY_PROVENANCE_MISSING");
  const total=order.currentTotalPriceSet?.shopMoney;
  const due=order.totalOutstandingSet?.shopMoney;
  deny(total?.currencyCode==="PKR"&&due?.currencyCode==="PKR"&&
    parseMoneyAsPaisa(total.amount)===4500&&
    parseMoneyAsPaisa(due.amount)===4500,
    "LAB_AMENDMENT_SHOPIFY_AMOUNT_MISMATCH");
}
function verifyCatalog(products){
  const p=Array.isArray(products)?products[0]:null;
  deny(p?.id===fixture.products[0].productGid&&p.status==="DRAFT"&&
    p.variants?.pageInfo?.hasNextPage===false&&
    Array.isArray(p.variants?.nodes),"LAB_AMENDMENT_CATALOG_NOT_VERIFIED");
  const v=p.variants.nodes.find(x=>x.id===ONEKG.gid);
  deny(v?.sku===ONEKG.sku&&
    /^(?:90)(?:\.0{1,2})?$/.test(String(v?.price))&&
    ONEKG.quantityGrams===1000&&ONEKG.pricePaisa===9000,
    "LAB_AMENDMENT_VARIANT_PRICE_CHANGED");
}
function verifyOriginalQuote(quote,secret){
  deny(verifySignedQuote(quote,secret)&&
    quote.quoteId===QUOTE&&quote.version===1&&
    quote.cycleCode===CYCLE&&quote.deliveryDate==="2026-11-16"&&
    quote.currency==="PKR"&&quote.paymentSecurityState==="unsecured_cod"&&
    quote.quotedTotalPaisa===4500&&quote.ceilingTotalPaisa===4500&&
    quote.communityEligibilityByDoor?.community_order?.eligible===false&&
    Array.isArray(quote.lines)&&quote.lines.length===1,
    "LAB_AMENDMENT_ORIGINAL_SIGNATURE_OR_QUOTE_INVALID");
  const line=quote.lines[0];
  deny(line.lineId==="LAB-APNA-ONION-500"&&
    line.canonicalProductId===CANONICAL&&line.shopifyVariantGid===FIRST.gid&&
    line.door==="apna_order"&&line.unit==="g"&&line.qty===500&&
    line.quotedLinePaisa===4500&&line.ceilingLinePaisa===4500&&
    line.provenance?.kind==="apna_selection",
    "LAB_AMENDMENT_ORIGINAL_LINE_INVALID");
}
function makeSignedSyntheticPacket({originalQuote,order,secret}){
  verifyOriginalQuote(originalQuote,secret);
  verifyOrder(order);
  const added={lineId:"LAB-APNA-ONION-1KG-ADDITION",
    door:"apna_order",shopifyVariantGid:ONEKG.gid,
    canonicalProductId:CANONICAL,sku:ONEKG.sku,
    productName:"LAB ONLY Apna Onion",merchandiseKind:"grocery",
    unit:"g",qty:1000,sellUnitLabel:"1 kg",
    provenance:{kind:"apna_selection"},
    quotedLinePaisa:9000,ceilingLinePaisa:9000};
  const proposed=[originalQuote.lines[0],added];
  deny(sumPaisa(proposed)===13500,"LAB_AMENDMENT_SUM_INVALID");
  return signQuote({
    schemaVersion:VERSION,consentMode:"SYNTHETIC_OPERATOR_LAB_ONLY",
    realCustomerConsent:false,
    shopDomain:SHOP,originalQuoteId:QUOTE,
    originalQuoteVersion:1,originalQuoteSignature:originalQuote.serverSignature,
    shopifyOrderGid:ORDER,
    householdKey:originalQuote.customerReference,
    cycleCode:CYCLE,deliveryDate:"2026-11-16",
    policyVersion:"LAB_TEST_RULES_NOT_FOUNDER_APPROVED",
    originalLines:originalQuote.lines,proposedLines:proposed,
    limit:{canonicalProductId:CANONICAL,minGrams:500,
      maxHouseholdCycleGrams:2000,allowedPackGrams:[500,1000]},
    originalTotalPaisa:4500,additionalPaisa:9000,proposedTotalPaisa:13500,
    customerNotificationApproved:false
  },secret);
}
function createPgLabSignedAmendmentJournal({
  pool,shopDomain,devDomainAllowlist=[],shopifyClient,quoteSecret
}={}){
  deny(shopDomain===SHOP&&devDomainAllowlist.includes(SHOP),
    "LAB_AMENDMENT_WRONG_STORE");
  deny(pool&&typeof pool.connect==="function"&&
    shopifyClient&&typeof shopifyClient.checkShop==="function"&&
    typeof shopifyClient.readGrantedScopesForLab==="function"&&
    typeof shopifyClient.readLabOrderForAmendment==="function"&&
    typeof shopifyClient.readProductsForPolicy==="function",
    "LAB_AMENDMENT_REQUIRED_SERVER_ADAPTER_MISSING");
  deny(typeof quoteSecret==="string"&&Buffer.byteLength(quoteSecret,"utf8")>=32,
    "LAB_AMENDMENT_SECRET_REQUIRED");
  async function authorizeReadVerifiedSynthetic(){
    await shopifyClient.checkShop();
    const granted=await shopifyClient.readGrantedScopesForLab();
    deny(granted.shopDomain===SHOP&&granted.ready===true,
      "LAB_AMENDMENT_APP_SCOPES_NOT_VERIFIED");
    const [order,products]=await Promise.all([
      shopifyClient.readLabOrderForAmendment({orderGid:ORDER}),
      shopifyClient.readProductsForPolicy({productGids:[fixture.products[0].productGid]})
    ]);
    verifyOrder(order);verifyCatalog(products);
    const db=await pool.connect();
    let began=false;
    try{
      await db.query("BEGIN");began=true;
      const initial=(await db.query(
        "SELECT r.claim_id,r.household_key,r.cycle_code"+
        " FROM checkout_redemptions r WHERE r.quote_id=$1",
        [QUOTE])).rows[0];
      deny(initial&&initial.cycle_code===CYCLE&&
        typeof initial.household_key==="string"&&initial.household_key.startsWith(
          "ASB-LAB-APNA-AMENDMENT-HH-MON-2026-11-16"),
        "LAB_AMENDMENT_ORIGINAL_CLAIM_MISSING");
      // Existing order redemption uses exactly this household-cycle lock.
      await db.query(
        "INSERT INTO checkout_household_cycle_locks(shop_domain,household_key,cycle_code)"+
        " VALUES($1,$2,$3) ON CONFLICT DO NOTHING",[SHOP,initial.household_key,CYCLE]);
      await db.query(
        "SELECT household_key FROM checkout_household_cycle_locks"+
        " WHERE shop_domain=$1 AND household_key=$2 AND cycle_code=$3 FOR UPDATE",
        [SHOP,initial.household_key,CYCLE]);

      const source=(await db.query(
        "SELECT r.claim_id,r.shop_domain,r.household_key,r.cycle_code,"+
        " r.shopify_order_gid,r.expected_cod_paisa,r.state AS claim_state,"+
        " q.version,q.signed_quote,q.state AS quote_state,q.delivery_date::text AS delivery_date"+
        " FROM checkout_redemptions r JOIN checkout_quotes q ON q.quote_id=r.quote_id"+
        " WHERE r.quote_id=$1 FOR UPDATE OF r",[QUOTE])).rows[0];
      deny(source&&source.claim_id===initial.claim_id&&
        source.shop_domain===SHOP&&source.household_key===initial.household_key&&
        source.cycle_code===CYCLE&&source.shopify_order_gid===ORDER&&
        source.claim_state==="completed"&&
        Number(source.expected_cod_paisa)===4500&&source.version===1&&
        source.quote_state==="active"&&source.delivery_date==="2026-11-16",
        "LAB_AMENDMENT_ORIGINAL_CLAIM_MISMATCH");
      verifyOriginalQuote(source.signed_quote,quoteSecret);
      deny(source.signed_quote.customerReference===source.household_key,
        "LAB_AMENDMENT_ORIGINAL_IDENTITY_MISMATCH");

      const cycle=(await db.query(
        "SELECT code,status::text,delivery_date::text AS date,opens_at,locks_at"+
        " FROM cycles WHERE code=$1 FOR SHARE",[CYCLE])).rows[0];
      const now=(await db.query("SELECT clock_timestamp() AS at")).rows[0].at;
      deny(cycle&&cycle.status==="open"&&cycle.date==="2026-11-16"&&
        now>=cycle.opens_at&&now<cycle.locks_at,
        "LAB_AMENDMENT_CYCLE_CLOSED");

      const packet=makeSignedSyntheticPacket({
        originalQuote:source.signed_quote,order,secret:quoteSecret
      });
      deny(verifySignedQuote(packet,quoteSecret)&&
        packet.householdKey===source.household_key,
        "LAB_AMENDMENT_SIGNATURE_FAILED");
      // Entire 500g + 1kg replacement is validated under the PG cycle lock.
      const policy=verifyAmendmentPreflight({
        shopDomain:SHOP,
        identity:{householdKey:source.household_key,
          serverAuthenticated:true,phoneVerified:true},
        cycle:{code:CYCLE,status:cycle.status,cutoffVerifiedByDatabase:true},
        originalOrder:{shopDomain:SHOP,householdKey:source.household_key,
          cycleCode:CYCLE,orderId:QUOTE,shopifyOrderGid:ORDER,
          redemptionState:"completed",fulfillmentState:"confirmed",
          paymentState:"pending_cod"},
        originalLines:packet.originalLines,proposedLines:packet.proposedLines,
        existingCycleLines:[],limitsByProduct:{
          [CANONICAL]:{unit:"g",minQuantity:500,maxQuantity:2000,
            allowedSizes:[500,1000]}
        },
        sourceVerified:true,policyVerified:true,historyVerified:true
      });
      deny(policy.proposedTotalPaisa===13500&&policy.additionalPaisa===9000&&
        policy.quantityResults.products[0].totalQuantity===1500,
        "LAB_AMENDMENT_QUANTITY_OR_MONEY_CHANGED");

      const digest=sha(packet);
      const prior=(await db.query(
        "SELECT authorization_id,payload_sha256 FROM checkout_lab_apna_signed_amendments"+
        " WHERE original_claim_id=$1 FOR UPDATE",[source.claim_id])).rows[0];
      if(prior){
        deny(prior.payload_sha256===digest,"LAB_AMENDMENT_DIFFERENT_PROPOSAL_EXISTS");
        await db.query("COMMIT");began=false;
        return {state:"synthetic_authorized_uncommitted",
          idempotent:true,authorizationId:prior.authorization_id,
          proposedTotalPaisa:13500,shopifyModified:false,billSent:false};
      }
      const row=(await db.query(
        "INSERT INTO checkout_lab_apna_signed_amendments("+
        " original_claim_id,original_quote_id,shop_domain,household_key,cycle_code,"+
        " shopify_order_gid,signed_amendment,payload_sha256)"+
        " VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING authorization_id",
        [source.claim_id,QUOTE,SHOP,source.household_key,CYCLE,ORDER,
          JSON.stringify(packet),digest])).rows[0];
      await db.query("COMMIT");began=false;
      return {state:"synthetic_authorized_uncommitted",
        authorizationId:row.authorization_id,idempotent:false,
        proposedTotalPaisa:13500,shopifyModified:false,billSent:false};
    }catch(e){
      if(began)try{await db.query("ROLLBACK");}catch{}
      if(e?.code==="23505")throw new QuoteError("LAB_AMENDMENT_ALREADY_AUTHORIZED");
      throw e;
    }finally{db.release();}
  }
  return {authorizeReadVerifiedSynthetic};
}
module.exports={createPgLabSignedAmendmentJournal,
  makeSignedSyntheticPacket,verifyOriginalQuote,verifyOrder,verifyCatalog,
  SHOP,ORDER,QUOTE,CYCLE};
