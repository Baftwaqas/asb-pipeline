// ============================================================================
// ASB PIPELINE — grocery/fingerprint.js
//
// The COMMERCE FINGERPRINT of a Shopify orders/create payload: a hash of every
// raw Shopify field that ASB persistence reads, normalised for syntax only.
// Two deliveries of the same Shopify order with the same fingerprint are the
// same order; a different fingerprint is a loud anomaly (never re-applied).
//
// VERSIONS ARE FROZEN. A stored fingerprint is never recomputed under a newer
// version: a duplicate is fingerprinted at the version of the source it is
// compared with (computeAt(raw, source.version)). Changing anything here means
// adding version 2 next to version 1, never editing version 1.
//
// Inputs are RAW fields only. Nothing derived (normalizePhone, cycle, product
// match) is included, because that code may change while a fingerprint may not.
// ============================================================================

"use strict";

const crypto = require("crypto");

// ---------------------------------------------------------------------------
// Lossless parsing: numbers keep their exact source text (Shopify ids can
// exceed 2^53). Without reviver source access, unsafe integers are refused.
// ---------------------------------------------------------------------------
const NUM = Symbol("num");
const HAS_SOURCE = (() => {
  try {
    let seen = null;
    JSON.parse("1", (k, v, ctx) => { seen = ctx && ctx.source; return v; });
    return seen === "1";
  } catch (_) { return false; }
})();

class FingerprintError extends Error {}

function parseLossless(rawText) {
  return JSON.parse(rawText, function (key, value, ctx) {
    if (typeof value !== "number") return value;
    if (HAS_SOURCE && ctx && typeof ctx.source === "string") return { [NUM]: ctx.source };
    if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
      throw new FingerprintError(`integer ${key} is beyond 2^53 and this Node cannot parse it losslessly`);
    }
    return { [NUM]: String(value) };
  });
}

const isNum = (v) => v !== null && typeof v === "object" && NUM in v;
const scalarText = (v) => (v === null || v === undefined ? null
  : isNum(v) ? v[NUM] : typeof v === "string" ? v : typeof v === "boolean" ? String(v) : null);

// ---------------------------------------------------------------------------
// Version 1 normalisers (frozen)
// ---------------------------------------------------------------------------
function textV1(v) {
  const s = scalarText(v);
  if (s === null) return null;
  const t = s.normalize("NFC").replace(/\r\n?/g, "\n").trim();
  return t === "" ? null : t;
}

function upperV1(v) {
  const t = textV1(v);
  return t === null ? null : t.toUpperCase();
}

function idV1(v) {
  const t = textV1(v);
  if (t === null) return null;
  if (/^[0-9]+$/.test(t)) return t.replace(/^0+(?=\d)/, "");
  return t;
}

// "2" / "2.0" / "2.50" -> "2" / "2" / "2.5"
function decimalV1(v, minDp) {
  const t = textV1(v);
  if (t === null) return null;
  const m = /^([+-]?)(\d*)(?:\.(\d*))?$/.exec(t);
  if (!m || (m[2] === "" && (m[3] || "") === "")) return t;   // not a plain decimal: keep text
  const sign = m[1] === "-" ? "-" : "";
  let int = (m[2] || "0").replace(/^0+(?=\d)/, "");
  let frac = (m[3] || "").replace(/0+$/, "");
  while (frac.length < minDp) frac += "0";
  const out = frac ? `${int}.${frac}` : int;
  return /^0(\.0*)?$/.test(out) ? out : sign + out;
}

function timeV1(v) {
  const t = textV1(v);
  if (t === null) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?(Z|([+-])(\d{2}):?(\d{2}))$/.exec(t);
  if (!m) return t;
  let ms = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  if (m[8] !== "Z") {
    const off = (+m[10] * 60 + +m[11]) * 60000;
    ms += m[9] === "+" ? -off : off;
  }
  const iso = new Date(ms).toISOString().slice(0, 19);
  const frac = (m[7] || "").replace(/0+$/, "");
  return frac ? `${iso}.${frac}Z` : `${iso}Z`;
}

