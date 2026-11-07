// ============================================================================
// ASB PIPELINE — bhao/price-watch.js
// Automatic competitor price checks for Bhao Tao, and the facts Seth Ji may
// use from them. PURE except checkWatch(), whose network access is injected.
//
// Rules (founder decision 7 Nov: stay ahead, never bluff):
//   * only product pages a person listed as the SAME item; never search or
//     catalogue pages; one polite request per page; identifies itself;
//   * the site's robots.txt is obeyed; a block is recorded, never evaded;
//   * a price is read only from structured data on the page (schema.org
//     JSON-LD, price meta tags, the marketplace's own embedded price data);
//     two different readings on one page = parse_failed, not a guess;
//   * Seth Ji may quote a competitor only from an OK check younger than
//     maxAgeHours whose price is HIGHER than ours; if ours is higher, that
//     is an alert for the founder, never a line for the customer.
// ============================================================================
"use strict";

const USER_AGENT = "ASB-PriceCheck/1.0 (+https://apnasastabazaar.com; price check of listed product pages)";

// ---------------------------------------------------------------------------
// robots.txt
// ---------------------------------------------------------------------------
/** Rules that apply to us: our own group if present, else the "*" group. */
function parseRobots(text) {
  const groups = [];
  let cur = null, lastWasAgent = false;
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase(), val = m[2].trim();
    if (key === "user-agent") {
      if (!lastWasAgent || !cur) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(val.toLowerCase());
      lastWasAgent = true;
    } else {
      lastWasAgent = false;
      if (cur && (key === "allow" || key === "disallow")) cur.rules.push({ allow: key === "allow", path: val });
    }
  }
  const mine = groups.filter((g) => g.agents.some((a) => a !== "*" && "asb-pricecheck".startsWith(a)));
  const star = groups.filter((g) => g.agents.includes("*"));
  return (mine.length ? mine : star).flatMap((g) => g.rules);
}

function ruleMatches(rulePath, path) {
  if (rulePath === "") return false; // "Disallow:" with nothing = allow all
  const anchored = rulePath.endsWith("$");
  const body = anchored ? rulePath.slice(0, -1) : rulePath;
  const re = new RegExp("^" + body.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + (anchored ? "$" : ""));
  return re.test(path);
}

/** Longest matching rule wins; on a tie, Allow wins (RFC 9309). */
function robotsAllows(robotsText, pathWithQuery) {
  let best = null;
  for (const r of parseRobots(robotsText)) {
    if (!ruleMatches(r.path, pathWithQuery)) continue;
    const len = r.path.replace(/\$$/, "").length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { len, allow: r.allow };
  }
  return best ? best.allow : true;
}

// ---------------------------------------------------------------------------
// Reading a price from a product page
// ---------------------------------------------------------------------------
function toPaisa(v) {
  const s = String(v ?? "").replace(/[,\s]/g, "").replace(/^(rs\.?|pkr)/i, "");
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const p = Number(m[1]) * 100 + Number((m[2] || "").padEnd(2, "0"));
  return p > 0 ? p : null;
}

function jsonLdProducts(html) {
  const out = [];
  for (const m of html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    let data;
    try { data = JSON.parse(m[1].trim()); } catch { continue; }
    const walk = (x) => {
      if (Array.isArray(x)) return x.forEach(walk);
      if (!x || typeof x !== "object") return;
      const t = [].concat(x["@type"] || []).map(String);
      if (t.includes("Product")) out.push(x);
      if (x["@graph"]) walk(x["@graph"]);
    };
    walk(data);
  }
  return out;
}

/**
 * The price on a product page, or why there is none.
 * Returns { status: "ok", pricePaisa, via } | { status: "unavailable" | "parse_failed", via? }.
 */
