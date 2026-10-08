// ============================================================================
// Final Phase 1 corrections:
//   1. Shopify topic allowlist (only orders/create + products/create|update|delete)
//   2. /healthz: Community ready only with a usable, non-empty registry
//   3. vendor is never a Community signal
//   4. Admin GraphQL default API version 2026-10
//   5. no fabricated shop identity
//   6. snapshot bootstrap refused on a populated registry (audited force override)
// This file starts with an EMPTY registry on purpose.
// ============================================================================

"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const H = require("./support/harness");

const ROOT = path.join(__dirname, "..");
const SNAP_FILE = "db/community/registry-snapshot-2026-10-08.json";
let db, server, base, sent, registryScript, snapshot;
let orderSeq = 7800000000000;
let hookSeq = 0;
const nextHook = () => `final-hook-${process.pid}-${++hookSeq}`;

before(async () => {
  const url = await H.createDatabase("asb_t_final", ROOT);
  H.setEnv(url);
  delete process.env.SHOPIFY_SHOP_DOMAIN;
  delete process.env.COMMUNITY_VENDORS;
  sent = H.stubOutside(ROOT);
  const mod = require(path.join(ROOT, "server.js"));
  db = require(path.join(ROOT, "db"));
  registryScript = require(path.join(ROOT, "scripts", "community-registry.js"));
  snapshot = JSON.parse(fs.readFileSync(path.join(ROOT, SNAP_FILE), "utf8")).products;
  await require(path.join(ROOT, "productSync.js")).ensureSchema(db);
  await db.query(H.FIXTURE_SQL);
  server = mod.app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  server?.close();
  await db?.shutdown();
});

const counts = async () => (await db.query(`
  SELECT (SELECT count(*) FROM orders)::int AS orders,
         (SELECT count(*) FROM order_items)::int AS order_items,
         (SELECT coalesce(sum(qty_ordered),0)::float FROM order_items) AS qty,
         (SELECT count(*) FROM cycle_prices)::int AS cycle_prices,
         (SELECT count(*) FROM products)::int AS products,
         (SELECT count(*) FROM community_intake)::int AS intake`)).rows[0];

// ---------------------------------------------------------------------------
// 2. /healthz with an empty registry (runs first, before any bootstrap)
// ---------------------------------------------------------------------------

test("/healthz: migration 016 present but registry EMPTY -> Community not ready, 503", async () => {
  const res = await fetch(`${base}/healthz`);
  const body = await res.json();
  assert.equal(res.status, 503);
  assert.equal(body.ready, false);
  assert.equal(body.community.ready, false);
  assert.equal(body.community.reason, "registry_empty_or_unusable");
  assert.equal(body.community.products, 0);
  assert.equal(body.community.products_active, 0);
  assert.equal(body.community.variants, 0);
  assert.equal(body.community.variants_active, 0);
  assert.equal(body.community.variants_resolvable, 0);
});

test("/healthz: a registry with only archived/deactivated entries is still not ready", async () => {
  const archived = snapshot.filter((p) => p.status === "archived");
  assert.equal(archived.length, 1);
  await registryScript.apply(db, archived, "snapshot");    // internal path: archived product only
  const body = await (await fetch(`${base}/healthz`)).json();
  assert.equal(body.community.ready, false, "14 variants exist but none is resolvable");
  assert.equal(body.community.variants, 14);
  assert.equal(body.community.variants_resolvable, 0);
});

// ---------------------------------------------------------------------------
// 6. Snapshot bootstrap guard
// ---------------------------------------------------------------------------

