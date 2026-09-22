// ============================================================================
// ASB PIPELINE — whatsapp.js
// Direct Meta Cloud API client. No BSP, no AiSensy, no middleman.
//
// Exports:
//   sendTemplate(to, name, params)  — approved template (opens/uses any window)
//   sendText(to, body)              — free-form reply, 24h service window ONLY
//   markRead(wamid)                 — blue ticks on the customer's side
//   getMediaUrl(mediaId)            — resolve a media id to a download URL
//   downloadMedia(mediaId)          — fetch the bytes (voice notes, photos)
//   verifySignature(raw, header)    — Meta's X-Hub-Signature-256 check
//   graphVersion                    — the API version in use
//
// THE 24-HOUR RULE (this is the whole reason the inbox works the way it does):
//   When a customer messages you, a 24-hour "customer service window" opens.
//   Inside it you may send free-form text for free — no template, no charge.
//   Outside it, free-form sends are REJECTED (error 131047) and you must use
//   an approved template. sendText() does not check the window; the inbox layer
//   does, because it is the thing that knows when the last inbound arrived.
// ============================================================================

const crypto = require("crypto");

const GRAPH_VERSION = process.env.GRAPH_VERSION || "v25.0";
const PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "";
const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "";
const APP_SECRET = process.env.META_APP_SECRET || "";
const TEMPLATE_LANG = process.env.TEMPLATE_LANG || "en";

// GRAPH_BASE exists so this module can be pointed at a local mock during
// testing. Leave it unset in Render; it defaults to the real Graph API.
const BASE =
  process.env.GRAPH_BASE || `https://graph.facebook.com/${GRAPH_VERSION}`;

