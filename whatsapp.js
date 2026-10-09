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
// Low-level POST to the messages endpoint — a STRUCTURED transport result.
//
// Never throws. Every result says what is actually known about the send:
//
//   outcome   'accepted'  HTTP 2xx with a message id (wamid)
//             'not_sent'  definitely nothing left the app, or Meta definitely
//                         refused delivery in a way that sent nothing and is
//                         safe to retry (131047: the 24h window is shut - retry
//                         as a TEMPLATE on the next attempt)
//             'refused'   Meta answered 4xx with a Graph error object
//             'ambiguous' the request may have reached Meta but no definite
//                         answer came back (timeout, reset, 5xx, unreadable body)
//   retryable whether an AUTOMATIC retry is safe (only when nothing was sent)
//   retryVia  'template' when only a template can succeed (131047)
//   phase     'precheck' | 'connect' | 'request' | 'response'
//
// The legacy fields { ok, wamid, data, code } are kept for every older caller
// (inbox, broadcast): ok is true only for 'accepted'.
// ---------------------------------------------------------------------------
const SEND_TIMEOUT_MS = Number(process.env.WA_SEND_TIMEOUT_MS || 20000);
// Errors raised before any request byte can have reached Meta.
const CONNECT_CODES = new Set([
  "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "UND_ERR_CONNECT_TIMEOUT",
  "CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
]);
// Graph rate limits: Meta answered and sent nothing; retrying later is safe.
const RATE_LIMIT_CODES = new Set([4, 80007, 130429, 131056]);
// Outside the 24h customer-service window: free text refused, nothing sent.
const WINDOW_CLOSED_CODE = 131047;

function result(r, t0) {
  const out = {
    outcome: r.outcome,
    retryable: Boolean(r.retryable),
    retryVia: r.retryVia || null,
    wamid: r.wamid || null,
    httpStatus: r.httpStatus ?? null,
    metaCode: r.metaCode ?? null,
    metaSubcode: r.metaSubcode ?? null,
    metaMessage: r.metaMessage ?? null,
    fbtraceId: r.fbtraceId ?? null,
    phase: r.phase,
    errorCode: r.errorCode ?? null,
    errorMessage: r.errorMessage ?? null,
    durationMs: Date.now() - t0,
  };
  // legacy shape
  out.ok = out.outcome === "accepted";
  out.data = r.data || (out.errorMessage || out.metaMessage ? { error: { message: out.errorMessage || out.metaMessage, code: out.metaCode } } : {});
  out.code = out.metaCode;
  return out;
}

