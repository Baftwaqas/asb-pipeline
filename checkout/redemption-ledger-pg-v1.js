// ASB ADR-002: real PostgreSQL quote reservation for a DEV isolated shop.
// This DOES NOT issue quotes, authorize policy, authenticate customers, call
// Shopify or expose a route. All those boundaries fail CLOSED until connected.
"use strict";
const {QuoteError,canonical} = require("./quote-crypto-v1");

const GID = /^gid:\/\/shopify\/Order\/[1-9][0-9]*$/;
const DEV_DOMAIN = /^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
function required(value,name) {
  if(typeof value!=="string"||!value.trim()) throw new QuoteError("MISSING_"+name);
  return value.trim();
}
function safePaisa(n) {
  if(!Number.isSafeInteger(n)||n<0)throw new QuoteError("INVALID_EXPECTED_COD");
  return n;
}
async function transactional(pool, fn) {
  const db=await pool.connect();
  let begun=false;
  try {
    await db.query("BEGIN");
    begun=true;
    const result=await fn(db);
    await db.query("COMMIT");
    begun=false;
    return result;
  } catch(err) {
    if(begun)try{await db.query("ROLLBACK");}catch{ /* original error is authoritative */ }
    if(err?.code==="23505")throw new QuoteError("CHECKOUT_ALREADY_RESERVED");
    throw err;
  } finally {db.release();}
}

/**
 * verifyPolicyInTransaction is MANDATORY, NEVER a permissive default. It MUST
 * re-evaluate the exact server-signed quote against locked stock/price/pack
 * policy and household-cycle quantity history; {approved:true,policyVersion}.
 * The supplied callback is trusted server code, NOT request data.
 *
 * One household/cycle admits one Shopify COD commitment until full bag-edit
 * semantics are implemented. Unknown network outcome remains reserved.
 */
