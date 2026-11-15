// ASB ADR-002: transaction-safe amendment proposal reservation, LAB ONLY.
// This module NEVER edits Shopify, activates policy, adjusts COD, issues a bill,
// replaces a signed quote or releases a reservation. No HTTP route is exposed.
"use strict";
const crypto=require("node:crypto");
const {QuoteError,canonical}=require("./quote-crypto-v1");
const {verifyAmendmentPreflight}=require("./apna-order-amendment-preflight-v1");

const SHOP="asb-checkout-lab.myshopify.com";
const KEY=/^asb-amendment-[a-f0-9]{40}$/;
function check(ok,code){if(!ok)throw new QuoteError(code);}
function string(x){return typeof x==="string"&&x.trim()?x.trim():null;}
function sha(x){return crypto.createHash("sha256").update(canonical(x),"utf8").digest("hex");}

function createPgApnaAmendmentReservation({
  pool,shopDomain,devDomainAllowlist=[],
  loadTrustedProposalInTransaction
}={}){
  check(pool&&typeof pool.connect==="function","AMENDMENT_DATABASE_REQUIRED");
  check(shopDomain===SHOP&&devDomainAllowlist.includes(SHOP),
    "AMENDMENT_LAB_ONLY");
  check(typeof loadTrustedProposalInTransaction==="function",
    "AMENDMENT_TRUSTED_PROPOSAL_ADAPTER_REQUIRED");

  async function reserve({originalQuoteId,proposalId,idempotencyKey,identity}={}){
    check(string(originalQuoteId)&&string(proposalId)&&KEY.test(idempotencyKey||""),
      "AMENDMENT_IDENTIFIERS_REQUIRED");
    check(identity?.serverAuthenticated===true&&identity?.phoneVerified===true&&
      string(identity.householdKey),"AMENDMENT_CUSTOMER_NOT_VERIFIED");

    const db=await pool.connect();
    let began=false;
    try{
      await db.query("BEGIN"); began=true;
      // Original claim is server-side, committed, and tied to the authenticated
      // household. Never trust an order ID, payment flag or quantity from POST.
      const record=(await db.query(
        `SELECT r.claim_id,r.quote_id,r.shop_domain,r.household_key,r.cycle_code,
                r.shopify_order_gid,r.state,q.delivery_date::text AS delivery_date
           FROM checkout_redemptions r
           JOIN checkout_quotes q ON q.quote_id=r.quote_id
          WHERE r.quote_id=$1 FOR UPDATE`,[originalQuoteId])).rows[0];
      check(record&&record.shop_domain===SHOP&&
        record.household_key===identity.householdKey&&
        record.state==="completed"&&string(record.shopify_order_gid),
        "AMENDMENT_ORIGINAL_CLAIM_NOT_ELIGIBLE");

      // Use the same household/cycle lock as initial claimQuote. This is crucial
      // for preventing racing amendment requests from passing independent caps.
      await db.query(
        `INSERT INTO checkout_household_cycle_locks
           (shop_domain,household_key,cycle_code)
         VALUES($1,$2,$3) ON CONFLICT DO NOTHING`,
        [SHOP,identity.householdKey,record.cycle_code]);
      await db.query(
        `SELECT household_key FROM checkout_household_cycle_locks
         WHERE shop_domain=$1 AND household_key=$2 AND cycle_code=$3 FOR UPDATE`,
        [SHOP,identity.householdKey,record.cycle_code]);

      const trusted=await loadTrustedProposalInTransaction({
        db,shopDomain:SHOP,originalQuoteId,proposalId,identity,
        originalClaim:record
      });
      check(trusted&&trusted.proposalId===proposalId&&
        trusted.originalOrder?.shopifyOrderGid===record.shopify_order_gid&&
        trusted.originalOrder?.orderId===originalQuoteId&&
        trusted.originalOrder?.cycleCode===record.cycle_code,
        "AMENDMENT_TRUSTED_PROPOSAL_MISMATCH");

      const snapshot={
        originalQuoteId,proposalId,originalClaimId:record.claim_id,
        originalLines:trusted.originalLines,proposedLines:trusted.proposedLines,
        policyVersion:trusted.policyVersion
      };
      check(string(trusted.policyVersion),"AMENDMENT_POLICY_VERSION_REQUIRED");
      const fingerprint=sha(snapshot);

      // Idempotency is only permitted for the EXACT same immutable request.
      // A conflicting key or replacement proposal is not an invitation to
      // silently mutate the reservation. Reconciliation is a separate phase.
      const prior=(await db.query(
        `SELECT reservation_id,idempotency_key,snapshot_sha256,
                additional_paisa,state
           FROM checkout_apna_amendment_reservations
          WHERE original_claim_id=$1 FOR UPDATE`,[record.claim_id])).rows[0];
      if(prior){
        check(prior.idempotency_key===idempotencyKey&&
          prior.snapshot_sha256===fingerprint,
          "AMENDMENT_ALREADY_RESERVED_DIFFERENT_PROPOSAL");
        await db.query("COMMIT");began=false;
        return {state:"reserved_preflight",reservationId:prior.reservation_id,
          additionalPaisa:Number(prior.additional_paisa),idempotent:true,
          shopifyModified:false,billModified:false};
      }

      const cycle=(await db.query(
        `SELECT code,status::text AS status,delivery_date::text AS delivery_date,
                opens_at,locks_at FROM cycles WHERE code=$1 FOR SHARE`,
        [record.cycle_code])).rows[0];
      const now=(await db.query("SELECT clock_timestamp() AS db_now")).rows[0].db_now;
      check(cycle&&cycle.status==="open"&&cycle.delivery_date===record.delivery_date&&
        now>=cycle.opens_at&&now<cycle.locks_at,
        "AMENDMENT_CYCLE_CLOSED");
      check(trusted.originalOrder.shopDomain===SHOP&&
        trusted.originalOrder.householdKey===identity.householdKey,
        "AMENDMENT_TRUSTED_ORDER_MISMATCH");

      const result=verifyAmendmentPreflight({
        shopDomain:SHOP,identity,
        cycle:{code:cycle.code,status:cycle.status,cutoffVerifiedByDatabase:true},
        originalOrder:trusted.originalOrder,originalLines:trusted.originalLines,
        proposedLines:trusted.proposedLines,
        existingCycleLines:trusted.existingCycleLines,
        limitsByProduct:trusted.limitsByProduct,
        sourceVerified:trusted.sourceVerified,
        historyVerified:trusted.historyVerified,
        policyVerified:trusted.policyVerified
      });

      const inserted=(await db.query(
        `INSERT INTO checkout_apna_amendment_reservations
          (shop_domain,household_key,cycle_code,original_claim_id,
           original_quote_id,shopify_order_gid,idempotency_key,
           snapshot_sha256,proposed_snapshot,additional_paisa)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10)
          RETURNING reservation_id,state`,
        [SHOP,identity.householdKey,record.cycle_code,record.claim_id,
          originalQuoteId,record.shopify_order_gid,idempotencyKey,
          fingerprint,JSON.stringify(snapshot),result.additionalPaisa])).rows[0];
      await db.query("COMMIT");began=false;
      return {state:inserted.state,reservationId:inserted.reservation_id,
        additionalPaisa:result.additionalPaisa,idempotent:false,
        shopifyModified:false,billModified:false};
    }catch(err){
      if(began)try{await db.query("ROLLBACK");}catch{}
      if(err?.code==="23505")throw new QuoteError("AMENDMENT_ALREADY_RESERVED");
      throw err;
    }finally{db.release();}
  }
  return {reserve};
}
module.exports={createPgApnaAmendmentReservation};
