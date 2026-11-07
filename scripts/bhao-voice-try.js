#!/usr/bin/env node
// ============================================================================
// ASB PIPELINE — scripts/bhao-voice-try.js
//
// Plays one short Bhao Tao conversation against the configured voice
// provider and prints each Seth Ji line with where it came from (ai or
// template) and why a reply was rejected. Touches no database, sends no
// WhatsApp message. Spends a few provider calls.
//
//   BHAO_VOICE_PROVIDER=xai XAI_API_KEY=... XAI_MODEL=... node scripts/bhao-voice-try.js
//   node scripts/bhao-voice-try.js 900 "itna mehenga kyun?" 1100 2000
//
// Each argument is one customer message; a message with an amount is an
// offer, anything else is chat.
// ============================================================================
"use strict";

const B = require("../bhao/engine");
const V = require("../bhao/voice");

const ITEM = {
  itemId: "DEMO-POT-5L", variantGid: "gid://shopify/ProductVariant/0", bhaoTaoEnabled: true, isGrocery: false,
  anchorPaisa: 180000, floorPaisa: 85000, costPaisa: 60000, maxQty: 20, approvedBy: "demo",
  groupTiers: [{ minQty: 5, floorPaisa: 75000 }],
};
const POLICY = {
  version: "BHAO-DEMO", lowballRatio: 0.35, refuseRounds: 2, maxRounds: 10, stepPlan: [0.35, 0.25, 0.2, 0.15],
  stepJitter: 0.2, settleBand: 0.25, settleAfterRounds: 4, roundToPaisa: 1000,
  delaySeconds: { normal: [20, 90], lowball: [180, 420], settle: [10, 40] }, offerTtlMinutes: 120, settleAtLastRound: true,
};

function amount(text) {
  const n = V.numbersIn(text).find((x) => x >= 50);
  return n == null ? null : Math.round(n * 100);
}

async function main() {
  const msgs = process.argv.slice(2).length ? process.argv.slice(2) : ["500", "900 mein de do", "itna mehenga kyun?", "1000", "1100", "Rs 2,000"];
  const history = [];
  let { state, action } = B.open({ conversationId: "TRY-" + Date.now(), item: ITEM, qty: 1, policy: POLICY, seed: String(Date.now()) });
  const line = async (decision, customerText, offerPaisa) => {
    const r = await V.speak({ decision, itemName: "Steel ki Degchi 5 litre", qty: state.qty, offerPaisa, customerText,
                              history, groupSizes: [5] });
    history.push({ from: "seth", text: r.text });
    console.log(`SETH JI [${r.source}${r.provider ? ":" + r.provider : ""}${r.attempts > 1 ? ", try " + r.attempts : ""}] ${r.text}`);
    if (r.rejected.length) console.log("   rejected:", r.rejected.join(" | "));
  };
  await line(action, "", null);
  for (const m of msgs) {
    if (state.status !== "open") break;
    console.log("BAJI   " + m);
    history.push({ from: "baji", text: m });
    const offer = amount(m);
    if (offer == null) { await line({ kind: "talk" }, m, null); continue; }
    const step = B.offer(state, { item: ITEM, policy: POLICY, pricePaisa: offer, now: new Date() });
    state = step.state;
    await line(step.action, m, offer);
  }
  console.log(`\nstatus: ${state.status}${state.accepted ? `, sauda ${(state.accepted.unitPaisa / 100)} (${state.accepted.why})` : ""}`);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