function extractPrice(html) {
  const page = String(html || "");
  const strategies = [];

  // 1. schema.org Product -> offers.price / lowPrice, with availability
  const ld = jsonLdProducts(page);
  if (ld.length) {
    const prices = [], unavailable = [];
    for (const p of ld) {
      for (const o of [].concat(p.offers || [])) {
        const avail = String(o.availability || "");
        if (/OutOfStock|SoldOut|Discontinued/i.test(avail)) { unavailable.push(true); continue; }
        const v = toPaisa(o.price ?? o.lowPrice);
        if (v) prices.push(v);
      }
    }
    if (!prices.length && unavailable.length) return { status: "unavailable", via: "json-ld" };
    strategies.push({ via: "json-ld", prices });
  }
  // 2. price meta tags
  const meta = [...page.matchAll(/<meta[^>]+(?:property|itemprop|name)=["'](?:product:price:amount|og:price:amount|price)["'][^>]*content=["']([^"']+)["']/gi)]
    .map((m) => toPaisa(m[1])).filter(Boolean);
  strategies.push({ via: "meta", prices: meta });
  // 3. the marketplace's own embedded product data (Daraz-style)
  const embedded = [
    ...[...page.matchAll(/"salePrice"\s*:\s*\{[^{}]*?"value"\s*:\s*"?([\d.,]+)"?/g)].map((m) => toPaisa(m[1])),
    // NOT "pdt_price": on Daraz it is the crossed-out list price (live test,
    // 7 Nov: pdt_price Rs 3,899 while the customer pays Rs 2,999).
  ].filter(Boolean);
  strategies.push({ via: "embedded", prices: embedded });

  for (const s of strategies) {
    const distinct = [...new Set(s.prices)];
    if (distinct.length === 1) return { status: "ok", pricePaisa: distinct[0], via: s.via };
    if (distinct.length > 1) return { status: "parse_failed", via: s.via + ": " + distinct.length + " different prices" };
  }
  // No guessing from page text: a live Daraz page contains "out of stock"
  // in its scripts while the item is on sale (7 Nov). Unreadable is unreadable.
  return { status: "parse_failed", via: "no structured price" };
}

// ---------------------------------------------------------------------------
// One check (the only function that touches the network)
// ---------------------------------------------------------------------------
async function checkWatch(watch, { fetchImpl, robotsCache = new Map(), timeoutMs = 15000 }) {
  let url;
  try { url = new URL(watch.url); } catch { return { status: "fetch_failed", via: "invalid url" }; }
  if (url.protocol !== "https:") return { status: "fetch_failed", via: "not https" };
  const get = async (u) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      return await fetchImpl(u, { headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
                                  redirect: "follow", signal: ctl.signal });
    } finally { clearTimeout(t); }
  };
  try {
    if (!robotsCache.has(url.origin)) {
      const r = await get(url.origin + "/robots.txt");
      robotsCache.set(url.origin, r.ok ? await r.text() : ""); // no robots file = no rules
    }
    if (!robotsAllows(robotsCache.get(url.origin), url.pathname + url.search))
      return { status: "blocked_by_robots", via: "robots.txt" };
    const res = await get(url.href);
    if (!res.ok) return { status: "http_error", httpStatus: res.status };
    const r = extractPrice(await res.text());
    return { ...r, httpStatus: res.status };
  } catch (e) {
    return { status: "fetch_failed", via: e.name === "AbortError" ? "timeout" : "network" };
  }
}

// ---------------------------------------------------------------------------
// What Seth Ji may say, and what the founder must hear.
// latest: rows of competitor_price_latest for one item.
// ---------------------------------------------------------------------------
function competitorFacts({ latest, ourUnitPaisa, now, maxAgeHours = 48 }) {
  const facts = [], alerts = [], stale = [];
  const byMarket = new Map();
  for (const row of latest || []) {
    if (!row.active) continue;
    const age = row.checked_at ? (now - new Date(row.checked_at)) / 3600e3 : Infinity;
    if (row.status !== "ok" || age > maxAgeHours) { stale.push({ marketplace: row.marketplace, url: row.url, status: row.status || "never_checked" }); continue; }
    const p = Number(row.price_paisa);
    if (p <= ourUnitPaisa) { alerts.push({ marketplace: row.marketplace, url: row.url, theirPaisa: p, ourPaisa: ourUnitPaisa }); continue; }
    // several listings on one marketplace: quote the CHEAPEST, the fair comparison
    const prev = byMarket.get(row.marketplace);
    if (!prev || p < prev.pricePaisa) byMarket.set(row.marketplace, { marketplace: row.marketplace, pricePaisa: p, checkedAt: row.checked_at });
  }
  // a marketplace with any listing at or below our price is never quoted
  for (const a of alerts) byMarket.delete(a.marketplace);
  facts.push(...byMarket.values());
  return { facts, alerts, stale };
}

// ---------------------------------------------------------------------------
// Rendered pages. Some marketplaces (Daraz) put only the crossed-out list
// price in the HTML and fill in the price a customer pays with JavaScript.
// For those, the page is opened in a real headless browser - exactly what a
// customer's browser does - and the CURRENT price is read from the page's
// own price element. Not a workaround: if the site shows a challenge or
// captcha instead of the product, that is recorded as blocked and left.
// ---------------------------------------------------------------------------
const RENDERED_SELECTORS = Object.freeze({
  // Daraz product page: current price vs crossed-out list price
  "daraz.pk": { current: ".pdp-price_type_normal", challenge: "#nocaptcha, .nc_wrapper, #baxia-dialog-content, iframe[src*='captcha']" },
});

/** Read the current price from text found in the price element(s). */
function priceFromRenderedTexts(texts) {
  const vals = [...new Set(texts.map((t) => toPaisa(String(t).trim())).filter(Boolean))];
  if (vals.length === 1) return { status: "ok", pricePaisa: vals[0], via: "rendered" };
  if (vals.length > 1) return { status: "parse_failed", via: "rendered: " + vals.length + " different prices" };
  return { status: "parse_failed", via: "rendered: no price element" };
}

/**
 * Check one watch in a headless browser (Playwright). `browser` is a
 * launched Playwright browser; robots.txt is still read with fetchImpl first.
 */
async function checkWatchRendered(watch, { browser, fetchImpl, robotsCache = new Map(), timeoutMs = 30000,
                                           selectors = RENDERED_SELECTORS, allowHttpForTests = false }) {
  let url;
  try { url = new URL(watch.url); } catch { return { status: "fetch_failed", via: "invalid url" }; }
  if (url.protocol !== "https:" && !(allowHttpForTests && url.protocol === "http:")) return { status: "fetch_failed", via: "not https" };
  const site = Object.keys(selectors).find((d) => url.hostname === d || url.hostname.endsWith("." + d));
  if (!site) return { status: "parse_failed", via: "no rendered reader for " + url.hostname };
  const sel = selectors[site];
  try {
    if (!robotsCache.has(url.origin)) {
      const r = await fetchImpl(url.origin + "/robots.txt", { headers: { "User-Agent": USER_AGENT } });
      robotsCache.set(url.origin, r.ok ? await r.text() : "");
    }
    if (!robotsAllows(robotsCache.get(url.origin), url.pathname + url.search))
      return { status: "blocked_by_robots", via: "robots.txt" };
  } catch { return { status: "fetch_failed", via: "robots.txt unreachable" }; }

  const ctx = await browser.newContext({ userAgent: USER_AGENT, locale: "en-PK" });
  try {
    const page = await ctx.newPage();
    const res = await page.goto(url.href, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    const httpStatus = res ? res.status() : null;
    if (res && !res.ok()) return { status: "http_error", httpStatus };
    const found = await Promise.race([
      page.waitForSelector(sel.current, { timeout: timeoutMs }).then(() => "price"),
      page.waitForSelector(sel.challenge, { timeout: timeoutMs }).then(() => "challenge"),
    ]).catch(() => "nothing");
    if (found === "challenge") return { status: "http_error", httpStatus, via: "site showed a challenge; left alone" };
    if (found !== "price") return { status: "parse_failed", httpStatus, via: "rendered: price did not appear" };
    const texts = await page.$$eval(sel.current, (els) => els.filter((e) => e.offsetParent !== null).map((e) => e.textContent));
    return { ...priceFromRenderedTexts(texts), httpStatus };
  } catch (e) {
    return { status: "fetch_failed", via: /timeout/i.test(String(e.message)) ? "timeout" : "browser" };
  } finally {
    await ctx.close();
  }
}

module.exports = { RENDERED_SELECTORS, priceFromRenderedTexts, checkWatchRendered, USER_AGENT, parseRobots, robotsAllows, extractPrice, toPaisa, checkWatch, competitorFacts };
