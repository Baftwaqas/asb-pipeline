// ============================================================================
// qtywords.js — spoken Urdu fractions, settled in code before the AI reads an
// order (founder's test, 20 Nov 2026: "saray 2 kilo lehson" came back as 2 kg).
//
//   sawa N   = N + 1/4      ("sawa do kilo" = 2.25)
//   saarhe N = N + 1/2      (saray / sarhe / saade / sadhe ... "saray 2" = 2.5)
//   paune N  = N - 1/4      ("paune 2" = 1.75)
//   dedh     = 1.5,  dhai = 2.5
// Number words (ek, do, teen ... das) are understood after these words.
// ============================================================================
"use strict";

const NUMW = {
  ek: 1, aik: 1, ik: 1, do: 2, teen: 3, tin: 3, char: 4, chaar: 4, paanch: 5, panch: 5, panj: 5,
  chay: 6, chhe: 6, che: 6, saat: 7, sat: 7, aath: 8, ath: 8, nau: 9, das: 10, dus: 10,
};
const NUM = String.raw`(\d+(?:\.\d+)?|` + Object.keys(NUMW).join("|") + ")";
const value = (x) => (NUMW[String(x).toLowerCase()] ?? Number(x));
const fmt = (n) => String(Math.round(n * 100) / 100);

const SAWA = new RegExp(String.raw`\b(?:sawa|sava|swa)\s+` + NUM + String.raw`\b`, "gi");
const SAARHE = new RegExp(String.raw`\b(?:saa?r?h?a?y|saa?rh?e|saa?rhey|saa?dh?e|saa?ray)\s+` + NUM + String.raw`\b`, "gi");
const PAUNE = new RegExp(String.raw`\b(?:paune|pone|pauney|pauny)\s+` + NUM + String.raw`\b`, "gi");
const DEDH = /\b(?:dedh|deedh|derh|dairh|dehd)\b/gi;
const DHAI = /\b(?:dhai|dhaai|adhai|arhai|arhaai|dhayi|dhaee)\b/gi;

function normaliseQty(text) {
  return String(text || "")
    .replace(SAWA, (_, n) => fmt(value(n) + 0.25))
    .replace(SAARHE, (_, n) => fmt(value(n) + 0.5))
    .replace(PAUNE, (_, n) => fmt(value(n) - 0.25))
    .replace(DEDH, "1.5")
    .replace(DHAI, "2.5");
}

module.exports = { normaliseQty };
