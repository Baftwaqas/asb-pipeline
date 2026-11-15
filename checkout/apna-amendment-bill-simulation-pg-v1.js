// ASB Phase 3: persist SIMULATION-ONLY bill-reconciliation evidence.
// No Shopify call, order mutation, customer notification, tax/payment mutation,
// operational invoice, or activation. Migration 027 is explicitly on HOLD.
"use strict";
const crypto=require("node:crypto");
const {QuoteError,canonical}=require("./quote-crypto-v1");
const SHOP="asb-checkout-lab.myshopify.com";
const HEX=/^[a-f0-9]{64}$/;
function check(ok,code){if(!ok)throw new QuoteError(code);}
function hash(x){return crypto.createHash("sha256").update(canonical(x),"utf8").digest("hex");}
function integer(x){return Number.isSafeInteger(x)&&x>=0;}

function createPgAmendmentBillSimulation({pool,shopDomain,devDomainAllowlist=[]}={}){
  check(pool&&typeof pool.connect==="function","AMENDMENT_BILL_DB_REQUIRED");
  check(shopDomain===SHOP&&devDomainAllowlist.includes(SHOP),
    "AMENDMENT_BILL_LAB_ONLY");

  async function record({reservationId,reconciliation}={}){
    const rec=reconciliation, bill=rec?.draft;
    check(typeof reservationId==="string"&&reservationId.length>0,
      "AMENDMENT_BILL_RESERVATION_REQUIRED");
    check(rec?.state==="SIMULATED_RECONCILED_NOT_COMMITTED_NOT_SENT"&&
      rec.shopifyModified===false&&rec.billSent===false&&
      bill?.state==="SIMULATION_DRAFT_NOT_SENT"&&
      bill.schemaVersion==="ASB_AMENDMENT_BILL_SIMULATION_V1"&&
      rec.draftSha256===hash(bill)&&HEX.test(rec.draftSha256)&&
      bill.shopDomain===SHOP&&bill.reservationId===reservationId,
      "AMENDMENT_BILL_SIMULATION_EVIDENCE_REQUIRED");
    check(Number.isSafeInteger(bill.billVersion)&&bill.billVersion>=2&&
      Number.isSafeInteger(bill.replacesBillVersion)&&
      bill.billVersion===bill.replacesBillVersion+1&&
      HEX.test(bill.previousBillDigest||"")&&integer(bill.totalPaisa)&&
      integer(bill.amendmentDeltaPaisa),
      "AMENDMENT_BILL_INVALID_REVISION");

    const db=await pool.connect();
    let begun=false;
    try{
      await db.query("BEGIN");begun=true;
      const reservation=(await db.query(
        "SELECT a.reservation_id,a.shop_domain,a.shopify_order_gid,"+
        " a.proposed_snapshot,a.snapshot_sha256,a.additional_paisa,"+
        " r.expected_cod_paisa,r.state AS claim_state"+
        " FROM checkout_apna_amendment_reservations a"+
        " JOIN checkout_redemptions r ON r.claim_id=a.original_claim_id"+
        " WHERE a.reservation_id=$1 FOR UPDATE OF a",
        [reservationId])).rows[0];
      check(reservation&&reservation.shop_domain===SHOP&&
        reservation.claim_state==="completed"&&
        reservation.shopify_order_gid===bill.shopifyOrderGid&&
        hash(reservation.proposed_snapshot)===reservation.snapshot_sha256,
        "AMENDMENT_BILL_RESERVATION_INTEGRITY_ERROR");
      check(integer(Number(reservation.additional_paisa))&&
        Number(reservation.additional_paisa)===bill.amendmentDeltaPaisa&&
        integer(Number(reservation.expected_cod_paisa))&&
        Number(reservation.expected_cod_paisa)+bill.amendmentDeltaPaisa===bill.totalPaisa&&
        canonical(reservation.proposed_snapshot.proposedLines)===canonical(bill.lines),
        "AMENDMENT_BILL_SNAPSHOT_OR_COD_MISMATCH");

      const exists=(await db.query(
        "SELECT simulation_id,draft_bill_sha256,original_bill_sha256,draft_bill_version"+
        " FROM checkout_apna_amendment_bill_simulations"+
        " WHERE reservation_id=$1 FOR UPDATE",[reservationId])).rows[0];
      if(exists){
        check(exists.draft_bill_sha256===rec.draftSha256&&
          exists.original_bill_sha256===bill.previousBillDigest&&
          exists.draft_bill_version===bill.billVersion,
          "AMENDMENT_BILL_SIMULATION_ALREADY_RECORDED");
        await db.query("COMMIT");begun=false;
        return {state:"simulation_only",simulationId:exists.simulation_id,
          idempotent:true,shopifyModified:false,billSent:false};
      }

      const inserted=(await db.query(
        "INSERT INTO checkout_apna_amendment_bill_simulations "+
        "(reservation_id,shop_domain,shopify_order_gid,original_bill_version,"+
        "draft_bill_version,original_bill_sha256,draft_bill_sha256,"+
        "expected_total_paisa,additional_paisa,draft_json)"+
        " VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)"+
        " RETURNING simulation_id",
        [reservationId,SHOP,bill.shopifyOrderGid,bill.replacesBillVersion,
          bill.billVersion,bill.previousBillDigest,rec.draftSha256,
          bill.totalPaisa,bill.amendmentDeltaPaisa,JSON.stringify(bill)])).rows[0];
      await db.query("COMMIT");begun=false;
      return {state:"simulation_only",simulationId:inserted.simulation_id,
        idempotent:false,shopifyModified:false,billSent:false};
    }catch(err){
      if(begun)try{await db.query("ROLLBACK");}catch{}
      if(err?.code==="23505")throw new QuoteError("AMENDMENT_BILL_SIMULATION_CONFLICT");
      throw err;
    }finally{db.release();}
  }
  return {record};
}
module.exports={createPgAmendmentBillSimulation};
