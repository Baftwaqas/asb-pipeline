#!/usr/bin/env node
// ============================================================================
// ASB PIPELINE — scripts/community-rehearsal.js   (npm run community:rehearsal)
//
// Deployment rehearsal for Phase 1 against a STAGING copy (a Neon branch of
// production, or any clone). Sends signed, synthetic Shopify webhooks to a
// running staging app and checks the staging database afterwards.
//
//   REHEARSAL_BASE_URL=https://<staging app>      the app under test
//   DATABASE_URL=<staging branch connection>      the SAME database that app uses
//   SHOPIFY_WEBHOOK_SECRET=<staging app's secret>
//   node scripts/community-rehearsal.js
//
// REFUSES TO RUN unless all of these hold - so it cannot touch production:
//   1. the database has app_settings asb_environment = 'rehearsal'
//      (set once by hand on the branch; production never has it);
//   2. the app's own /healthz reports community.environment = 'rehearsal'
//      (proves the app is wired to a rehearsal database too);
//   3. the app has NO WhatsApp token (/healthz config.whatsappToken = false),
//      so no customer can ever be messaged from a rehearsal.
//
// Every order it sends uses synthetic ids (9xxxxxxxxx...) and fake phone
// numbers. It writes nothing itself except via those webhooks.
// ============================================================================

"use strict";

const crypto = require("crypto");

const COMMUNITY_DRAFT = { variant_id: 50595473817858, product_id: 10341692014850, sku: "ASB-COM-DEMO-ONION-5KG",
                          title: "Payaz — Community Deal", variant_title: "5 kg", price: "700.00" };

class RehearsalRefused extends Error {}

async function guard(db, base) {
  const env = (await db.query(`SELECT value FROM app_settings WHERE key = 'asb_environment'`)).rows[0]?.value;
  if (env !== "rehearsal") {
    throw new RehearsalRefused("database is not marked as a rehearsal copy (app_settings asb_environment <> 'rehearsal')");
  }
  const h = await (await fetch(`${base}/healthz`)).json();
  if (h?.community?.environment !== "rehearsal") {
    throw new RehearsalRefused(`app at ${base} is not wired to a rehearsal database (environment=${h?.community?.environment})`);
  }
  // Real WhatsApp stays disabled: either no token, or every Meta call goes to
  // a LOCAL fake Graph (scripts/fake-graph.js via GRAPH_BASE).
  const localGraph = ["127.0.0.1", "localhost", "::1"].includes(h?.config?.graphHost);
  if (h?.config?.whatsappToken && !localGraph) {
    throw new RehearsalRefused(`app has a WhatsApp token and Meta calls go to ${h?.config?.graphHost} - unset WHATSAPP_TOKEN or point GRAPH_BASE at scripts/fake-graph.js`);
  }
  if (!h?.community?.ready) throw new RehearsalRefused(`app reports Community not ready: ${JSON.stringify(h.community)}`);
  if (!(h.community.variants_resolvable > 0)) throw new RehearsalRefused("registry has no resolvable variant - load the snapshot first");
  // Migration 017: a full rehearsal exercises the worker, real bill sending
  // (to the fake Graph) and alert push - so every one of them must be ON, and
  // push must be suppressed so real ASB phones are never notified from a copy
  // of production. Strict checks: a missing field refuses.
  const g = h.grocery;
  if (!g || g.available !== true) {
    throw new RehearsalRefused(`app does not report the 017 grocery pipeline as available (${JSON.stringify(g)})`);
  }
  const missing = [];
  if (g.worker_enabled !== true) missing.push("worker_enabled (GROCERY_SOURCE_WORKER=on + backfill marker + grocery:activate --worker)");
  if (g.bills_enabled !== true) missing.push("bills_enabled (GROCERY_BILL_SEND=on + grocery:activate --bills)");
  if (g.alert_push !== true) missing.push("alert_push (GROCERY_ALERT_PUSH=on)");
  if (missing.length) {
    throw new RehearsalRefused(`grocery switches not all on for a full 017 rehearsal - missing: ${missing.join("; ")}`);
  }
  if (!g.push_suppressed) {
    throw new RehearsalRefused("push notifications are NOT suppressed on staging (mark the database as rehearsal or set PUSH_DISABLED=1)");
  }
  return h;
}

