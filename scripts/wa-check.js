#!/usr/bin/env node
// ============================================================================
// ASB PIPELINE — scripts/wa-check.js
//
// Why does sending fail with "(#200) permissions error"? This asks Meta,
// using the token Render already holds, and prints only what is safe to share:
//
//   * which system user the token belongs to
//   * what the token is allowed to do (scopes) and on which WhatsApp accounts
//   * which phone number PHONE_NUMBER_ID points at
//   * which apps receive that WhatsApp account's messages
//
// The token itself is NEVER printed - not even part of it.
//
//   node scripts/wa-check.js
// ============================================================================

"use strict";

const TOKEN = process.env.WHATSAPP_TOKEN || "";
const PHONE_ID = process.env.PHONE_NUMBER_ID || "";
const VERSION = process.env.GRAPH_VERSION || "v25.0";
const BASE = `https://graph.facebook.com/${VERSION}`;

async function get(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  const body = await res.json().catch(() => ({}));
  if (body.error) return { error: `(#${body.error.code}) ${body.error.message}` };
  if (!res.ok) return { error: `HTTP ${res.status} from Meta` };
  return body;
}

function line(label, value) {
  console.log(`  ${label.padEnd(22)} ${value}`);
}

(async () => {
  console.log("\n[wa-check] asking Meta about the token Render holds\n");
  if (!TOKEN) { console.log("  WHATSAPP_TOKEN is not set in Render."); process.exit(1); }
  if (!PHONE_ID) console.log("  PHONE_NUMBER_ID is not set in Render.");

  // 1. Who is this token?
  const me = await get("/me", { fields: "id,name" });
  console.log("TOKEN OWNER");
  line("name", me.error || me.name);
  line("id", me.id || "-");

  // 2. What may it do, and where?
  const dbg = await get("/debug_token", { input_token: TOKEN });
  const d = dbg.data || {};
  console.log("\nTOKEN PERMISSIONS");
  if (dbg.error) line("error", dbg.error);
  line("valid", d.is_valid);
  line("app id", d.app_id || "-");
  line("expires", d.expires_at ? (d.expires_at === 0 ? "never" : new Date(d.expires_at * 1000).toISOString()) : "never");
  line("scopes", (d.scopes || []).join(", ") || "-");
  const wabaIds = new Set();
  for (const g of d.granular_scopes || []) {
    line(g.scope, (g.target_ids || ["(all)"]).join(", "));
    if (g.scope.startsWith("whatsapp_business")) (g.target_ids || []).forEach((id) => wabaIds.add(id));
  }

  // 3. Which number are we sending from?
  console.log("\nPHONE_NUMBER_ID IN RENDER");
  if (PHONE_ID) {
    const ph = await get(`/${PHONE_ID}`, {
      fields: "display_phone_number,verified_name,status,platform_type,quality_rating,name_status",
    });
    line("id", PHONE_ID);
    if (ph.error) line("error", ph.error);
    else {
      line("number", ph.display_phone_number);
      line("name", ph.verified_name);
      line("status", ph.status);
      line("platform", ph.platform_type);
      line("quality", ph.quality_rating);
    }
  }

  // 4. Each WhatsApp account the token can reach: its numbers and the apps
  //    that receive its messages.
  for (const waba of wabaIds) {
    console.log(`\nWHATSAPP ACCOUNT ${waba}`);
    const info = await get(`/${waba}`, { fields: "name" });
    line("name", info.error || info.name);
    const nums = await get(`/${waba}/phone_numbers`, { fields: "id,display_phone_number,verified_name" });
    if (nums.error) line("numbers", nums.error);
    for (const n of nums.data || []) line("number", `${n.display_phone_number}  (id ${n.id}, ${n.verified_name})`);
    const subs = await get(`/${waba}/subscribed_apps`);
    if (subs.error) line("apps receiving", subs.error);
    for (const a of subs.data || []) {
      const app = a.whatsapp_business_api_data || a;
      line("app receiving msgs", `${app.name || "?"} (id ${app.id || "?"})`);
    }
  }
  console.log("\n[wa-check] done - nothing was changed.\n");
})().catch((e) => { console.error("[wa-check] failed:", e.message); process.exit(1); });
