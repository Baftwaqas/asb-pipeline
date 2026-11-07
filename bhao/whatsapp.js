// ============================================================================
// ASB PIPELINE — bhao/whatsapp.js
// Bhao Tao over WhatsApp: a customer bargains with Seth Ji on ASB's number.
//
//   onInbound()  called for each NEW inbound text (after it is saved to the
//                inbox, so staff always see it). Starts a bargain on
//                "BHAO <ITEM-CODE>" (the storefront button pre-fills it),
//                otherwise continues the phone's open bargain, otherwise
//                leaves the message to the normal inbox.
//   sendDue()    sends Seth Ji's replies whose pause has passed. Seth Ji does
//                not answer instantly; the engine sets each pause.
//
// The engine (bhao/engine.js) decides every price. The voice (bhao/voice.js)
// only words it, checked against that decision. A new message from her
// supersedes a reply not yet sent, so she never gets an answer to something
// she has already moved past.
//
// Off unless BHAO_TAO_WHATSAPP=on (server.js). Nothing here creates an order:
// an accepted bargain is recorded and handed to the team to confirm.
// ============================================================================
"use strict";

const B = require("./engine");
const V = require("./voice");
const PW = require("./price-watch");

// DRAFT policy (test values from docs/bhao-tao-engine-v1.md). Founder decision
// pending; the version is stamped on every conversation.
const POLICY = Object.freeze({
  version: "BHAO-DRAFT-1", lowballRatio: 0.35, refuseRounds: 2, maxRounds: 10, stepPlan: [0.35, 0.25, 0.2, 0.15],
  stepJitter: 0.2, settleBand: 0.25, settleAfterRounds: 4, roundToPaisa: 1000,
  delaySeconds: { normal: [20, 90], lowball: [180, 420], settle: [10, 40] }, offerTtlMinutes: 120, settleAtLastRound: true,
});
const RESTART_MEMORY_DAYS = 7;
const IDLE_EXPIRE_HOURS = 24; // WhatsApp's free-reply window
const START = /^\s*bhao\s+([a-z0-9][a-z0-9-]{2,40})\b/i;

function itemFor(row) {
  return {
    itemId: row.item_id, variantGid: row.variant_gid, bhaoTaoEnabled: row.active === true, isGrocery: false,
    anchorPaisa: Number(row.anchor_paisa), floorPaisa: Number(row.floor_paisa),
    costPaisa: row.cost_paisa == null ? null : Number(row.cost_paisa), maxQty: row.max_qty, approvedBy: row.approved_by,
    groupTiers: (row.group_tiers || []).map((t) => ({ minQty: Number(t.minQty), floorPaisa: Number(t.floorPaisa) })),
  };
}

/** Her amount (paisa), from "900", "Rs 1,200", "1.2k", "2 lakh"; null if she is just talking. */
function readOffer(text) {
  const n = V.numbersIn(String(text).replace(/\b\d{1,2}\s*(?:pcs|pieces?|adad|degchi\w*|lein|le lo|lunga|lungi|chahiye)\b/gi, ""))
    .find((x) => x >= 50);
  return n == null ? null : Math.round(n * 100);
}
/** "5 lein", "paanch chahiye" -> 5; null if she named no quantity. */
function readQty(text) {
  const m = /\b(\d{1,2})\s*(?:pcs|pieces?|adad|degchi\w*|lein|le lo|lunga|lungi|chahiye)\b/i.exec(text);
  if (m) return Number(m[1]);
  const W = { do: 2, teen: 3, chaar: 4, char: 4, paanch: 5, panch: 5, chhe: 6, saat: 7, aath: 8, nau: 9, das: 10 };
  const w = /\b(do|teen|chaar|char|paanch|panch|chhe|saat|aath|nau|das)\s+(?:pcs|pieces?|adad|degchi\w*|lein|le lo|lunga|lungi|chahiye)\b/i.exec(text);
  return w ? W[w[1].toLowerCase()] : null;
}

const seconds = (action) => (Number.isSafeInteger(action.delaySeconds) ? action.delaySeconds : 30);

async function tx(db, fn) {
  await db.query("BEGIN");
  try { const r = await fn(); await db.query("COMMIT"); return r; }
  catch (e) { await db.query("ROLLBACK").catch(() => {}); throw e; }
}

/**
 * One new inbound text. `db` is a single client (transactions run on it).
 * Returns { handled, conversationId?, duplicate?, reason? }.
 */
