// ASB ADR-002 Phase 4: durable single-attempt MOCK Shopify order-edit commit.
// STRICTLY LAB + MOCK ONLY. No real GraphQL transport or customer route exists.
// One reservation => at most one mock commit invocation, including lost replies.
// An uncertain result is settled ONLY by an independently read order snapshot.
"use strict";
const crypto=require("node:crypto");
const {QuoteError,canonical}=require("./quote-crypto-v1");
const {parseMoneyAsPaisa}=require("./ordercreate-v1");

const SHOP="asb-checkout-lab.myshopify.com";
const CALC=/^gid:\/\/shopify\/CalculatedOrder\/[1-9][0-9]*$/;
function chk(x,code){if(!x)throw new QuoteError(code);}
function sha(v){return crypto.createHash("sha256").update(canonical(v),"utf8").digest("hex");}
function validId(v){return typeof v==="string"&&v.trim().length>0;}
function positiveInt(v){return Number.isSafeInteger(v)&&v>0;}
function countAdditions(items){
  chk(Array.isArray(items)&&items.length>0&&items.length<=150,
    "AMENDMENT_MOCK_ADDITIONS_REQUIRED");
  const m=new Map();
  for(const a of items){
    chk(/^gid:\/\/shopify\/ProductVariant\/[1-9][0-9]*$/.test(a?.variantId||"")&&
      positiveInt(a.quantity),"AMENDMENT_MOCK_INVALID_VARIANT_COUNT");
    const n=(m.get(a.variantId)||0)+a.quantity;
    chk(Number.isSafeInteger(n)&&n>0,"AMENDMENT_MOCK_COUNT_OVERFLOW");
    m.set(a.variantId,n);
  }
  return [...m].map(([variantId,quantity])=>({variantId,quantity}))
    .sort((a,b)=>a.variantId.localeCompare(b.variantId));
}
function verifiedMockRead(row,read){
  if(!read || read.shopifyOrderGid!==row.shopify_order_gid||
     read.displayFinancialStatus!=="PENDING"||
     read.displayFulfillmentStatus!=="UNFULFILLED")return false;
  try{
    const p=read.currentTotalPriceSet?.shopMoney;
    const due=read.totalOutstandingSet?.shopMoney;
    if(p?.currencyCode!=="PKR"||due?.currencyCode!=="PKR"||
      parseMoneyAsPaisa(p.amount)!==Number(row.expected_total_paisa)||
      parseMoneyAsPaisa(due.amount)!==Number(row.expected_total_paisa))return false;
    return canonical(countAdditions(read.observedAdditions))===
      canonical(countAdditions(row.expected_additions));
  }catch{return false;}
}
function createPgMockShopifyEditCoordinator({
  pool,shopDomain,devDomainAllowlist=[],loadTrustedProofInTransaction,
  mockShopify
}={}){
  chk(pool&&typeof pool.connect==="function","AMENDMENT_MOCK_DB_REQUIRED");
  chk(shopDomain===SHOP&&devDomainAllowlist.includes(SHOP),"AMENDMENT_MOCK_LAB_ONLY");
  chk(typeof loadTrustedProofInTransaction==="function",
    "AMENDMENT_MOCK_TRUSTED_PROOF_REQUIRED");
  // Explicit identity guard: this object MUST be a fake and MUST NOT contain
  // a real Shopify API client; this implementation is not a live connector.
  chk(mockShopify?.__asbFakeTransport===true&&
    typeof mockShopify.commit==="function"&&
    typeof mockShopify.readOrder==="function",
    "AMENDMENT_MOCK_TRANSPORT_REQUIRED");

  async function transaction(fn){
    const db=await pool.connect();let started=false;
    try{
      await db.query("BEGIN");started=true;
      const out=await fn(db);
      await db.query("COMMIT");started=false;
      return out;
    }catch(e){
      if(started)try{await db.query("ROLLBACK");}catch{}
      throw e;
    }finally{db.release();}
  }
  async function getSource(db,id,locked=false){
    const sql=`SELECT a.reservation_id,a.shop_domain,a.household_key,a.cycle_code,
           a.shopify_order_gid,a.original_quote_id,a.snapshot_sha256,
           a.proposed_snapshot,a.additional_paisa,a.state AS reservation_state,
           r.state AS claim_state,r.expected_cod_paisa,s.state AS simulation_state,
           s.draft_bill_sha256,s.draft_json,s.expected_total_paisa,
           s.original_bill_sha256,
           c.status::text AS cycle_status,c.delivery_date::text AS delivery_date,
           c.opens_at,c.locks_at
      FROM checkout_apna_amendment_reservations a
      JOIN checkout_redemptions r ON r.claim_id=a.original_claim_id
      JOIN checkout_apna_amendment_bill_simulations s ON s.reservation_id=a.reservation_id
      JOIN cycles c ON c.code=a.cycle_code
      WHERE a.reservation_id=$1`+(locked?" FOR UPDATE OF a":"");
    return (await db.query(sql,[id])).rows[0];
  }
  function checkHousehold(row,identity){
    chk(row?.shop_domain===SHOP&&row.household_key===identity.householdKey&&
      row.claim_state==="completed"&&row.reservation_state==="reserved_preflight"&&
      row.simulation_state==="simulation_only",
      "AMENDMENT_MOCK_RESERVATION_NOT_ELIGIBLE");
    chk(sha(row.proposed_snapshot)===row.snapshot_sha256&&
      sha(row.draft_json)===row.draft_bill_sha256&&
      row.draft_json.state==="SIMULATION_DRAFT_NOT_SENT"&&
      row.draft_json.shopifyOrderGid===row.shopify_order_gid&&
      Number(row.expected_total_paisa)===row.draft_json.totalPaisa&&
      Number(row.expected_cod_paisa)+Number(row.additional_paisa)===
        Number(row.expected_total_paisa),
      "AMENDMENT_MOCK_SNAPSHOT_OR_MONEY_DRIFT");
  }
  function auth(identity,id){
    chk(validId(id)&&identity?.serverAuthenticated===true&&
      identity.phoneVerified===true&&validId(identity.householdKey),
      "AMENDMENT_MOCK_CUSTOMER_NOT_VERIFIED");
  }
  async function loadAttempt(db,reservationId){
    return (await db.query(
      "SELECT * FROM checkout_apna_edit_commit_attempts WHERE reservation_id=$1 FOR UPDATE",
      [reservationId])).rows[0];
  }
  async function prepare({reservationId,identity}={}){
    auth(identity,reservationId);
    return transaction(async db=>{
      // Read identity without a lock, then acquire the shared cycle lock in
      // the same order used by claimQuote before locking the proposal.
      const initial=await getSource(db,reservationId);
      chk(initial?.household_key===identity.householdKey,
        "AMENDMENT_MOCK_RESERVATION_NOT_ELIGIBLE");
      await db.query(`INSERT INTO checkout_household_cycle_locks
        (shop_domain,household_key,cycle_code) VALUES($1,$2,$3)
        ON CONFLICT DO NOTHING`,[SHOP,identity.householdKey,initial.cycle_code]);
      await db.query(`SELECT household_key FROM checkout_household_cycle_locks
        WHERE shop_domain=$1 AND household_key=$2 AND cycle_code=$3 FOR UPDATE`,
        [SHOP,identity.householdKey,initial.cycle_code]);
      const row=await getSource(db,reservationId,true);
      checkHousehold(row,identity);
      const prior=await loadAttempt(db,reservationId);
      if(prior){
        return {fresh:false,state:prior.state,attemptId:prior.attempt_id,
          reservationId,shopifyOrderGid:prior.shopify_order_gid,
          recoveryOnly:true};
      }
      const clock=(await db.query("SELECT clock_timestamp() AS now")).rows[0].now;
      chk(row.cycle_status==="open"&&clock>=row.opens_at&&clock<row.locks_at,
        "AMENDMENT_MOCK_CYCLE_CLOSED");

      const proof=await loadTrustedProofInTransaction({
        db,reservationId,identity,source:row
      });
      const plan=proof?.plan,preview=proof?.preview;
      chk(proof?.mockOnly===true&&proof.sourceVerified===true&&
        plan?.mode==="SIMULATION_ONLY_NOT_AUTHORIZED"&&
        preview?.state==="precommit_preview_matches_not_committed"&&
        CALC.test(preview.calculatedOrderId||"")&&
        preview.expectedTotalPaisa===plan.expectedFinalPaisa&&
        plan.reservationId===reservationId&&
        plan.shopifyOrderGid===row.shopify_order_gid&&
        plan.expectedFinalPaisa===Number(row.expected_total_paisa)&&
        plan.additionalPaisa===Number(row.additional_paisa)&&
        plan.previousBillDigest===row.original_bill_sha256,
        "AMENDMENT_MOCK_PROOF_NOT_VERIFIED");
      const additions=countAdditions(plan.additions);
      const fingerprint=sha({reservationId,calculatedOrderId:preview.calculatedOrderId,
        additions,expectedTotalPaisa:plan.expectedFinalPaisa,
        draftBillSha256:row.draft_bill_sha256});
      const key="asb-edit-"+fingerprint.slice(0,40);
      const intent=(await db.query(
        `INSERT INTO checkout_apna_edit_commit_attempts
          (reservation_id,shop_domain,household_key,shopify_order_gid,
           calculated_order_gid,intent_key,proof_sha256,expected_additions,
           source_bill_sha256,expected_total_paisa)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9,$10)
         RETURNING attempt_id,state`,
        [reservationId,SHOP,identity.householdKey,row.shopify_order_gid,
          preview.calculatedOrderId,key,fingerprint,JSON.stringify(additions),
          row.draft_bill_sha256,plan.expectedFinalPaisa])).rows[0];
      await db.query(`INSERT INTO checkout_apna_edit_attempt_audit
        (attempt_id,action,evidence_json)
        VALUES($1,'MOCK_INTENT_RECORDED',$2::jsonb)`,[
          intent.attempt_id,JSON.stringify({mockOnly:true,intentKey:key})]);
      // THIS COMMIT IS THE NO-RETRY BARRIER. No Shopify/mock callback is
      // invoked until the transaction has durably committed.
      return {fresh:true,state:intent.state,attemptId:intent.attempt_id,
        reservationId,shopifyOrderGid:row.shopify_order_gid,
        calculatedOrderId:preview.calculatedOrderId,intentKey:key,
        recoveryOnly:false};
    });
  }
  async function settle({reservationId,identity,mockRead,reason}){
    return transaction(async db=>{
      const row=await getSource(db,reservationId);
      chk(row?.household_key===identity.householdKey,
        "AMENDMENT_MOCK_RESERVATION_NOT_ELIGIBLE");
      const attempt=await loadAttempt(db,reservationId);
      chk(attempt,"AMENDMENT_MOCK_INTENT_MISSING");
      if(attempt.state==="verified_simulation")
        return {state:"verified_simulation",attemptId:attempt.attempt_id,alreadySettled:true};
      const isVerified=verifiedMockRead(attempt,mockRead);
      const next=isVerified?"verified_simulation":"needs_reconcile";
      if(attempt.state!==next){
        const sanitized={mockOnly:true,
          evidenceType:isVerified?"mock_order_read_verified":"mock_order_read_inconclusive",
          reasonCode:reason||"MOCK_UNCERTAIN"};
        await db.query(`UPDATE checkout_apna_edit_commit_attempts
          SET state=$2,evidence_json=$3::jsonb,
              reconciled_at=CASE WHEN $2='verified_simulation' THEN clock_timestamp()
                                 ELSE NULL END,updated_at=clock_timestamp()
          WHERE attempt_id=$1`,[
            attempt.attempt_id,next,JSON.stringify(sanitized)]);
        await db.query(`INSERT INTO checkout_apna_edit_attempt_audit
          (attempt_id,action,evidence_json)
          VALUES($1,$2,$3::jsonb)`,[
            attempt.attempt_id,isVerified?"MOCK_READ_VERIFIED":"MOCK_RESULT_UNCERTAIN",
            JSON.stringify(sanitized)]);
      }
      return {state:next,attemptId:attempt.attempt_id,alreadySettled:false,
        shopifyModified:false,billSent:false};
    });
  }
  async function recoverByMockRead({reservationId,identity}={}){
    auth(identity,reservationId);
    // Read only: this NEVER dispatches commit again, even after a process crash.
    const data=await transaction(async db=>{
      const row=await getSource(db,reservationId);
      chk(row?.household_key===identity.householdKey,
        "AMENDMENT_MOCK_RESERVATION_NOT_ELIGIBLE");
      const intent=await loadAttempt(db,reservationId);
      chk(intent,"AMENDMENT_MOCK_INTENT_MISSING");
      return {alreadyVerified:intent.state==="verified_simulation",
        shopifyOrderGid:intent.shopify_order_gid};
    });
    if(data.alreadyVerified)return {state:"verified_simulation",alreadySettled:true};
    let read=null;
    try{read=await mockShopify.readOrder({shopifyOrderGid:data.shopifyOrderGid});}
    catch{ /* Unknown Shopify state is NOT proof of safe retry. */ }
    return settle({reservationId,identity,mockRead:read,
      reason:read?"MOCK_READ_INCONCLUSIVE":"MOCK_READ_UNAVAILABLE"});
  }
  async function runMockOnce({reservationId,identity}={}){
    const claim=await prepare({reservationId,identity});
    if(!claim.fresh)return {state:claim.state,attemptId:claim.attemptId,
      commitDispatched:false,recoveryOnly:true,shopifyModified:false,billSent:false};
    let outcome;
    try{
      outcome=await mockShopify.commit({calculatedOrderId:claim.calculatedOrderId,
        intentKey:claim.intentKey,shopifyOrderGid:claim.shopifyOrderGid,
        notifyCustomer:false,mockOnly:true});
    }catch{
      // Lost transport response: the external side may have committed.
      outcome=null;
    }
    // Even a success-looking mock mutation is NOT trusted without an
    // independent read of expected total AND exact added variant quantities.
    const settlement=await recoverByMockRead({reservationId,identity});
    return {...settlement,commitDispatched:true,
      mockReplyPresent:Boolean(outcome),shopifyModified:false,billSent:false};
  }
  return {runMockOnce,recoverByMockRead};
}
module.exports={createPgMockShopifyEditCoordinator};
