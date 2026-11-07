// Bhao Tao competitor price watch (migration 024, bhao/price-watch.js) and
// Seth Ji's competitor / stock claims (bhao/voice.js).
// DB part needs a scratch Postgres (TEST_PG_URL, default postgres://postgres@localhost:54330).
//   node --test test/bhao-price-watch.test.js
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { Client } = require("pg");
const H = require("./support/harness");
const PW = require("../bhao/price-watch");
const V = require("../bhao/voice");
const RUN = require("../scripts/price-watch-run");

// The live Daraz robots.txt rules as read on 7 Nov 2026 (trimmed).
const DARAZ_ROBOTS = `User-agent: *
Disallow: /checkout/
Disallow: /customer/
Disallow: /cart/
Disallow: /catalog/
Disallow: /*from=
Disallow: /wangpu/
Disallow: /shop/*.htm
Disallow: /wow/gcp/`;

const ld = (offers) => `<html><head><script type="application/ld+json">${JSON.stringify(
  { "@context": "https://schema.org", "@type": "Product", name: "Steel Degchi 5L", offers })}</script></head><body></body></html>`;

test("robots: product pages allowed; catalogue, search 'from=' and carts refused; longest rule wins", () => {
  assert.equal(PW.robotsAllows(DARAZ_ROBOTS, "/products/steel-degchi-5l-i123456789.html"), true);
  assert.equal(PW.robotsAllows(DARAZ_ROBOTS, "/catalog/?q=degchi"), false);
  assert.equal(PW.robotsAllows(DARAZ_ROBOTS, "/products/x-i1.html?from=search"), false);
  assert.equal(PW.robotsAllows(DARAZ_ROBOTS, "/cart/"), false);
  assert.equal(PW.robotsAllows("User-agent: *\nDisallow: /p/\nAllow: /p/ok", "/p/ok/1"), true);
  assert.equal(PW.robotsAllows("User-agent: *\nDisallow: /", "/anything"), false);
  assert.equal(PW.robotsAllows("User-agent: *\nDisallow:", "/anything"), true);
  assert.equal(PW.robotsAllows("", "/anything"), true);
  // a group naming us wins over "*"
  assert.equal(PW.robotsAllows("User-agent: *\nAllow: /\n\nUser-agent: ASB-PriceCheck\nDisallow: /", "/products/x"), false);
});

test("price is read from structured data only; conflicting readings are refused", () => {
  assert.deepEqual(PW.extractPrice(ld({ "@type": "Offer", price: "2350", priceCurrency: "PKR", availability: "https://schema.org/InStock" })),
    { status: "ok", pricePaisa: 235000, via: "json-ld" });
  assert.deepEqual(PW.extractPrice(ld({ "@type": "AggregateOffer", lowPrice: "2,199.50" })), { status: "ok", pricePaisa: 219950, via: "json-ld" });
  assert.equal(PW.extractPrice(ld({ price: "2350", availability: "https://schema.org/OutOfStock" })).status, "unavailable");
  assert.equal(PW.extractPrice(ld([{ price: "2350" }, { price: "1999" }])).status, "parse_failed");
  assert.deepEqual(PW.extractPrice('<meta property="product:price:amount" content="2350">'), { status: "ok", pricePaisa: 235000, via: "meta" });
  assert.deepEqual(PW.extractPrice('<script>app.run({"salePrice":{"text":"Rs. 2,350","value":2350}})</script>'),
    { status: "ok", pricePaisa: 235000, via: "embedded" });
  assert.deepEqual(PW.extractPrice('<script>var d={"pdt_price":"Rs. 2,350"}</script>'), { status: "ok", pricePaisa: 235000, via: "embedded" });
  assert.equal(PW.extractPrice("<p>Price: Rs 2,350</p>").status, "parse_failed"); // free text is never trusted
  assert.equal(PW.extractPrice("<p>Sorry, this item is out of stock</p>").status, "unavailable");
  assert.equal(PW.extractPrice('<script type="application/ld+json">{not json</script>').status, "parse_failed");
});