function signer(secret) {
  return (body) => crypto.createHmac("sha256", secret).update(body).digest("base64");
}

async function rehearse({ db, base, secret, log = console.log }) {
  await guard(db, base);
  const sign = signer(secret);
  const run = Date.now() % 1e9;
  const shop = process.env.SHOPIFY_SHOP_DOMAIN || "rehearsal.myshopify.com";
  let seq = 0;
  const lineId = () => 9100000000000 + run * 100 + ++seq;
  const orderId = () => 9200000000000 + run * 100 + ++seq;

  const grocery = (await db.query(
    `SELECT shopify_variant_id, shopify_product_id, sku, name_en, asb_price
       FROM products p
      WHERE is_active AND asb_price > 0 AND category <> 'community-excluded' AND shopify_variant_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM community_variants cv WHERE cv.shopify_variant_id = p.shopify_variant_id)
      ORDER BY id LIMIT 1`)).rows[0];
  if (!grocery) throw new RehearsalRefused("no active grocery product with a Shopify variant in this copy");
  const G = { variant_id: Number(grocery.shopify_variant_id), product_id: Number(grocery.shopify_product_id),
              sku: grocery.sku, title: grocery.name_en, price: String(grocery.asb_price) };

  // Fake numbers in the unused 039x range, unique per run so a rehearsal
  // never merges into an earlier rehearsal's open order.
  const fakePhone = (n) => `+92 39${String(run % 1e6).padStart(6, "0")}${String(n).padStart(2, "0")}`;
  const mk = (name, lines, phone) => ({
    id: orderId(), name: `#REH-${run}-${name}`, created_at: new Date().toISOString(), currency: "PKR",
    total_price: "0", customer: { id: 9300000000000 + seq, first_name: "Rehearsal", last_name: name },
    shipping_address: { first_name: "Rehearsal", phone, address1: "Test", address2: "Test" },
    line_items: lines.map(([b, q]) => ({ id: lineId(), quantity: q, vendor: "Apna Sasta Bazaar", ...b })),
  });
  const send = async (o, hook, topic = "orders/create") => {
    const body = Buffer.from(JSON.stringify(o));
    const res = await fetch(`${base}/webhooks/shopify`, { method: "POST", body, headers: {
      "Content-Type": "application/json", "X-Shopify-Hmac-Sha256": sign(body), "X-Shopify-Topic": topic,
      "X-Shopify-Webhook-Id": hook, "X-Shopify-Shop-Domain": shop } });
    return res.status;
  };
  const waitDone = async (hook) => {
    for (let i = 0; i < 150; i++) {
      const r = (await db.query(`SELECT status FROM webhook_events WHERE source='shopify' AND event_id=$1`, [hook])).rows[0];
      if (r && r.status !== "received") return r.status;
      await new Promise((r2) => setTimeout(r2, 200));
    }
    return "timeout";
  };
  const waitIntake = async (oid) => {
    for (let i = 0; i < 300; i++) {
      const rows = (await db.query(`SELECT status, review_reason FROM community_intake WHERE shopify_order_id=$1 ORDER BY id`, [String(oid)])).rows;
      if (rows.length && rows.every((r) => r.status === "resolved" || r.status === "review")) return rows;
      await new Promise((r2) => setTimeout(r2, 400));
    }
    return (await db.query(`SELECT status, review_reason FROM community_intake WHERE shopify_order_id=$1`, [String(oid)])).rows;
  };
  const itemsOf = async (oid) => (await db.query(
    `SELECT p.sku FROM orders o JOIN order_items oi ON oi.order_id = o.id JOIN products p ON p.id = oi.product_id
      WHERE o.shopify_order_id = $1`, [String(oid)])).rows.map((r) => r.sku);

  const results = [];
  const check = (name, ok, detail) => { results.push({ name, ok, detail }); log(`${ok ? "PASS" : "FAIL"}  ${name}  ${detail}`); };

  // A. grocery only
  const A = mk("A", [[G, 1]], fakePhone(1)); const hA = `reh-${run}-A`;
  check("A grocery-only answered 200", (await send(A, hA)) === 200, "");
  check("A grocery order processed", (await waitDone(hA)) === "processed", "");
  check("A grocery order has the grocery line", JSON.stringify(await itemsOf(A.id)) === JSON.stringify([G.sku]), G.sku);

  // B. Community only
  const B = mk("B", [[COMMUNITY_DRAFT, 1]], fakePhone(2)); const hB = `reh-${run}-B`;
  check("B Community-only answered 200", (await send(B, hB)) === 200, "");
  await waitDone(hB);
  check("B no grocery order", (await db.query(`SELECT 1 FROM orders WHERE shopify_order_id=$1`, [String(B.id)])).rows.length === 0, "");
  const bi = await waitIntake(B.id);
  check("B intake resolved", bi.length === 1 && bi[0].status === "resolved", JSON.stringify(bi));

  // C. mixed
  const C = mk("C", [[G, 2], [COMMUNITY_DRAFT, 1]], fakePhone(3)); const hC = `reh-${run}-C`;
  check("C mixed answered 200", (await send(C, hC)) === 200, "");
  await waitDone(hC);
  check("C grocery order has ONLY the grocery line", JSON.stringify(await itemsOf(C.id)) === JSON.stringify([G.sku]), "");
  const cp = (await db.query(`SELECT source_payload FROM orders WHERE shopify_order_id=$1`, [String(C.id)])).rows[0]?.source_payload;
  check("C stored order payload is sanitized", !!cp && cp.line_items.length === 1 && !("total_price" in cp) && !!cp.asb_community_split, "");
  const ci = await waitIntake(C.id);
  check("C Community line in intake, resolved", ci.length === 1 && ci[0].status === "resolved", JSON.stringify(ci));

  // D. Community SKU, unknown variant
  const D = mk("D", [[{ ...COMMUNITY_DRAFT, variant_id: 9999999999901, product_id: 9999999999902 }, 1]], fakePhone(4));
  const hD = `reh-${run}-D`;
  await send(D, hD); await waitDone(hD);
  const di = await waitIntake(D.id);
  check("D unknown variant -> review", di.length === 1 && di[0].status === "review", JSON.stringify(di));
  check("D no grocery order", (await db.query(`SELECT 1 FROM orders WHERE shopify_order_id=$1`, [String(D.id)])).rows.length === 0, "");

  // E. quantity 2
  const E = mk("E", [[COMMUNITY_DRAFT, 2]], fakePhone(5)); const hE = `reh-${run}-E`;
  await send(E, hE); await waitDone(hE);
  const ei = await waitIntake(E.id);
  check("E quantity 2 -> review", ei.length === 1 && ei[0].review_reason === "quantity_not_one", JSON.stringify(ei));

  // F. exact redelivery of B
  check("F redelivery answered 200", (await send(B, hB)) === 200, "");
  const fb = (await db.query(`SELECT count(*)::int AS n FROM community_intake WHERE shopify_order_id=$1`, [String(B.id)])).rows[0].n;
  check("F redelivery stored nothing new", fb === 1, `intake rows ${fb}`);

  // H. orders/updated for grocery order A: ignored, nothing changes
  const qtyA = async () => (await db.query(
    `SELECT coalesce(sum(oi.qty_ordered),0)::float AS q FROM orders o JOIN order_items oi ON oi.order_id = o.id
      WHERE o.shopify_order_id = $1`, [String(A.id)])).rows[0].q;
  const qBefore = await qtyA();
  const hH = `reh-${run}-H`;
  check("H orders/updated answered 200", (await send({ ...A, line_items: A.line_items.map((l) => ({ ...l, quantity: 9 })) }, hH, "orders/updated")) === 200, "");
  const hEv = (await db.query(`SELECT status FROM webhook_events WHERE source='shopify' AND event_id=$1`, [hH])).rows[0];
  check("H orders/updated recorded as ignored", hEv?.status === "ignored", JSON.stringify(hEv));
  check("H grocery order A unchanged", (await qtyA()) === qBefore, `qty ${qBefore}`);

  // I. migration 017: the same Shopify order under a NEW delivery id
  const has017 = (await db.query(`SELECT to_regclass('shopify_order_sources') IS NOT NULL AS t`)).rows[0].t;
  if (has017) {
    const hI = `reh-${run}-I`;
    check("I same order, new delivery id answered 200", (await send(A, hI)) === 200, "");
    const iEv = await waitDone(hI);
    check("I recorded as an ignored duplicate", iEv === "ignored", iEv);
    check("I grocery order A not doubled", (await qtyA()) === qBefore, `qty ${await qtyA()}`);
    // J. same order, DIFFERENT content, new delivery id: never applied, anomaly recorded
    const hJ = `reh-${run}-J`;
    await send({ ...A, line_items: A.line_items.map((l) => ({ ...l, quantity: 7 })) }, hJ);
    await waitDone(hJ);
    const jEv = (await db.query(`SELECT status, error_detail FROM webhook_events WHERE source='shopify' AND event_id=$1`, [hJ])).rows[0];
    check("J different content -> ignored as MISMATCH", jEv?.status === "ignored" && /MISMATCH/.test(jEv.error_detail || ""), JSON.stringify(jEv));
    check("J grocery order A unchanged", (await qtyA()) === qBefore, "");
    const srcA = (await db.query(`SELECT status, bill_state FROM shopify_order_sources WHERE shopify_order_id = $1`, [String(A.id)])).rows[0];
    check("K source A applied once", srcA?.status === "applied", JSON.stringify(srcA));
    const srcB = (await db.query(`SELECT status, bill_state FROM shopify_order_sources WHERE shopify_order_id = $1`, [String(B.id)])).rows[0];
    check("K source B Community-only, no bill", srcB?.status === "community_only" && srcB.bill_state === "not_required", JSON.stringify(srcB));
  }

  // G. global: no Community SKU anywhere in grocery tables for this run
  const leak = (await db.query(
    `SELECT count(*)::int AS n FROM order_items oi JOIN orders o ON o.id = oi.order_id JOIN products p ON p.id = oi.product_id
      WHERE o.shopify_order_name LIKE $1 AND (p.sku LIKE 'ASB-COM-%' OR p.category = 'community-excluded')`, [`#REH-${run}-%`])).rows[0].n;
  check("G no Community line in grocery order_items", leak === 0, `leaked ${leak}`);

  const failed = results.filter((r) => !r.ok).length;
  log(`\n${results.length - failed}/${results.length} checks passed (run ${run}).`);
  return { run, results, failed };
}

async function main() {
  const base = process.env.REHEARSAL_BASE_URL;
  if (!base || !process.env.DATABASE_URL || !process.env.SHOPIFY_WEBHOOK_SECRET) {
    console.error("Set REHEARSAL_BASE_URL, DATABASE_URL (staging) and SHOPIFY_WEBHOOK_SECRET (staging).");
    process.exit(2);
  }
  const db = require("../db");
  try {
    const r = await rehearse({ db, base: base.replace(/\/$/, ""), secret: process.env.SHOPIFY_WEBHOOK_SECRET });
    process.exitCode = r.failed ? 1 : 0;
  } catch (e) {
    console.error(`[rehearsal] ${e instanceof RehearsalRefused ? "REFUSED" : "failed"}: ${e.message}`);
    process.exitCode = 3;
  } finally {
    await db.shutdown();
  }
}

if (require.main === module) main();

module.exports = { rehearse, guard, RehearsalRefused };
