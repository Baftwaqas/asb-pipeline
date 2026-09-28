#!/usr/bin/env node
// ============================================================================
// ASB PIPELINE — scripts/wa-send-test.js
//
// Sends ONE short test message from the business number to ONE phone, and
// prints exactly what Meta answered. Used to prove sending works before
// AiSensy is switched off.
//
//   node scripts/wa-send-test.js 03001234567
//
// WhatsApp only allows a free-text message to someone who has written to the
// business number in the last 24 hours. So send "test" to the business number
// from that phone FIRST, then run this.
// ============================================================================

"use strict";

const wa = require("../whatsapp");

const raw = String(process.argv[2] || "").replace(/[^\d]/g, "");
// 03001234567 -> 923001234567 ; 923001234567 stays as it is
const phone = raw.startsWith("0") ? "92" + raw.slice(1) : raw;

if (!/^92\d{10}$/.test(phone)) {
  console.log("\nUsage: node scripts/wa-send-test.js 03001234567\n");
  process.exit(1);
}

(async () => {
  console.log(`\n[send-test] sending one test message to +${phone} ...`);
  const r = await wa.sendText(phone, "ASB test ✅ Agar ye message mila to hamara system WhatsApp bhej sakta hai.");
  if (r.ok) {
    console.log(`[send-test] ACCEPTED by Meta (message id ${r.wamid}).`);
    console.log("[send-test] Check that phone - the message should be there.\n");
    return;
  }
  const err = r.data?.error || {};
  console.log(`[send-test] REFUSED: (#${r.code || err.code || "?"}) ${err.message || "no message"}`);
  if (err.error_data?.details) console.log(`[send-test] details: ${err.error_data.details}`);
  if (String(r.code) === "131047") {
    console.log("[send-test] That phone has not messaged the business number in 24 hours.");
    console.log("[send-test] Send 'test' to 0333 8685289 from it, then run this again.");
  }
  console.log("");
  process.exit(2);
})().catch((e) => { console.error("[send-test] failed:", e.message); process.exit(1); });