function fakeWeb(pages) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, ua: init.headers["User-Agent"] });
    const p = pages[url];
    if (p === undefined) return { ok: false, status: 404, text: async () => "" };
    if (typeof p === "number") return { ok: false, status: p, text: async () => "" };
    return { ok: true, status: 200, text: async () => p };
  };
  return { fn, calls };
}

test("checkWatch: reads robots once per site, identifies itself, never fetches a blocked page", async () => {
  const web = fakeWeb({
    "https://www.daraz.pk/robots.txt": DARAZ_ROBOTS,
    "https://www.daraz.pk/products/degchi-i1.html": ld({ price: "2350" }),
  });
  const cache = new Map();
  const ok = await PW.checkWatch({ url: "https://www.daraz.pk/products/degchi-i1.html" }, { fetchImpl: web.fn, robotsCache: cache });
  assert.deepEqual([ok.status, ok.pricePaisa], ["ok", 235000]);
  const blocked = await PW.checkWatch({ url: "https://www.daraz.pk/catalog/?q=degchi" }, { fetchImpl: web.fn, robotsCache: cache });
  assert.equal(blocked.status, "blocked_by_robots");
  assert.equal(web.calls.filter((c) => c.url.endsWith("robots.txt")).length, 1);
  assert.ok(!web.calls.some((c) => c.url.includes("/catalog/")), "a blocked page is never requested");
  for (const c of web.calls) assert.match(c.ua, /^ASB-PriceCheck\//);
  assert.equal((await PW.checkWatch({ url: "https://www.daraz.pk/products/gone-i2.html" }, { fetchImpl: web.fn, robotsCache: cache })).status, "http_error");
  assert.equal((await PW.checkWatch({ url: "http://www.daraz.pk/products/x" }, { fetchImpl: web.fn })).status, "fetch_failed");
});

test("competitorFacts: only fresh, OK, HIGHER prices; cheaper listings are alerts and silence that marketplace", () => {
  const now = new Date("2026-11-07T12:00:00Z");
  const row = (m, p, h, extra = {}) => ({ marketplace: m, url: "https://x/" + m + p, active: true, status: "ok", price_paisa: p,
    checked_at: new Date(now - h * 3600e3).toISOString(), ...extra });
  const r = PW.competitorFacts({ now, ourUnitPaisa: 154000, latest: [
    row("daraz", 235000, 5), row("daraz", 249900, 5),        // two listings: quote the cheaper one
    row("shophive", 199000, 60),                             // too old
    row("telemart", 150000, 2),                              // cheaper than us -> alert
    row("priceoye", 210000, 2, { status: "parse_failed", price_paisa: null }),
    row("olx", 300000, 1, { active: false }),
  ] });
  assert.deepEqual(r.facts.map((f) => [f.marketplace, f.pricePaisa]), [["daraz", 235000]]);
  assert.deepEqual(r.alerts.map((a) => a.marketplace), ["telemart"]);
  assert.deepEqual(r.stale.map((s) => s.marketplace).sort(), ["priceoye", "shophive"]);
  const mixed = PW.competitorFacts({ now, ourUnitPaisa: 154000, latest: [row("daraz", 235000, 1), row("daraz", 140000, 1)] });
  assert.deepEqual(mixed.facts, [], "a marketplace with any cheaper listing is never quoted");
});

test("Seth Ji may quote Daraz only with a checked price, and only that number", () => {
  const d = { kind: "counter", askPaisa: 154000, angle: "running_costs" };
  const facts = [{ marketplace: "daraz", pricePaisa: 235000 }];
  const good = "Baji, Daraz pe yehi degchi Rs 2,350 ki hai, main Rs 1,540 de raha hoon!";
  assert.equal(V.checkReply(good, { decision: d, qty: 1, competitorFacts: facts }).ok, true);
  assert.equal(V.checkReply(good, { decision: d, qty: 1 }).ok, false, "no checked price -> no Daraz");
  assert.equal(V.checkReply("Baji, Daraz pe Rs 2,900 hai, main Rs 1,540 de raha hoon", { decision: d, qty: 1, competitorFacts: facts }).ok, false);
  assert.equal(V.checkReply("Baji, OLX pe Rs 2,350 hai, main Rs 1,540", { decision: d, qty: 1, competitorFacts: facts }).ok, false);
  const p = V.buildPrompt({ decision: d, itemName: "Degchi", qty: 1, competitorFacts: facts });
  assert.match(p.user, /CHECKED COMPETITOR PRICES .*Daraz Rs 2,350/);
  assert.match(V.buildPrompt({ decision: d, itemName: "Degchi", qty: 1 }).user, /do not mention any other shop/);
});

test("'bas 2 bachi hain' only when stock really is 3 or fewer, with the real number", () => {
  const d = { kind: "counter", askPaisa: 154000 };
  assert.equal(V.checkReply("Baji, bas 2 bachi hain, Rs 1,540 le lein", { decision: d, qty: 1, stockLeft: 2 }).ok, true);
  assert.equal(V.checkReply("Baji, bas 2 bachi hain, Rs 1,540 le lein", { decision: d, qty: 1, stockLeft: 40 }).ok, false);
  assert.equal(V.checkReply("Baji, bas 2 bachi hain, Rs 1,540 le lein", { decision: d, qty: 1 }).ok, false);
  assert.equal(V.checkReply("Baji, last piece hai, Rs 1,540", { decision: d, qty: 1, stockLeft: 1 }).ok, true);
  assert.equal(V.checkReply("Baji, bas 1 bachi hai, Rs 1,540", { decision: d, qty: 1, stockLeft: 3 }).ok, false, "wrong count");
  assert.equal(V.checkReply("Baji, sirf aaj ke liye Rs 1,540", { decision: d, qty: 1, stockLeft: 1 }).ok, false, "fake deadline, always");
});

// ---------- database ----------
let db;
before(async () => {
  const url = await H.createDatabase("asb_test_024", path.join(__dirname, ".."), { grocery: false });
  db = new Client({ connectionString: url });
  await db.connect();
});
after(async () => { if (db) await db.end(); });

test("024: add a confirmed page, check it, record every outcome; checks are append-only evidence", async () => {
  const id = await RUN.add(db, { itemId: "ASB-NG-POT-5L", marketplace: "Daraz", url: "https://www.daraz.pk/products/degchi-i1.html", by: "Waqas" });
  await RUN.add(db, { itemId: "ASB-NG-POT-5L", marketplace: "daraz", url: "https://www.daraz.pk/products/gone-i2.html", by: "Waqas" });
  await assert.rejects(RUN.add(db, { itemId: "X", marketplace: "daraz", url: "https://www.daraz.pk/catalog/?q=degchi", by: "Waqas" }), /PRODUCT page/);
  await assert.rejects(RUN.add(db, { itemId: "X", marketplace: "daraz", url: "https://www.daraz.pk/products/y" }), /usage/);
  const web = fakeWeb({ "https://www.daraz.pk/robots.txt": DARAZ_ROBOTS, "https://www.daraz.pk/products/degchi-i1.html": ld({ price: "2350" }) });
  const s = await RUN.check(db, { fetchImpl: web.fn, delayMs: 0, log: () => {} });
  assert.deepEqual(s, { ok: 1, notOk: 1 });
  const rows = await RUN.list(db, () => {});
  const by = Object.fromEntries(rows.map((r) => [r.url.split("/").pop(), r]));
  assert.deepEqual([by["degchi-i1.html"].status, Number(by["degchi-i1.html"].price_paisa)], ["ok", 235000]);
  assert.equal(by["gone-i2.html"].status, "http_error");
  assert.equal(by["degchi-i1.html"].marketplace, "daraz");
  await assert.rejects(db.query("UPDATE competitor_price_checks SET price_paisa = 1"), /append-only/);
  await assert.rejects(db.query("DELETE FROM competitor_price_checks"), /append-only/);
  await assert.rejects(db.query("DELETE FROM competitor_price_watches WHERE id = $1", [id]), /append-only/);
  await assert.rejects(db.query(
    "INSERT INTO competitor_price_checks (watch_id, status, price_paisa) VALUES ($1, 'parse_failed', 100)", [id]), /price_iff_ok/);
  await assert.rejects(db.query(
    "INSERT INTO competitor_price_watches (item_id, marketplace, url, confirmed_same_item_by) VALUES ('X','daraz','http://x','W')"), /check/i);
});
