#!/usr/bin/env node
// ============================================================================
// ASB PIPELINE — scripts/wa-connect.js
//
// Connects our app (ASB Pipeline) to the WhatsApp account that holds the
// business number. Until an app is connected ("subscribed") to a WhatsApp
// account, Meta refuses to let it send from that account's numbers:
//
//   (#200) You do not have the necessary permissions to send messages
//          on behalf of this WhatsApp Business Account
//
// Connecting also makes Meta deliver incoming customer messages to our server
// - IN ADDITION to AiSensy, not instead of it. AiSensy keeps working.
//
// Safe to run twice. It first checks the number in Render really belongs to
// this WhatsApp account, and stops if it does not.
//
//   node scripts/wa-connect.js              (the "Sasta Bazaar" account)
//   node scripts/wa-connect.js <waba-id>
// ============================================================================

"use strict";

const TOKEN = process.env.WHATSAPP_TOKEN || "";
const PHONE_ID = process.env.PHONE_NUMBER_ID || "";
const VERSION = process.env.GRAPH_VERSION || "v25.0";
const BASE = `https://graph.facebook.com/${VERSION}`;
const WABA = process.argv[2] || "1506772514186139"; // "Sasta Bazaar", owned by Apna Sasta Bazaar

async function call(method, path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { method, headers: { Authorization: `Bearer ${TOKEN}` } });
  const body = await res.json().catch(() => ({}));
  if (body.error) return { error: `(#${body.error.code}) ${body.error.message}` };
  if (!res.ok) return { error: `HTTP ${res.status} from Meta` };
  return body;
}

const appsOf = (r) => (r.data || []).map((a) => {
  const x = a.whatsapp_business_api_data || a;
  return `${x.name || "?"} (id ${x.id || "?"})`;
});

(async () => {
  console.log(`\n[connect] WhatsApp account ${WABA}`);

  // 1. Make sure the number Render sends from lives in this account.
  const nums = await call("GET", `/${WABA}/phone_numbers`, { fields: "id,display_phone_number,verified_name" });
  if (nums.error) { console.log(`[connect] cannot read this account: ${nums.error}`); process.exit(1); }
  for (const n of nums.data || []) console.log(`  number: ${n.display_phone_number} (${n.verified_name}, id ${n.id})`);
  if (!(nums.data || []).some((n) => n.id === PHONE_ID)) {
    console.log(`[connect] STOP - PHONE_NUMBER_ID ${PHONE_ID} is not in this account. Nothing changed.`);
    process.exit(1);
  }

  // 2. Who receives this account's messages now?
  const before = await call("GET", `/${WABA}/subscribed_apps`);
  console.log(`  apps connected before: ${before.error || appsOf(before).join(", ") || "none"}`);

  // 3. Connect our app.
  const sub = await call("POST", `/${WABA}/subscribed_apps`);
  console.log(`[connect] connecting ASB Pipeline ... ${sub.error ? "FAILED " + sub.error : "ok"}`);

  const after = await call("GET", `/${WABA}/subscribed_apps`);
  console.log(`  apps connected after:  ${after.error || appsOf(after).join(", ") || "none"}`);

  // 4. Which message templates does this account have? (read only)
  const tpl = await call("GET", `/${WABA}/message_templates`, { fields: "name,status,language,category", limit: "100" });
  console.log("\n[connect] templates on this account:");
  if (tpl.error) console.log(`  ${tpl.error}`);
  for (const t of tpl.data || []) console.log(`  ${t.name.padEnd(32)} ${t.status.padEnd(10)} ${t.language.padEnd(6)} ${t.category}`);
  if (!tpl.error && !(tpl.data || []).length) console.log("  none");

  console.log("\n[connect] done.\n");
})().catch((e) => { console.error("[connect] failed:", e.message); process.exit(1); });
