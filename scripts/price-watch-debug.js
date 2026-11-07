#!/usr/bin/env node
// Shows how a product page labels its prices, so the price reader can be
// taught to take the price a customer actually pays. Reads one page once.
//   node scripts/price-watch-debug.js https://www.daraz.pk/products/....html [2999]
// With a second argument, also shows where that number appears in the page.
"use strict";
const PW = require("../bhao/price-watch");
const url = process.argv[2];
if (!url) { console.error("usage: node scripts/price-watch-debug.js PRODUCT_URL"); process.exit(1); }
if (process.argv.includes("--render")) {
  // what a customer's browser shows, via Playwright
  (async () => {
    const { chromium } = require("playwright");
    const browser = await chromium.launch();
    try { console.log("rendered reader says:", JSON.stringify(await PW.checkWatchRendered({ url }, { browser, fetchImpl: fetch }))); }
    finally { await browser.close(); }
  })().catch((e) => { console.error("failed:", e.message); process.exit(1); });
  return;
}
fetch(url, { headers: { "User-Agent": PW.USER_AGENT } }).then((r) => r.text()).then((h) => {
  const seen = new Set();
  const re = /"(\w*[Pp]rice\w*)"\s*:\s*(\{[^{}]{0,160}\}|"[^"]{0,60}"|[\d.]+)/g;
  for (const m of h.matchAll(re)) { seen.add(m[1] + " = " + m[2]); if (seen.size >= 60) break; }
  console.log([...seen].join("\n") || "(no price labels found)");
  const n = process.argv[3];
  if (n) {
    const forms = [n, Number(n).toLocaleString("en-US")];
    let shown = 0;
    for (const f of forms) {
      let i = -1;
      while ((i = h.indexOf(f, i + 1)) !== -1 && shown < 15) {
        console.log("\n..." + h.slice(Math.max(0, i - 120), i + 60).replace(/\s+/g, " ") + "...");
        shown++;
      }
    }
    console.log(shown ? "" : "\n(" + n + " does not appear anywhere in the page HTML)");
    console.log("page size:", h.length, "characters");
  }
  console.log("\nreader says:", JSON.stringify(PW.extractPrice(h)));
}).catch((e) => { console.error("failed:", e.message); process.exit(1); });
