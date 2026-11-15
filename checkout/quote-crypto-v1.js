// ASB ADR-002 - immutable quote authentication. DEV ONLY; no storefront wiring.
// The HMAC authenticates a quote, NOT a shopper or checkout permission.
"use strict";
const crypto = require("node:crypto");

class QuoteError extends Error {
  constructor(code, message) { super(message || code); this.code = code; }
}
function canonical(value) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new QuoteError("UNSAFE_QUOTE_NUMBER");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (!value || typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype)
    throw new QuoteError("UNSAFE_QUOTE_STRUCTURE");
  const keys = Object.keys(value).sort();
  if (keys.some(k => k === "__proto__" || k === "constructor" || k === "prototype" || value[k] === undefined))
    throw new QuoteError("UNSAFE_QUOTE_FIELD");
  return "{" + keys.map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
}
function payloadOf(signedQuote) {
  if (!signedQuote || typeof signedQuote !== "object" || Array.isArray(signedQuote))
    throw new QuoteError("INVALID_QUOTE");
  const {serverSignature, ...payload} = signedQuote;
  return payload;
}
function validSecret(secret) {
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32)
    throw new QuoteError("QUOTE_SECRET_REQUIRED");
  return secret;
}
function signatureFor(payload, secret) {
  return "sha256:" + crypto.createHmac("sha256", validSecret(secret))
    .update(canonical(payload), "utf8").digest("hex");
}
function signQuote(payload, secret) {
  if (Object.prototype.hasOwnProperty.call(payload, "serverSignature"))
    throw new QuoteError("ALREADY_SIGNED");
  return {...payload, serverSignature:signatureFor(payload,secret)};
}
function verifySignedQuote(signedQuote, secret) {
  if (typeof signedQuote?.serverSignature !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(signedQuote.serverSignature)) return false;
  const expected=Buffer.from(signatureFor(payloadOf(signedQuote),secret), "ascii");
  const provided=Buffer.from(signedQuote.serverSignature, "ascii");
  return expected.length === provided.length && crypto.timingSafeEqual(expected, provided);
}
module.exports={QuoteError,canonical,signQuote,verifySignedQuote,signatureFor};