// ---------------------------------------------------------------------------
// Low-level POST to the messages endpoint.
//
// Meta's errors are the useful part, so they are always returned rather than
// thrown. Callers log them against the order; nothing here crashes a webhook.
// ---------------------------------------------------------------------------
async function postMessage(body) {
  if (!PHONE_NUMBER_ID || !WHATSAPP_TOKEN) {
    const msg = "PHONE_NUMBER_ID or WHATSAPP_TOKEN is not set";
    console.error(`[wa] ${msg}`);
    return { ok: false, wamid: null, data: { error: { message: msg } } };
  }

  let res, data;
  try {
    res = await fetch(`${BASE}/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    data = await res.json();
  } catch (e) {
    // Network-level failure — Render cold start, DNS, Meta having a moment.
    console.error("[wa] transport error:", e.message);
    return { ok: false, wamid: null, data: { error: { message: e.message } } };
  }

  const wamid = data?.messages?.[0]?.id || null;

  if (!res.ok) {
    const err = data?.error || {};
    console.error(
      `[wa] send FAILED (${err.code}/${err.error_subcode || "-"}): ${err.message}` +
        (err.error_data?.details ? ` — ${err.error_data.details}` : "")
    );
  } else {
    console.log(`[wa] send OK ${wamid}`);
  }

  return { ok: res.ok, wamid, data, code: data?.error?.code || null };
}

// ---------------------------------------------------------------------------
// sendTemplate — an approved template. Works inside or outside the window.
//
// params is [{ name, value }] in the same order as the {{1}}..{{n}} in the
// approved body. The `name` is for your own readability; Meta only sees order.
// ---------------------------------------------------------------------------
async function sendTemplate(toPhone, templateName, params = [], opts = {}) {
  const components = [];

  if (params.length) {
    components.push({
      type: "body",
      parameters: params.map((p) => ({ type: "text", text: String(p.value ?? "") })),
    });
  }
  if (opts.buttonParams?.length) {
    opts.buttonParams.forEach((p, i) => {
      components.push({
        type: "button",
        sub_type: p.subType || "url",
        index: String(i),
        parameters: [{ type: "text", text: String(p.value ?? "") }],
      });
    });
  }

  return postMessage({
    messaging_product: "whatsapp",
    to: toPhone,
    type: "template",
    template: {
      name: templateName,
      language: { code: opts.lang || TEMPLATE_LANG },
      ...(components.length ? { components } : {}),
    },
  });
}

// ---------------------------------------------------------------------------
// sendText — free-form message. ONLY valid inside the 24h service window.
//
// If the window is shut Meta returns 131047 ("Re-engagement message"). That is
// not a bug to retry; it means you need a template. The inbox surfaces this as
// a closed window before you can type, so it should rarely fire — but a window
// can expire between page load and send, so callers still handle it.
// ---------------------------------------------------------------------------
async function sendText(toPhone, bodyText, opts = {}) {
  return postMessage({
    messaging_product: "whatsapp",
    to: toPhone,
    type: "text",
    text: {
      body: String(bodyText).slice(0, 4096),
      preview_url: opts.previewUrl === true,
    },
    ...(opts.replyToWamid
      ? { context: { message_id: opts.replyToWamid } }
      : {}),
  });
}

// ---------------------------------------------------------------------------
// markRead — gives the customer blue ticks so they know a human saw it.
// Cheap courtesy, and it is free. Failures are swallowed on purpose: a missing
// read receipt must never break the inbox.
// ---------------------------------------------------------------------------
async function markRead(wamid) {
  if (!wamid) return { ok: false };
  const r = await postMessage({
    messaging_product: "whatsapp",
    status: "read",
    message_id: wamid,
  });
  return { ok: r.ok };
}

// ---------------------------------------------------------------------------
// MEDIA
//
// Inbound photos and voice notes arrive as an id, not bytes. Resolving it is
// two hops: id -> short-lived URL, then a GET on that URL WITH the bearer
// token (the URL alone is not enough — Meta returns 401 without the header).
// URLs expire in about 5 minutes, so never store them; store the id.
// ---------------------------------------------------------------------------
async function getMediaUrl(mediaId) {
  const res = await fetch(`${BASE}/${mediaId}`, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });
  const data = await res.json();
  if (!res.ok) {
    console.error("[wa] media lookup failed:", JSON.stringify(data));
    return null;
  }
  return { url: data.url, mimeType: data.mime_type, sha256: data.sha256, size: data.file_size };
}

async function downloadMedia(mediaId) {
  const meta = await getMediaUrl(mediaId);
  if (!meta?.url) return null;

  const res = await fetch(meta.url, {
    headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
  });
  if (!res.ok) {
    console.error(`[wa] media download failed: ${res.status}`);
    return null;
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  return { buffer, mimeType: meta.mimeType, size: buffer.length };
}

// ---------------------------------------------------------------------------
// verifySignature — Meta signs every webhook body with your APP SECRET.
//
// This is the gap AiSensy was papering over. Without it, the webhook URL is an
// open write endpoint: anyone who learns it can POST a fabricated "inbound
// message" and it lands in whatsapp_messages looking like a real customer.
//
// Compare against the RAW bytes. Any re-serialisation of the parsed JSON will
// differ from what Meta signed (key order, unicode escaping) and every check
// will fail — which is why server.js mounts express.raw() on this path.
//
// Returns false when APP_SECRET is unset, so a missing env var fails closed.
// ---------------------------------------------------------------------------
function verifySignature(rawBody, signatureHeader) {
  if (!APP_SECRET) {
    console.error("[wa] META_APP_SECRET not set — rejecting webhook");
    return false;
  }
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;

  const expected =
    "sha256=" +
    crypto.createHmac("sha256", APP_SECRET).update(rawBody).digest("hex");

  try {
    return crypto.timingSafeEqual(
      Buffer.from(expected),
      Buffer.from(signatureHeader)
    );
  } catch (_) {
    // Different lengths — timingSafeEqual throws rather than returning false.
    return false;
  }
}

module.exports = {
  sendTemplate,
  sendText,
  markRead,
  getMediaUrl,
  downloadMedia,
  verifySignature,
  graphVersion: GRAPH_VERSION,
  templateLang: TEMPLATE_LANG,
};