function obj(v) { return v && typeof v === "object" && !Array.isArray(v) && !isNum(v) ? v : {}; }

function canonicalV1(payload) {
  const o = obj(payload);
  const c = obj(o.customer);
  const a = obj(o.shipping_address);
  const lines = (Array.isArray(o.line_items) ? o.line_items : []).map((raw) => {
    const l = obj(raw);
    return {
      id: idV1(l.id),
      product_id: idV1(l.product_id),
      variant_id: idV1(l.variant_id),
      sku: textV1(l.sku),
      title: textV1(l.title),
      variant_title: textV1(l.variant_title),
      vendor: textV1(l.vendor),
      quantity: decimalV1(l.quantity, 0),
      price: decimalV1(l.price, 2),
    };
  });
  lines.sort((x, y) => {
    const xi = x.id !== null && /^[0-9]+$/.test(x.id);
    const yi = y.id !== null && /^[0-9]+$/.test(y.id);
    if (xi && yi) { const d = BigInt(x.id) - BigInt(y.id); return d < 0n ? -1 : d > 0n ? 1 : 0; }
    if (xi) return -1;
    if (yi) return 1;
    const sx = jcs(x), sy = jcs(y);
    return sx < sy ? -1 : sx > sy ? 1 : 0;
  });
  return {
    v: "1",
    order: {
      id: idV1(o.id),
      name: textV1(o.name),
      created_at: timeV1(o.created_at),
      currency: upperV1(o.currency),
      presentment_currency: upperV1(o.presentment_currency),
      note: textV1(o.note),
      phone: textV1(o.phone),
    },
    customer: {
      id: idV1(c.id),
      first_name: textV1(c.first_name),
      last_name: textV1(c.last_name),
      phone: textV1(c.phone),
    },
    shipping_address: {
      first_name: textV1(a.first_name),
      last_name: textV1(a.last_name),
      phone: textV1(a.phone),
      address1: textV1(a.address1),
      address2: textV1(a.address2),
    },
    line_items: lines,
  };
}

// RFC 8785 for a document whose leaves are only strings and null.
function jcs(v) {
  if (v === null) return "null";
  if (typeof v === "string") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(jcs).join(",")}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${jcs(v[k])}`).join(",")}}`;
}

// ---------------------------------------------------------------------------
// Registry of frozen versions
// ---------------------------------------------------------------------------
const VERSIONS = { 1: canonicalV1 };
let CURRENT = 1;

/** Fingerprint raw request text at an explicit version. */
function computeAt(rawText, version) {
  const fn = VERSIONS[version];
  if (!fn) throw new FingerprintError(`unknown commerce fingerprint version ${version}`);
  const canonical = fn(parseLossless(String(rawText)));
  const hash = crypto.createHash("sha256").update(jcs(canonical), "utf8").digest("hex");
  return { version: Number(version), hash, canonical };
}

/** Fingerprint at the current version (new sources). */
function compute(rawText) { return computeAt(rawText, CURRENT); }

function currentVersion() { return CURRENT; }

/** Tests only: register a frozen version and/or move CURRENT. */
function _testRegister(version, fn, { makeCurrent = false } = {}) {
  if (fn) VERSIONS[version] = fn;
  if (makeCurrent) CURRENT = version;
}

/** Paths whose values differ between two canonical documents (for alerts). */
function diffPaths(a, b, prefix = "") {
  const out = [];
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push(prefix || "(root)");
    return out;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    const n = Math.max(a.length || 0, b.length || 0);
    for (let i = 0; i < n; i++) out.push(...diffPaths(a[i] ?? null, b[i] ?? null, `${prefix}[${i}]`));
    return out;
  }
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    out.push(...diffPaths(a[k] ?? null, b[k] ?? null, prefix ? `${prefix}.${k}` : k));
  }
  return out;
}

module.exports = {
  compute, computeAt, currentVersion, canonicalV1, jcs, diffPaths, parseLossless,
  FingerprintError, HAS_SOURCE, VERSIONS, _testRegister,
  _normalisers: { textV1, idV1, decimalV1, timeV1 },
};