async function postMessage(body) {
  const t0 = Date.now();
  if (!PHONE_NUMBER_ID || !WHATSAPP_TOKEN) {
    const msg = "PHONE_NUMBER_ID or WHATSAPP_TOKEN is not set";
    console.error(`[wa] ${msg}`);
    return result({ outcome: "not_sent", retryable: false, phase: "precheck", errorCode: "config_missing", errorMessage: msg }, t0);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`${BASE}/${PHONE_NUMBER_ID}/messages`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${WHATSAPP_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const code = e?.cause?.code || e?.code || e?.name || null;
    const connect = CONNECT_CODES.has(code);
    console.error(`[wa] transport error (${code || "?"}): ${e.message}`);
    return result({
      outcome: connect ? "not_sent" : "ambiguous", retryable: connect,
      phase: connect ? "connect" : "request", errorCode: code, errorMessage: e.message,
    }, t0);
  }

  let text = null;
  try {
    text = await res.text();
  } catch (e) {
    clearTimeout(timer);
    console.error(`[wa] response body unreadable (HTTP ${res.status}): ${e.message}`);
    return result({ outcome: "ambiguous", phase: "response", httpStatus: res.status,
                    errorCode: e?.cause?.code || e?.name || null, errorMessage: e.message }, t0);
  }
  clearTimeout(timer);
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (_) { data = null; }

  if (res.status >= 200 && res.status < 300) {
    const wamid = data?.messages?.[0]?.id || null;
    if (wamid) {
      console.log(`[wa] send OK ${wamid}`);
      return result({ outcome: "accepted", phase: "response", httpStatus: res.status, wamid, data }, t0);
    }
    console.error(`[wa] HTTP ${res.status} without a message id - outcome AMBIGUOUS`);
    return result({ outcome: "ambiguous", phase: "response", httpStatus: res.status, data: data || {},
                    errorMessage: "2xx without messages[0].id" }, t0);
  }

  const err = data && typeof data.error === "object" && data.error ? data.error : null;
  if (res.status >= 400 && res.status < 500 && err) {
    const code = Number(err.code);
    console.error(
      `[wa] send FAILED (${err.code}/${err.error_subcode || "-"}): ${err.message}` +
        (err.error_data?.details ? ` — ${err.error_data.details}` : "")
    );
    const common = { phase: "response", httpStatus: res.status, metaCode: Number.isFinite(code) ? code : null,
                     metaSubcode: err.error_subcode ?? null, metaMessage: err.message || null,
                     fbtraceId: err.fbtrace_id || null, data };
    if (code === WINDOW_CLOSED_CODE) return result({ ...common, outcome: "not_sent", retryable: true, retryVia: "template" }, t0);
    if (RATE_LIMIT_CODES.has(code)) return result({ ...common, outcome: "refused", retryable: true }, t0);
    return result({ ...common, outcome: "refused", retryable: false }, t0);
  }

  console.error(`[wa] HTTP ${res.status} without a Graph error object - outcome AMBIGUOUS`);
  return result({ outcome: "ambiguous", phase: "response", httpStatus: res.status, data: data || {},
                  metaCode: err ? Number(err.code) || null : null, metaMessage: err?.message || null,
                  errorMessage: `HTTP ${res.status}` }, t0);
}

// ---------------------------------------------------------------------------
// sendTemplate — an approved template. Works inside or outside the window.
//
// params is [{ name, value }] in the same order as the {{1}}..{{n}} in the
// approved body. The `name` is for your own readability; Meta only sees order.
// ---------------------------------------------------------------------------
async function sendTemplate(toPhone, templateName, params = [], opts = {}) {
  const components = [];

  // Image header (the rate-list poster). The id comes from uploadMedia().
  if (opts.headerImageId) {
    components.push({
      type: "header",
      parameters: [{ type: "image", image: { id: String(opts.headerImageId) } }],
    });
  }

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
// uploadMedia — puts an image on Meta's servers and returns its media id.
//
// The id can then be sent any number of times (a broadcast uploads the poster
// once, not once per customer). Meta keeps uploaded media for 30 days.
// Accepts JPEG and PNG up to 5 MB, which is Meta's limit for images.
// ---------------------------------------------------------------------------
async function uploadMedia(buffer, mimeType, filename = "poster.jpg") {
  if (!PHONE_NUMBER_ID || !WHATSAPP_TOKEN) {
    return { ok: false, id: null, error: "PHONE_NUMBER_ID or WHATSAPP_TOKEN is not set" };
  }
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", mimeType);
  form.append("file", new Blob([buffer], { type: mimeType }), filename);

  try {
    const res = await fetch(`${BASE}/${PHONE_NUMBER_ID}/media`, {
      method: "POST",
      headers: { Authorization: `Bearer ${WHATSAPP_TOKEN}` },
      body: form,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.id) {
      const err = data?.error || {};
      console.error(`[wa] media upload FAILED (${err.code}): ${err.message}`);
      return { ok: false, id: null, code: err.code || null, error: err.message || `HTTP ${res.status}` };
    }
    return { ok: true, id: data.id };
  } catch (e) {
    console.error("[wa] media upload transport error:", e.message);
    return { ok: false, id: null, error: e.message };
  }
}

// ---------------------------------------------------------------------------
// sendImage — an uploaded image, with an optional caption. Like sendText, only
// inside the 24h window; outside it, use the asb_rate_list template.
// ---------------------------------------------------------------------------
async function sendImage(toPhone, mediaId, caption = "") {
  return postMessage({
    messaging_product: "whatsapp",
    to: toPhone,
    type: "image",
    image: { id: String(mediaId), ...(caption ? { caption: String(caption).slice(0, 1024) } : {}) },
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
  postMessage,
  SEND_TIMEOUT_MS,
  sendTemplate,
  sendText,
  sendImage,
  uploadMedia,
  markRead,
  getMediaUrl,
  downloadMedia,
  verifySignature,
  graphVersion: GRAPH_VERSION,
  templateLang: TEMPLATE_LANG,
};