async function onInbound(db, { phone, text, wamid, now = new Date(), env = process.env, fetchImpl = fetch, speak = V.speak }) {
  const body = String(text || "").slice(0, 1000);
  const start = START.exec(body);

  const step = await tx(db, async () => {
    let conv = (await db.query(`SELECT * FROM bhao_conversations WHERE phone = $1 AND status = 'open' FOR UPDATE`, [phone])).rows[0];

    // her open bargain has gone quiet past the free-reply window: let it lapse
    if (conv && now - new Date(conv.last_inbound_at) > IDLE_EXPIRE_HOURS * 3600e3) {
      await db.query(`UPDATE bhao_conversations SET status = 'expired', ended_at = $2 WHERE id = $1`, [conv.id, now]);
      conv = null;
    }

    let itemRow, state, action;
    if (start) {
      const code = start[1].toUpperCase();
      itemRow = (await db.query(`SELECT * FROM bhao_items WHERE item_id = $1 AND active`, [code])).rows[0];
      if (!itemRow) return { handled: false, reason: "unknown item " + code }; // the inbox sees it
      if (conv && conv.item_id !== code) {
        await db.query(`UPDATE bhao_conversations SET status = 'closed', ended_at = $2 WHERE id = $1`, [conv.id, now]);
        conv = null;
      }
      if (!conv) {
        const item = itemFor(itemRow);
        const opened = B.open({ conversationId: `${phone}:${code}:${now.getTime()}`, item, qty: 1, policy: POLICY,
                                seed: `${phone}:${code}:${now.toISOString()}` });
        state = opened.state; action = opened.action;
        // Restarting never resets the bargain: within 7 days she continues at
        // her last ask on this item (never lower, never back up to the anchor).
        const prev = (await db.query(
          `SELECT state FROM bhao_conversations WHERE phone = $1 AND item_id = $2 AND started_at > $3
            ORDER BY started_at DESC LIMIT 1`, [phone, code, new Date(now - RESTART_MEMORY_DAYS * 864e5)])).rows[0];
        if (prev && Number(prev.state.askPaisa) < state.askPaisa) {
          state.askPaisa = Math.max(Number(prev.state.askPaisa), item.floorPaisa);
          action = { ...action, askPaisa: state.askPaisa, resumed: true };
        }
        conv = (await db.query(
          `INSERT INTO bhao_conversations (phone, item_id, status, state, policy_version, started_at, last_inbound_at)
           VALUES ($1, $2, 'open', $3, $4, $5, $5) RETURNING *`, [phone, code, state, POLICY.version, now])).rows[0];
      }
    }
    if (!conv) return { handled: false, reason: "no open bargain" };

    const saved = await db.query(
      `INSERT INTO bhao_messages (conversation_id, direction, inbound_wamid, body) VALUES ($1, 'in', $2, $3)
       ON CONFLICT (inbound_wamid) DO NOTHING RETURNING id`, [conv.id, wamid, body]);
    if (!saved.rowCount) return { handled: true, duplicate: true, conversationId: conv.id };
    const inboundId = saved.rows[0].id;

    // anything Seth Ji had not said yet is now out of date
    await db.query(`UPDATE bhao_messages SET send_status = 'superseded' WHERE conversation_id = $1 AND send_status = 'pending'`, [conv.id]);

    itemRow = itemRow || (await db.query(`SELECT * FROM bhao_items WHERE item_id = $1`, [conv.item_id])).rows[0];
    const item = itemFor(itemRow);
    let offerPaisa = null;
    if (!action) {
      state = conv.state;
      const amount = readOffer(body);
      const q = readQty(body);
      const named = q && q >= 1 && q <= item.maxQty ? q : null;
      if (amount == null) {
        // talking, or naming a quantity: no price moves; the quantity is
        // remembered for her next offer ("5 lein" ... "1200")
        action = { kind: "talk" };
        if (named) state = { ...state, pendingQty: named };
      } else {
        offerPaisa = amount;
        const qty = named ?? state.pendingQty ?? state.qty;
        const r = B.offer(state, { item, policy: POLICY, pricePaisa: amount, qty, now });
        state = { ...r.state, pendingQty: undefined };
        action = r.action;
      }
    }
    const status = state.status === "accepted" ? "accepted" : state.status === "closed" ? "closed" : "open";
    await db.query(
      `UPDATE bhao_conversations SET state = $2, status = $3, last_inbound_at = $4,
              accepted_offer = $5, ended_at = CASE WHEN $3 = 'open' THEN NULL ELSE $4::timestamptz END
        WHERE id = $1`, [conv.id, state, status, now, status === "accepted" ? state.accepted : null]);

    const latest = (await db.query(`SELECT * FROM competitor_price_latest WHERE item_id = $1`, [item.itemId])).rows;
    return { handled: true, conversationId: conv.id, inboundId, item, itemRow, state, action, offerPaisa, latest,
             history: (await db.query(
               `SELECT direction, body FROM bhao_messages WHERE conversation_id = $1 AND (direction = 'in' OR send_status = 'sent')
                 ORDER BY id DESC LIMIT 8`, [conv.id])).rows.reverse() };
  });
  if (!step.handled || step.duplicate) return step;

  // Words, outside the transaction (a model call takes seconds).
  const voiced = V.priceOf(step.action) ?? step.state.askPaisa;
  const competitorFacts = PW.competitorFacts({ latest: step.latest, ourUnitPaisa: voiced, now }).facts;
  const said = await speak({
    decision: step.action, itemName: step.itemRow.name, qty: step.state.qty, offerPaisa: step.offerPaisa,
    customerText: body, history: step.history.map((h) => ({ from: h.direction === "in" ? "baji" : "seth", text: h.body })),
    groupSizes: step.item.groupTiers.map((t) => t.minQty), itemFacts: step.itemRow.facts || [],
    competitorFacts, stockLeft: step.itemRow.stock_left, env, fetchImpl,
  });

  // Queue the reply - unless she has written again meanwhile (that message
  // gets its own, newer reply).
  return tx(db, async () => {
    await db.query(`SELECT id FROM bhao_conversations WHERE id = $1 FOR UPDATE`, [step.conversationId]);
    const newer = (await db.query(
      `SELECT 1 FROM bhao_messages WHERE conversation_id = $1 AND direction = 'in' AND id > $2`, [step.conversationId, step.inboundId])).rowCount;
    if (newer) return { handled: true, conversationId: step.conversationId, superseded: true };
    const due = new Date(now.getTime() + seconds(step.action) * 1000);
    await db.query(
      `INSERT INTO bhao_messages (conversation_id, direction, body, decision, source, provider, rejected, send_after, send_status)
       VALUES ($1, 'out', $2, $3, $4, $5, $6, $7, 'pending')`,
      [step.conversationId, said.text, step.action, said.source, said.provider, JSON.stringify(said.rejected || []), due]);
    if (step.action.kind === "accept") {
      await db.query(
        `INSERT INTO bhao_messages (conversation_id, direction, body, decision, source, send_after, send_status)
         VALUES ($1, 'out', $2, $3, 'template', $4, 'pending')`,
        [step.conversationId,
         `✅ Sauda pakka: ${step.itemRow.name}, ${step.state.accepted.qty} × Rs ${(step.state.accepted.unitPaisa / 100).toLocaleString("en-US")}. Hamari team aap ko order confirm karne ke liye abhi message karegi.`,
         { kind: "accept_followup", offerId: step.state.accepted.offerId }, new Date(due.getTime() + 5000)]);
    }
    return { handled: true, conversationId: step.conversationId, kind: step.action.kind, source: said.source, due };
  });
}

