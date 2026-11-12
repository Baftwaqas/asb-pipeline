// ASB LAB ONLY: durable, at-most-once REAL Shopify orderEditCommit coordinator.
// NO HTTP endpoint, NO Render startup invocation, NO migration release.
// Intent is committed in PostgreSQL BEFORE even one external commit request.
// Unknown responses never authorize a second commit. Recovery uses Shopify
// read-only state and creates UNISSUED bill versions, never a customer message.
"use strict";
const crypto=require("node:crypto");
const {QuoteError,canonical,verifySignedQuote}=require("./quote-crypto-v1");
const {verifyOriginalQuote,verifyOrder,SHOP,ORDER,QUOTE,CYCLE}=
  require("./lab-apna-signed-amendment-pg-v1");
const {postCommitEvidence,syntheticUnsentBillVersions}=
  require("./lab-apna-postcommit-verifier-v1");
function fail(ok,code){if(!ok)throw new QuoteError(code);}
function sha(v){return crypto.createHash("sha256").update(canonical(v),"utf8").digest("hex");}
const GID=/^gid:\/\/shopify\/CalculatedOrder\/[1-9][0-9]*$/;
const EXPECTED_PACKET="ASB_LAB_SYNTHETIC_AUTH_ONLY_V1";
function makeLabCommitCoordinator({
  pool,shopDomain,devDomainAllowlist=[],quoteSecret,shopifyClient
}={}){
  fail(shopDomain===SHOP&&devDomainAllowlist.includes(SHOP),
    "LAB_REAL_COMMIT_WRONG_STORE");
  fail(pool&&typeof pool.connect==="function"&&
    typeof quoteSecret==="string"&&Buffer.byteLength(quoteSecret,"utf8")>=32,
    "LAB_REAL_COMMIT_DB_OR_HMAC_REQUIRED");
  fail(shopifyClient&&[
    "readGrantedScopesForLab","readLabOrderForAmendment",
    "previewLabApnaOnionUncommitted","commitLabStagedOrderEdit",
    "readLabOrderForCommitReconcile"
  ].every(k=>typeof shopifyClient[k]==="function"),
  "LAB_REAL_COMMIT_SHOPIFY_ADAPTER_REQUIRED");

  async function tx(fn){
    const db=await pool.connect();let started=false;
    try{
      await db.query("BEGIN");started=true;
      const out=await fn(db);
      await db.query("COMMIT");started=false;return out;
    }catch(err){
      if(started)try{await db.query("ROLLBACK");}catch{}
      throw err;
    }finally{db.release();}
  }
  async function source(db,authorizationId,locked){
    const query=[
      "SELECT a.authorization_id,a.original_claim_id,a.shop_domain,a.household_key,",
      "a.cycle_code,a.shopify_order_gid,a.signed_amendment,a.payload_sha256,",
      "a.original_total_paisa,a.additional_paisa,a.proposed_total_paisa,",
      "a.state AS auth_state,r.shopify_order_gid AS claim_order_gid,",
      "r.state AS claim_state,r.expected_cod_paisa,r.household_key AS claim_household,",
      "q.signed_quote,q.state AS quote_state,q.version AS quote_version,",
      "q.delivery_date::text AS source_delivery_date,",
      "c.status::text AS cycle_status,c.opens_at,c.locks_at,",
      "c.delivery_date::text AS cycle_delivery_date",
      "FROM checkout_lab_apna_signed_amendments a",
      "JOIN checkout_redemptions r ON r.claim_id=a.original_claim_id",
      "JOIN checkout_quotes q ON q.quote_id=r.quote_id",
      "JOIN cycles c ON c.code=a.cycle_code",
      "WHERE a.authorization_id=$1",
      locked?"FOR UPDATE OF a,r":""
    ].join(" ");
    return (await db.query(query,[authorizationId])).rows[0];
  }
  function verifySource(row){
    fail(row?.shop_domain===SHOP&&row.shopify_order_gid===ORDER&&
      row.claim_order_gid===ORDER&&row.cycle_code===CYCLE&&
      row.claim_state==="completed"&&row.auth_state==="synthetic_authorized_uncommitted"&&
      row.quote_state==="active"&&row.quote_version===1&&
      row.source_delivery_date==="2026-11-16"&&
      row.cycle_delivery_date==="2026-11-16"&&
      row.household_key===row.claim_household&&
      Number(row.expected_cod_paisa)===4500&&
      Number(row.original_total_paisa)===4500&&
      Number(row.additional_paisa)===9000&&
      Number(row.proposed_total_paisa)===13500,
      "LAB_REAL_COMMIT_AUTHORISATION_ORIGINAL_MISMATCH");
    const packet=row.signed_amendment;
    fail(packet?.schemaVersion===EXPECTED_PACKET&&
      packet.shopDomain===SHOP&&packet.shopifyOrderGid===ORDER&&
      packet.originalQuoteId===QUOTE&&packet.cycleCode===CYCLE&&
      packet.householdKey===row.household_key&&
      packet.consentMode==="SYNTHETIC_OPERATOR_LAB_ONLY"&&
      packet.realCustomerConsent===false&&
      packet.customerNotificationApproved===false&&
      packet.policyVersion==="LAB_TEST_RULES_NOT_FOUNDER_APPROVED"&&
      packet.originalLines?.length===1&&packet.proposedLines?.length===2&&
      packet.proposedLines[0].lineId===packet.originalLines[0].lineId&&
      canonical(packet.proposedLines[0])===canonical(packet.originalLines[0])&&
      packet.proposedLines[0].qty===500&&
      packet.proposedLines[1].qty===1000&&
      packet.proposedLines[1].shopifyVariantGid===
        "gid://shopify/ProductVariant/69644381716514"&&
      packet.originalTotalPaisa===4500&&packet.additionalPaisa===9000&&
      packet.proposedTotalPaisa===13500&&
      sha(packet)===row.payload_sha256&&
      verifySignedQuote(packet,quoteSecret),
      "LAB_REAL_COMMIT_SIGNED_PACKET_INVALID");
    verifyOriginalQuote(row.signed_quote,quoteSecret);
    fail(packet.originalQuoteSignature===row.signed_quote.serverSignature&&
      packet.householdKey===row.signed_quote.customerReference,
      "LAB_REAL_COMMIT_ORIGINAL_SIGNATURE_LINK_INVALID");
    return packet;
  }
  async function getAttempt(db,authorizationId,lock=false){
    const sql="SELECT * FROM checkout_lab_apna_real_commit_attempts "+
      "WHERE authorization_id=$1"+(lock?" FOR UPDATE":"");
    return (await db.query(sql,[authorizationId])).rows[0];
  }
  function authId(id){
    fail(typeof id==="string"&&/^[0-9a-f]{8}-[0-9a-f-]{27,}$/.test(id),
      "LAB_REAL_COMMIT_AUTH_ID_REQUIRED");
  }
  async function recordIntent({authorizationId,calculatedOrderGid}={}){
    authId(authorizationId);
    fail(GID.test(calculatedOrderGid||""),
      "LAB_REAL_COMMIT_CALCULATED_ORDER_REQUIRED");
    return tx(async db=>{
      const initial=await source(db,authorizationId,false);
      fail(initial?.shop_domain===SHOP,"LAB_REAL_COMMIT_AUTH_NOT_FOUND");
      await db.query(
        "INSERT INTO checkout_household_cycle_locks(shop_domain,household_key,cycle_code)"+
        " VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [SHOP,initial.household_key,CYCLE]);
      await db.query(
        "SELECT household_key FROM checkout_household_cycle_locks"+
        " WHERE shop_domain=$1 AND household_key=$2 AND cycle_code=$3 FOR UPDATE",
        [SHOP,initial.household_key,CYCLE]);
      const packet=verifySource(row);
      const prior=await getAttempt(db,authorizationId,true);
      if(prior){
        // Once any intent exists, not even a different calculated session
        // authorizes a second external commit.
        return {fresh:false,state:prior.state,attemptId:prior.attempt_id,
          calculatedOrderGid:prior.calculated_order_gid};
      }
      const now=(await db.query("SELECT clock_timestamp() AS now")).rows[0].now;
      fail(row.cycle_status==="open"&&now>=row.opens_at&&now<row.locks_at,
        "LAB_REAL_COMMIT_DELIVERY_CUTOFF_CLOSED");
      const claims=(await db.query(
        "SELECT count(*)::int AS n FROM checkout_redemptions"+
        " WHERE shop_domain=$1 AND household_key=$2 AND cycle_code=$3",
        [SHOP,row.household_key,CYCLE])).rows[0].n;
      fail(claims===1,"LAB_REAL_COMMIT_OTHER_CYCLE_COMMITMENT_PRESENT");
      const quoteDigest=sha(row.signed_quote);
      const inserted=(await db.query(
        "INSERT INTO checkout_lab_apna_real_commit_attempts("+
        "authorization_id,original_claim_id,shop_domain,household_key,cycle_code,"+
        "shopify_order_gid,calculated_order_gid,signed_packet_sha256,"+
        "source_quote_sha256,original_paisa,addition_paisa,expected_paisa)"+
        " VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,4500,9000,13500)"+
        " RETURNING attempt_id,state",
        [authorizationId,row.original_claim_id,SHOP,row.household_key,
          CYCLE,ORDER,calculatedOrderGid,sha(packet),quoteDigest])).rows[0];
      await db.query(
        "INSERT INTO checkout_lab_apna_commit_audit"+
        "(attempt_id,action,evidence_json) VALUES($1,'INTENT_DURABLE_NO_RETRY',$2::jsonb)",
        [inserted.attempt_id,JSON.stringify({kind:"durable_one_shot_lab",
          shopifyOrderGid:ORDER,calculatedOrderGid,expectedPaisa:13500})]);
      return {fresh:true,state:"intent_recorded",attemptId:inserted.attempt_id,
        calculatedOrderGid};
    });
  }
  async function settle(authorizationId,evidence,reason){
    return tx(async db=>{
      // Exactly the SAME lock ordering as recordIntent:
      // household-cycle -> source authorization/claim -> commit attempt.
      // Inverted order here previously allowed a real deadlock under races.
      const initial=await source(db,authorizationId,false);
      fail(initial?.shop_domain===SHOP,"LAB_REAL_COMMIT_AUTH_NOT_FOUND");
      await db.query(
        "INSERT INTO checkout_household_cycle_locks(shop_domain,household_key,cycle_code)"+
        " VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
        [SHOP,initial.household_key,CYCLE]);
      await db.query(
        "SELECT household_key FROM checkout_household_cycle_locks"+
        " WHERE shop_domain=$1 AND household_key=$2 AND cycle_code=$3 FOR UPDATE",
        [SHOP,initial.household_key,CYCLE]);
      const row=await source(db,authorizationId,true);
      const attempt=await getAttempt(db,authorizationId,true);
      fail(attempt&&attempt.shop_domain===SHOP&&attempt.shopify_order_gid===ORDER,
        "LAB_REAL_COMMIT_INTENT_MISSING");
      if(attempt.state==="verified")return {state:"verified",
        attemptId:attempt.attempt_id,alreadyVerified:true,billSent:false};
      if(!evidence){
        if(attempt.state==="intent_recorded"){
          const notice={kind:"readback_unverified",
            reasonCode:reason||"SHOPIFY_READ_NOT_CONCLUSIVE"};
          await db.query(
            "UPDATE checkout_lab_apna_real_commit_attempts"+
            " SET state='needs_reconcile',evidence_json=$2::jsonb,"+
            " updated_at=clock_timestamp() WHERE attempt_id=$1",
            [attempt.attempt_id,JSON.stringify(notice)]);
          await db.query(
            "INSERT INTO checkout_lab_apna_commit_audit"+
            "(attempt_id,action,evidence_json)"+
            " VALUES($1,'COMMIT_OUTCOME_UNCERTAIN',$2::jsonb)",
            [attempt.attempt_id,JSON.stringify(notice)]);
        }
        return {state:"needs_reconcile",attemptId:attempt.attempt_id,
          billSent:false,mayRetryCommit:false};
      }
      const row=await source(db,authorizationId,true);
      const packet=verifySource(row);
      fail(attempt.signed_packet_sha256===sha(packet)&&
        attempt.source_quote_sha256===sha(row.signed_quote),
        "LAB_REAL_COMMIT_SIGNED_SNAPSHOT_CHANGED");
      const versions=syntheticUnsentBillVersions({
        attemptId:attempt.attempt_id,packet,evidence,
        originalQuoteDigest:attempt.source_quote_sha256
      }).versions;
      for(const bill of versions){
        await db.query(
          "INSERT INTO checkout_lab_apna_bill_history"+
          "(attempt_id,version,supersedes_version,total_paisa,state,"+
          "snapshot_sha256,snapshot_json)"+
          " VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)",
          [attempt.attempt_id,bill.version,bill.supersedesVersion,
            bill.totalPaisa,bill.state,bill.sha256,JSON.stringify(bill.snapshot)]);
      }
      const normalized={kind:"independent_shopify_readback",
        orderDigest:evidence.digest,expectedTotalPaisa:13500,
        billVersion:2,customerNotified:false};
      await db.query(
        "UPDATE checkout_lab_apna_real_commit_attempts"+
        " SET state='verified',evidence_json=$2::jsonb,"+
        " postcommit_order_sha256=$3,verified_at=clock_timestamp(),"+
        " updated_at=clock_timestamp() WHERE attempt_id=$1",
        [attempt.attempt_id,JSON.stringify(normalized),evidence.digest]);
      await db.query(
        "INSERT INTO checkout_lab_apna_commit_audit"+
        "(attempt_id,action,evidence_json) VALUES"+
        "($1,'SHOPIFY_READBACK_VERIFIED',$2::jsonb),"+
        "($1,'BILL_VERSION_2_DRAFTED',$3::jsonb)",
        [attempt.attempt_id,JSON.stringify({orderDigest:evidence.digest}),
          JSON.stringify({billVersion:2,customerNotified:false})]);
      return {state:"verified",attemptId:attempt.attempt_id,
        totalPaisa:13500,billVersions:2,billSent:false,
        customerNotified:false};
    });
  }
  async function recoverByReadOnly({authorizationId}={}){
    authId(authorizationId);
    const prior=await tx(async db=>{
      const row=await getAttempt(db,authorizationId);
      fail(row&&row.shopify_order_gid===ORDER,"LAB_REAL_COMMIT_INTENT_MISSING");
      return {state:row.state};
    });
    if(prior.state==="verified")
      return {state:"verified",alreadyVerified:true,billSent:false};
    let evidence=null;
    try{
      const read=await shopifyClient.readLabOrderForCommitReconcile({orderGid:ORDER});
      evidence=postCommitEvidence(read);
    }catch{
      // The original Rs45 order or an unavailable API never permits retry.
    }
    return settle(authorizationId,evidence,
      evidence?"INDEPENDENT_SHOPIFY_READ_VERIFIED":"SHOPIFY_READ_NOT_CONCLUSIVE");
  }
  async function executeOnce({authorizationId,operatorGate}={}){
    authId(authorizationId);
    // Never write with a general checkout flag; only the intentionally
    // configured, separate lab amendment flag allows the one-shot coordinator.
    fail(operatorGate==="REVIEWED_LAB_ONE_SHOT_COMMIT"&&
      process.env.ASB_LAB_REAL_COMMIT==="REVIEWED_ONE_SHOT_ONLY"&&
      process.env.ASB_LAB_WRITE_MODE==="lab-commit-single-attempt",
      "LAB_REAL_COMMIT_OPERATOR_DISABLED");
    // A retry, even after process death, only reads the existing intent.
    const previous=await tx(async db=>getAttempt(db,authorizationId));
    if(previous)return {state:previous.state,attemptId:previous.attempt_id,
      commitDispatched:false,recoveryOnly:true,billSent:false};
    const granted=await shopifyClient.readGrantedScopesForLab();
    fail(granted?.shopDomain===SHOP&&granted.ready===true,
      "LAB_REAL_COMMIT_SCOPE_NOT_GRANTED");
    const original=await shopifyClient.readLabOrderForAmendment({orderGid:ORDER});
    verifyOrder(original);
    // Staging does NOT finalize Shopify data.
    const stage=await shopifyClient.previewLabApnaOnionUncommitted({
      orderGid:ORDER,operatorApproval:"ASB_LAB_APNA_ONION_STAGE_ONLY",
      previewMode:"STAGE_WITHOUT_COMMIT"
    });
    fail(stage?.state==="STAGED_ONLY_NOT_COMMITTED"&&
      stage.explicitNoCommit===true&&stage.originalPaisa===4500&&
      stage.additionalPaisa===9000&&stage.expectedFinalPaisa===13500&&
      GID.test(stage.calculatedOrderId||""),
      "LAB_REAL_COMMIT_STAGED_PREVIEW_NOT_VERIFIED");
    const intent=await recordIntent({
      authorizationId,calculatedOrderGid:stage.calculatedOrderId
    });
    if(!intent.fresh)return {state:intent.state,attemptId:intent.attemptId,
      commitDispatched:false,recoveryOnly:true,billSent:false};
    let acknowledgement=false;
    try{
      const r=await shopifyClient.commitLabStagedOrderEdit({
        shopifyOrderGid:ORDER,calculatedOrderGid:intent.calculatedOrderGid,
        durableIntentRecorded:true,
        operatorGate:"DURABLE_LAB_COMMIT_INTENT_VERIFIED"
      });
      acknowledgement=r?.state==="mutation_acknowledged_needs_readback";
    }catch{
      // After the DB intent was written, failure is NEVER a retry signal.
    }
    const recovery=await recoverByReadOnly({authorizationId});
    return {...recovery,commitDispatched:true,
      mutationAcknowledged:acknowledgement,mayRetryCommit:false};
  }
  return {executeOnce,recoverByReadOnly};
}
module.exports={makeLabCommitCoordinator};
