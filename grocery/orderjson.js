// ============================================================================
// ASB PIPELINE — grocery/orderjson.js
//
// The ONE parser for Shopify webhook bodies on the persistence path (capture,
// Community classification, the grocery apply, operator tools).
//
// Shopify ids are 64-bit. JSON.parse turns any integer beyond 2^53 into a
// nearby, WRONG number. This parser keeps every safe number exactly as
// JSON.parse would (so ordinary payloads are unchanged, byte for byte) and
// turns an UNSAFE integer into its exact decimal text. Every consumer already
// uses String(id) / numericId(id), so the exact id flows through unchanged.
//
// On a Node without JSON.parse source access, an unsafe integer is refused
// (the Shopify webhook then answers 503) rather than silently corrupted.
// ============================================================================

"use strict";

const { HAS_SOURCE } = require("./fingerprint");

class UnsafeIntegerError extends Error {}

function parseOrderJson(text) {
  const s = Buffer.isBuffer(text) ? text.toString("utf8") : String(text);
  return JSON.parse(s, function (key, value, ctx) {
    if (typeof value !== "number" || !Number.isInteger(value) || Number.isSafeInteger(value)) return value;
    if (HAS_SOURCE && ctx && typeof ctx.source === "string" && /^-?\d+$/.test(ctx.source)) return ctx.source;
    throw new UnsafeIntegerError(`integer "${key}" exceeds 2^53 and cannot be parsed exactly on this Node`);
  });
}

module.exports = { parseOrderJson, UnsafeIntegerError };