/**
 * Send replies whose pause has passed. `sendText(phone, body)` is
 * whatsapp.js's sendText (returns {ok, wamid}); `logOutbound` records the
 * line in the inbox so staff see Seth Ji's side too.
 */
async function sendDue(db, { sendText, logOutbound = async () => {}, now = new Date(), limit = 20 }) {
  let sent = 0, failed = 0;
  const rows = (await db.query(
    `SELECT m.id, m.body, c.phone FROM bhao_messages m JOIN bhao_conversations c ON c.id = m.conversation_id
      WHERE m.send_status = 'pending' AND m.send_after <= $1 ORDER BY m.send_after, m.id LIMIT $2`, [now, limit])).rows;
  for (const r of rows) {
    await tx(db, async () => {
      const still = (await db.query(
        `SELECT 1 FROM bhao_messages WHERE id = $1 AND send_status = 'pending' FOR UPDATE SKIP LOCKED`, [r.id])).rowCount;
      if (!still) return; // superseded meanwhile, or another sender has it
      let res;
      try { res = await sendText(r.phone, r.body); } catch (e) { res = { ok: false }; }
      await db.query(`UPDATE bhao_messages SET send_status = $2, sent_wamid = $3, sent_at = $4 WHERE id = $1`,
        [r.id, res && res.ok ? "sent" : "failed", res && res.wamid ? res.wamid : null, now]);
      if (res && res.ok) sent++; else failed++;
      await logOutbound({ phone: r.phone, body: r.body, agent: "seth-ji", wamid: res && res.wamid, ok: !!(res && res.ok), payload: { bhao_message_id: r.id } });
    });
  }
  return { sent, failed };
}

module.exports = { POLICY, onInbound, sendDue, readOffer, readQty, itemFor };
