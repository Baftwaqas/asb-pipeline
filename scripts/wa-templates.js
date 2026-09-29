#!/usr/bin/env node
// ============================================================================
// ASB PIPELINE — scripts/wa-templates.js
//
// Submits ASB's three templates to Meta for approval, on the "Sasta Bazaar"
// WhatsApp account, and shows where each one stands.
//
//   node scripts/wa-templates.js            submit any that are missing, then show status
//   node scripts/wa-templates.js --status   only show status
//
// The wording comes from templates.js - the same file the server uses to fill
// them in, so what Meta approves is exactly what gets sent.
//
// A template already on the account is never touched: Meta does not allow
// editing an approved template's words, and re-submitting under the same name
// fails. To change wording, give it a new name in templates.js.
//
// Approval usually takes minutes, sometimes up to a day. Run with --status to
// check. A REJECTED template shows Meta's reason.
// ============================================================================

"use strict";

const { TEMPLATES, definition } = require("../templates");

const TOKEN = process.env.WHATSAPP_TOKEN || "";
const VERSION = process.env.GRAPH_VERSION || "v25.0";
// GRAPH_BASE only for local testing against a mock; unset in Render.
const BASE = process.env.GRAPH_BASE || `https://graph.facebook.com/${VERSION}`;
const WABA = process.env.WABA_ID || "1506772514186139"; // "Sasta Bazaar"
const STATUS_ONLY = process.argv.includes("--status");

// Meta requires an example image with any template that has an image header.
// This draws a plain sample in ASB's colours - a green band, a cream body with
// ruled rows like a rate list, a green footer - so the script needs no image
// file. The REAL poster is chosen each week in the inbox, at send time.
function samplePosterPng(width = 400, height = 500) {
  const zlib = require("zlib");
  const green = [15, 107, 58], cream = [246, 243, 234], rule = [216, 210, 194], pale = [217, 253, 211];
  const raw = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      let c = cream;
      if (y < 90 || y >= height - 60) c = green;
      else if (y > 30 && y < 50 && x > 24 && x < 260) c = pale;          // title bar
      else if ((y - 120) % 44 === 0 && x > 24 && x < width - 24) c = rule; // ruled rows
      else if ((y - 120) % 44 > 14 && (y - 120) % 44 < 28 && y > 120 && y < height - 80 &&
               ((x > 24 && x < 140) || (x > 200 && x < 290))) c = x < 140 ? [60, 60, 60] : green;
      const o = row + 1 + x * 3;
      raw[o] = c[0]; raw[o + 1] = c[1]; raw[o + 2] = c[2];
    }
  }
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0; // 8-bit RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw, { level: 9 })), chunk("IEND", Buffer.alloc(0)),
  ]);
}

async function graph(method, path, { params = {}, json, raw, headers = {} } = {}) {
  const url = new URL(path.startsWith("http") ? path : BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(json ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: json ? JSON.stringify(json) : raw,
  });
  const body = await res.json().catch(() => ({}));
  if (body.error) {
    const e = body.error;
    return { error: `(#${e.code}) ${e.error_user_msg || e.message}` };
  }
  if (!res.ok) return { error: `HTTP ${res.status} from Meta` };
  return body;
}

// Meta's "resumable upload": open a session on the app, send the bytes, get
// back a handle that a template definition can point at.
async function uploadSample() {
  const dbg = await graph("GET", "/debug_token", { params: { input_token: TOKEN } });
  const appId = dbg.data?.app_id;
  if (!appId) return { error: `could not find the app id: ${dbg.error || "no app_id"}` };

  const bytes = samplePosterPng();
  const session = await graph("POST", `/${appId}/uploads`, {
    params: { file_name: "asb-rate-list-sample.png", file_length: String(bytes.length), file_type: "image/png" },
  });
  if (!session.id) return { error: `upload session: ${session.error}` };

  const up = await graph("POST", `/${session.id}`, {
    raw: bytes,
    headers: { Authorization: `OAuth ${TOKEN}`, file_offset: "0", "Content-Type": "image/png" },
  });
  if (!up.h) return { error: `upload: ${up.error || "no handle returned"}` };
  return { handle: up.h };
}

async function existing() {
  const r = await graph("GET", `/${WABA}/message_templates`, {
    params: { fields: "name,status,category,language,rejected_reason", limit: "200" },
  });
  if (r.error) throw new Error(r.error);
  return r.data || [];
}

(async () => {
  if (!TOKEN) { console.log("WHATSAPP_TOKEN is not set."); process.exit(1); }
  console.log(`\n[templates] WhatsApp account ${WABA}\n`);

  let have = await existing();
  const has = (name) => have.some((t) => t.name === name);

  if (!STATUS_ONLY) {
    let handle = null;
    for (const t of Object.values(TEMPLATES)) {
      if (has(t.name)) { console.log(`  ${t.name.padEnd(18)} already on the account - left alone`); continue; }

      if (t.headerImage && !handle) {
        const up = await uploadSample();
        if (up.error) { console.log(`  ${t.name.padEnd(18)} NOT submitted - sample image ${up.error}`); continue; }
        handle = up.handle;
      }
      const r = await graph("POST", `/${WABA}/message_templates`, { json: definition(t, handle) });
      console.log(`  ${t.name.padEnd(18)} ${r.error ? "NOT submitted - " + r.error : "submitted (" + (r.status || "PENDING") + ", " + (r.category || t.category) + ")"}`);
    }
    have = await existing();
    console.log("");
  }

  console.log("  STATUS NOW");
  for (const t of Object.values(TEMPLATES)) {
    const found = have.find((x) => x.name === t.name);
    if (!found) { console.log(`  ${t.name.padEnd(18)} not on the account`); continue; }
    const reason = found.rejected_reason && found.rejected_reason !== "NONE" ? `  reason: ${found.rejected_reason}` : "";
    const moved = found.category !== t.category ? `  (Meta filed it as ${found.category})` : "";
    console.log(`  ${t.name.padEnd(18)} ${found.status.padEnd(9)} ${found.language}${moved}${reason}`);
  }
  console.log("\n[templates] done.\n");
})().catch((e) => { console.error("[templates] failed:", e.message); process.exit(1); });
