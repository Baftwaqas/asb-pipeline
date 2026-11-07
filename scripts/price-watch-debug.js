#!/usr/bin/env node
// Shows how a product page labels its prices, so the price reader can be
// taught to take the price a customer actually pays. Reads one page once.
//   node scripts/price-watch-debug.js https://www.daraz.pk/products/....html
"use strict";
const PW = require("../bhao/price-watch");
const url = process.argv[2];
if (!url) { console.error("usage: node scripts/price-watch-debug.js PRODUCT_URL"); process.exit(1); }
fetch(url, { headers: { "User-Agent": PW.USER_AGENT } }).then((r) => r.text()).then((h) => {
  const seen = new Set();
  const re = /"(\w*[Pp]rice\w*)"\s*:\s*(\{[^{}]{0,160}\}|"[^"]{0,60}"|[\d.]+)/g;
  for (const m of h.matchAll(re)) { seen.add(m[1] + " = " + m[2]); if (seen.size >= 60) break; }
  console.log([...seen].join("\n") || "(no price labels found)");
  console.log("\nreader says:", JSON.stringify(PW.extractPrice(h)));
}).catch((e) => { console.error("failed:", e.message); process.exit(1); });