test("snapshot bootstrap is refused on a populated registry (dry run and apply)", async () => {
  const before = (await db.query(`SELECT count(*)::int AS n FROM community_variants`)).rows[0].n;
  await assert.rejects(registryScript.bootstrapSnapshot(db, snapshot, { file: SNAP_FILE }), /already holds 1 products \/ 14 variants/);
  await assert.rejects(registryScript.bootstrapSnapshot(db, snapshot, { file: SNAP_FILE, apply: true }), /bootstrap-only/);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM community_variants`)).rows[0].n, before, "nothing written");
});

test("force-bootstrap needs --by, --reason and --apply, and is audited", async () => {
  await assert.rejects(registryScript.bootstrapSnapshot(db, snapshot, { file: SNAP_FILE, apply: true, force: true }), /--by/);
  await assert.rejects(registryScript.bootstrapSnapshot(db, snapshot, { file: SNAP_FILE, force: true, actor: "Waqas",
    reason: "recovery after test setup" }), /needs --apply/);
  const r = await registryScript.bootstrapSnapshot(db, snapshot, { file: SNAP_FILE, apply: true, force: true,
    actor: "Waqas", reason: "recovery after test setup" });
  assert.equal(r.applied, true);
  assert.deepEqual(r.after, { products: 8, variants: 28 });
  const aud = (await db.query(`SELECT actor, action, target_type, target_id, before, after FROM community_audit
                                WHERE target_type = 'registry'`)).rows;
  assert.deepEqual(aud, [{ actor: "Waqas", action: "force_bootstrap_snapshot", target_type: "registry", target_id: SNAP_FILE,
                           before: { products: 1, variants: 14 }, after: { products: 8, variants: 28 } }]);
});

test("a STALE snapshot can never silently overwrite newer registry data", async () => {
  // Newer data arrives by webhook (price change)...
  const hook = nextHook();
  await H.postShopify(base, { ...snapshot[1], variants: snapshot[1].variants.map((v) => ({ ...v, price: "777.00" })) },
                      { id: hook, topic: "products/update" });
  await H.waitWebhookDone(db, "shopify", hook);
  // ...then someone re-runs the dated snapshot: refused, newer price kept.
  await assert.rejects(registryScript.bootstrapSnapshot(db, snapshot, { file: SNAP_FILE, apply: true }), /bootstrap-only/);
  const p = (await db.query(`SELECT price::float AS p FROM community_variants WHERE shopify_variant_id = '50595473817858'`)).rows[0].p;
  assert.equal(p, 777);
});

test("/healthz: usable registry -> Community ready with active counts", async () => {
  const res = await fetch(`${base}/healthz`);
  const body = await res.json();
  assert.equal(body.community.ready, true);
  assert.equal(body.community.reason, undefined);
  assert.equal(body.community.products, 8);
  assert.equal(body.community.products_active, 8);
  assert.equal(body.community.variants, 28);
  assert.equal(body.community.variants_active, 28);
  assert.equal(body.community.variants_resolvable, 14, "the archived product's 14 variants are not resolvable");
  assert.equal(res.status, 200);
});

// ---------------------------------------------------------------------------
// 1. Topic allowlist
// ---------------------------------------------------------------------------

async function groceryOrder(phone) {
  const id = ++orderSeq;
  const order = H.shopifyOrder({ id, name: `#F${id % 100000}`, lines: [H.line(H.GROCERY.aloo, 2)], phone });
  const hook = nextHook();
  assert.equal(await H.postShopify(base, order, { id: hook }), 200);
  assert.equal(await H.waitWebhookDone(db, "shopify", hook), "processed");
  return order;
}

for (const topic of ["orders/updated", "orders/edited", "orders/cancelled", "orders/paid", "orders/fulfilled",
                     "customers/create", "fulfillments/create", "app/uninstalled", "products/foo", null]) {
  test(`topic ${topic === null ? "(missing)" : topic} never touches grocery: no order change, no bill, recorded as ignored`, async () => {
    const order = await groceryOrder(`+92 301 ${String(5000000 + hookSeq).padStart(7, "0")}`);
    const before = await counts();
    const sendsBefore = sent.length;
    // The same order (and a brand-new one) re-sent under the non-allowlisted topic.
    const fresh = H.shopifyOrder({ id: ++orderSeq, name: "#IGN", lines: [H.line(H.GROCERY.mango, 3), H.line(H.COMMUNITY.onion5Draft, 1)] });
    const h1 = nextHook();
    const h2 = nextHook();
    assert.equal(await H.postShopify(base, { ...order, line_items: [H.line(H.GROCERY.aloo, 5)] }, { id: h1, topic }), 200);
    assert.equal(await H.postShopify(base, fresh, { id: h2, topic }), 200);
    await new Promise((r) => setTimeout(r, 150));
    assert.deepEqual(await counts(), before, "grocery tables, products and intake unchanged");
    assert.equal(sent.length, sendsBefore, "no bill sent");
    const ev = (await db.query(`SELECT topic, status, error_detail FROM webhook_events WHERE event_id = ANY($1) ORDER BY id`,
                               [[h1, h2]])).rows;
    assert.equal(ev.length, 2);
    for (const e of ev) {
      assert.equal(e.status, "ignored");
      assert.equal(e.topic, topic);
      assert.match(e.error_detail, /not handled in Phase 1/);
    }
  });
}

test("missing topic is no longer treated as orders/create", async () => {
  const order = H.shopifyOrder({ id: ++orderSeq, name: "#NOTOPIC", lines: [H.line(H.GROCERY.aloo, 1)], phone: "+92 302 1112223" });
  const hook = nextHook();
  const before = await counts();
  assert.equal(await H.postShopify(base, order, { id: hook, topic: null }), 200);
  assert.deepEqual(await counts(), before);
  assert.equal((await db.query(`SELECT 1 FROM orders WHERE shopify_order_id = $1`, [String(order.id)])).rows.length, 0);
});

// ---------------------------------------------------------------------------
// 3. Vendor is not a signal
// ---------------------------------------------------------------------------

test("a vendor-like COMMUNITY_VENDORS env cannot classify ordinary grocery", async () => {
  const { classifyLines } = require(path.join(ROOT, "community", "classify.js"));
  process.env.COMMUNITY_VENDORS = "Apna Sasta Bazaar";
  try {
    const out = await classifyLines(db, [H.line(H.GROCERY.aloo, 1)]);
    assert.equal(out[0].community, false);
    assert.deepEqual(out[0].signals, []);
    const order = H.shopifyOrder({ id: ++orderSeq, name: "#VEND", lines: [H.line(H.GROCERY.aloo, 1)], phone: "+92 302 4445556" });
    const hook = nextHook();
    await H.postShopify(base, order, { id: hook });
    await H.waitWebhookDone(db, "shopify", hook);
    assert.equal((await db.query(`SELECT count(*)::int AS n FROM community_intake WHERE shopify_order_id = $1`, [String(order.id)])).rows[0].n, 0);
    assert.equal((await db.query(`SELECT 1 FROM orders WHERE shopify_order_id = $1`, [String(order.id)])).rows.length, 1);
  } finally {
    delete process.env.COMMUNITY_VENDORS;
  }
  const src = fs.readFileSync(path.join(ROOT, "community", "classify.js"), "utf8");
  assert.doesNotMatch(src, /COMMUNITY_VENDORS|signals\.push\("vendor"\)/);
});

// ---------------------------------------------------------------------------
// 4. API version
// ---------------------------------------------------------------------------

test("registry reconcile uses Admin API 2026-10 by default, and SHOPIFY_API_VERSION when set", async () => {
  assert.equal(registryScript.DEFAULT_API_VERSION, "2026-10");
  const urls = [];
  const fake = async (url) => {
    urls.push(String(url));
    return { ok: true, json: async () => ({ data: { products: { nodes: [], pageInfo: { hasNextPage: false } } } }) };
  };
  await registryScript.fetchShopifyProducts(fake, { SHOPIFY_SHOP_DOMAIN: H.SHOP, SHOPIFY_ADMIN_TOKEN: "x" }, []);
  await registryScript.fetchShopifyProducts(fake, { SHOPIFY_SHOP_DOMAIN: H.SHOP, SHOPIFY_ADMIN_TOKEN: "x", SHOPIFY_API_VERSION: "2027-01" }, []);
  assert.deepEqual(urls, [`https://${H.SHOP}/admin/api/2026-10/graphql.json`, `https://${H.SHOP}/admin/api/2027-01/graphql.json`]);
});

// ---------------------------------------------------------------------------
// 5. Shop identity is never invented
// ---------------------------------------------------------------------------

test("no X-Shopify-Shop-Domain and no SHOPIFY_SHOP_DOMAIN -> 503, nothing recorded", async () => {
  assert.equal(process.env.SHOPIFY_SHOP_DOMAIN, undefined);
  const order = H.shopifyOrder({ id: ++orderSeq, name: "#NOSHOP", lines: [H.line(H.COMMUNITY.onion5Draft, 1), H.line(H.GROCERY.aloo, 1)] });
  const hook = nextHook();
  const before = await counts();
  assert.equal(await H.postShopify(base, order, { id: hook, shop: null }), 503);
  assert.deepEqual(await counts(), before);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM webhook_events WHERE event_id = $1`, [hook])).rows[0].n, 0);
  assert.equal((await db.query(`SELECT count(*)::int AS n FROM community_intake WHERE shop = 'unknown-shop'`)).rows[0].n, 0);
  // Product topics too.
  assert.equal(await H.postShopify(base, snapshot[1], { id: nextHook(), topic: "products/update", shop: null }), 503);
});

test("no header but SHOPIFY_SHOP_DOMAIN configured -> captured under the configured shop", async () => {
  process.env.SHOPIFY_SHOP_DOMAIN = "0du4xf-6j.myshopify.com";
  try {
    const order = H.shopifyOrder({ id: ++orderSeq, name: "#ENVSHOP", lines: [H.line(H.COMMUNITY.tomato10Draft, 1)] });
    const hook = nextHook();
    assert.equal(await H.postShopify(base, order, { id: hook, shop: null }), 200);
    const r = (await db.query(`SELECT shop FROM community_intake WHERE shopify_order_id = $1`, [String(order.id)])).rows;
    assert.deepEqual(r, [{ shop: "0du4xf-6j.myshopify.com" }]);
  } finally {
    delete process.env.SHOPIFY_SHOP_DOMAIN;
  }
});