function createPgRedemptionLedger({
  pool,shopDomain,devDomainAllowlist=[],verifyPolicyInTransaction
}={}) {
  if(!pool||typeof pool.connect!=="function")throw new QuoteError("POSTGRES_POOL_REQUIRED");
  if(!DEV_DOMAIN.test(shopDomain||"")||
      !Array.isArray(devDomainAllowlist)||!devDomainAllowlist.includes(shopDomain))
    throw new QuoteError("DEV_STORE_NOT_EXPLICITLY_ALLOWLISTED");
  if(typeof verifyPolicyInTransaction!=="function")
    throw new QuoteError("AUTHORITATIVE_POLICY_VERIFIER_REQUIRED");

  async function claimQuote({quote,identity,redemptionKey}={}) {
    const quoteId=required(quote?.quoteId,"QUOTE_ID");
    const hh=required(identity?.householdKey,"HOUSEHOLD_KEY");
    const key=required(redemptionKey,"REDEMPTION_KEY");
    if(identity?.serverAuthenticated!==true||identity?.phoneVerified!==true||
       quote.customerReference!==hh) throw new QuoteError("CUSTOMER_NOT_AUTHENTICATED");
    if(!Number.isSafeInteger(quote.version)||quote.version<1)throw new QuoteError("INVALID_QUOTE_VERSION");
    if(!/^asb-adr002-[a-f0-9]{40}$/.test(key))throw new QuoteError("INVALID_REDEMPTION_KEY");

    return transactional(pool,async(db)=>{
      const qr=(await db.query(
        `SELECT quote_id,version,shop_domain,household_key,cycle_code,delivery_date::text AS delivery_day,
                issued_at,expires_at,signed_quote,state
           FROM checkout_quotes WHERE quote_id=$1 FOR UPDATE`,[quoteId])).rows[0];
      if(!qr||qr.state!=="active"||qr.shop_domain!==shopDomain||qr.version!==quote.version||
         qr.household_key!==hh||qr.cycle_code!==quote.cycleCode||
         qr.delivery_day!==quote.deliveryDate||canonical(qr.signed_quote)!==canonical(quote))
        throw new QuoteError("STORED_SIGNED_QUOTE_MISMATCH");

      // A previously completed claim must resolve to its original order, even
      // after cutoff; it cannot be re-created or rewritten.
      const prior=(await db.query(
        `SELECT claim_id,quote_version,shop_domain,household_key,redemption_key,state,shopify_order_gid
           FROM checkout_redemptions WHERE quote_id=$1 FOR UPDATE`,[quoteId])).rows[0];
      if(prior){
        if(prior.quote_version!==quote.version||prior.shop_domain!==shopDomain||
           prior.household_key!==hh||prior.redemption_key!==key)
          throw new QuoteError("QUOTE_CHAIN_VERSION_CONFLICT");
        return {state:prior.state,claimId:prior.claim_id,shopifyOrderGid:prior.shopify_order_gid};
      }

      // All new claims must pass the DATABASE clock and the currently-open
      // cycle under row locks. Browser time and signed quote cannot extend it.
      const dbNow=(await db.query("SELECT clock_timestamp() AS db_now")).rows[0].db_now;
      if(!(dbNow>=qr.issued_at&&dbNow<qr.expires_at))
        throw new QuoteError("QUOTE_NOT_IN_LIVE_WINDOW");
      const cycle=(await db.query(
        `SELECT code,delivery_date::text AS delivery_day,status::text AS status,
                opens_at,locks_at FROM cycles WHERE code=$1 FOR SHARE`,[quote.cycleCode])).rows[0];
      if(!cycle||cycle.status!=="open"||cycle.delivery_day!==quote.deliveryDate||
         !(dbNow>=cycle.opens_at && dbNow<cycle.locks_at))
        throw new QuoteError("DELIVERY_CYCLE_NOT_OPEN");

      // Serialize *every* quote for this household and delivery cycle before
      // policy check. Independent quotes cannot race past the same cap.
      await db.query(
        `INSERT INTO checkout_household_cycle_locks(shop_domain,household_key,cycle_code)
            VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,[shopDomain,hh,quote.cycleCode]);
      await db.query(
        `SELECT household_key FROM checkout_household_cycle_locks
          WHERE shop_domain=$1 AND household_key=$2 AND cycle_code=$3 FOR UPDATE`,
        [shopDomain,hh,quote.cycleCode]);

      const approved=await verifyPolicyInTransaction({
        db,quote,identity,shopDomain,cycle,householdKey:hh,dbNow
      });
      if(approved?.approved!==true || typeof approved.policyVersion!=="string"||
         !approved.policyVersion.trim())
        throw new QuoteError("SERVER_POLICY_NOT_APPROVED");

      const row=(await db.query(
        `INSERT INTO checkout_redemptions
          (quote_id,quote_version,shop_domain,household_key,cycle_code,
           redemption_key,state,policy_version)
         VALUES ($1,$2,$3,$4,$5,$6,'creating',$7) RETURNING claim_id`,
        [quoteId,quote.version,shopDomain,hh,quote.cycleCode,key,approved.policyVersion]
      )).rows[0];
      return {state:"claimed",claimId:row.claim_id};
    });
  }

  async function completeQuote({claimId,shopifyOrderGid,redemptionKey,expectedCodPaisa}={}){
    const claim=required(claimId,"CLAIM_ID");
    const order=required(shopifyOrderGid,"ORDER_GID");
    const key=required(redemptionKey,"REDEMPTION_KEY");
    const amount=safePaisa(expectedCodPaisa);
    if(!GID.test(order))throw new QuoteError("INVALID_ORDER_GID");
    return transactional(pool,async(db)=>{
      const r=(await db.query(
        `SELECT claim_id,shop_domain,redemption_key,state,shopify_order_gid,expected_cod_paisa
           FROM checkout_redemptions WHERE claim_id=$1 FOR UPDATE`,[claim])).rows[0];
      if(!r||r.shop_domain!==shopDomain||r.redemption_key!==key)
        throw new QuoteError("UNKNOWN_REDEMPTION");
      if(r.state==="completed"){
        if(r.shopify_order_gid!==order||Number(r.expected_cod_paisa)!==amount)
          throw new QuoteError("COMPLETION_CONFLICT");
        return {state:"completed",shopifyOrderGid:order};
      }
      if(r.state!=="creating")throw new QuoteError("RECONCILIATION_REQUIRED");
      await db.query(
        `UPDATE checkout_redemptions SET state='completed',shopify_order_gid=$2,
             expected_cod_paisa=$3,completed_at=clock_timestamp(),updated_at=clock_timestamp()
           WHERE claim_id=$1`,[claim,order,amount]);
      return {state:"completed",shopifyOrderGid:order};
    });
  }

  async function needsReconcile({claimId,reason,shopifyOrderGid=null}={}){
    const claim=required(claimId,"CLAIM_ID");
    const why=required(reason,"RECONCILE_REASON").slice(0,200);
    if(shopifyOrderGid!=null&&!GID.test(shopifyOrderGid))
      throw new QuoteError("INVALID_ORDER_GID");
    return transactional(pool,async(db)=>{
      const r=(await db.query(
        `SELECT state,shop_domain,shopify_order_gid FROM checkout_redemptions
          WHERE claim_id=$1 FOR UPDATE`,[claim])).rows[0];
      if(!r||r.shop_domain!==shopDomain)throw new QuoteError("UNKNOWN_REDEMPTION");
      if(r.state==="completed")throw new QuoteError("ALREADY_COMPLETED");
      if(r.shopify_order_gid && shopifyOrderGid && r.shopify_order_gid!==shopifyOrderGid)
        throw new QuoteError("RECONCILIATION_ORDER_CONFLICT");
      await db.query(
        `UPDATE checkout_redemptions
           SET state='needs_reconcile',shopify_order_gid=COALESCE(shopify_order_gid,$2),
             reconcile_reason=$3,updated_at=clock_timestamp()
          WHERE claim_id=$1`,[claim,shopifyOrderGid,why]);
      return {state:"needs_reconcile"};
    });
  }
  return {claimQuote,completeQuote,needsReconcile};
}
module.exports={createPgRedemptionLedger};
