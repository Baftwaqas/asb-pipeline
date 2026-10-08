#!/usr/bin/env node
// ============================================================================
// Golden scenario: drive one copy of the app (any checkout of the repo)
// through ordinary GROCERY + WhatsApp traffic, then print every grocery table
// as normalised JSON. test/grocery-unchanged.test.js runs this against `main`
// and against this branch and requires identical output.
//
//   node test/support/scenario.js <repoDir> <databaseName>
// ============================================================================

"use strict";

const path = require("path");
const net = require("net");
const H = require("./harness");

const repoDir = path.resolve(process.argv[2]);
const dbName = process.argv[3];

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); });
});

const VOLATILE = /(_at$|^created|^updated|^received|^sent$|^last_ok)/;
function normalise(rows) {
  return rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !VOLATILE.test(k))));
}

async function main() {
  const url = await H.createDatabase(dbName, repoDir);
  const port = await freePort();
  process.env.PORT = String(port);
  H.setEnv(url);
  const sent = H.stubOutside(repoDir);

  const mod = require(path.join(repoDir, "server.js"));
  if (mod && mod.app) mod.app.listen(port);          // branch: exported app
  // main: server.js listens on PORT by itself when required.
  const base = `http://127.0.0.1:${port}`;
  await H.waitFor(async () => { try { return (await fetch(base + "/")).ok; } catch { return false; } });

  const db = require(path.join(repoDir, "db"));
  const productSync = require(path.join(repoDir, "productSync.js"));
  await H.waitFor(async () => { try { await productSync.ensureSchema(db); return true; } catch { return false; } });
  await db.query(H.FIXTURE_SQL);

  const orderAt = (h) => `2026-10-08T0${h}:00:00+05:00`;
  const L = (base, q, id) => ({ id, quantity: q, vendor: "Apna Sasta Bazaar", ...base });
  const order = (id, name, lines, phone, h) => ({ ...H.shopifyOrder({ id, name, lines, phone, createdAt: orderAt(h) }) });
  const send = async (payload, hook, topic = "orders/create") => {
    const s = await H.postShopify(base, payload, { id: hook, topic });
    if (s !== 200) throw new Error(`webhook ${hook} answered ${s}`);
    await H.waitWebhookDone(db, "shopify", hook);
  };

  // 1. ordinary order, 2. same household again (merge), 3. unknown grocery product (stub path)
  await send(order(5001, "#G1", [L(H.GROCERY.aloo, 2, 1), L(H.GROCERY.mango, 1, 2)], "+92 300 1111111", 1), "g-1");
  await send(order(5002, "#G2", [L(H.GROCERY.aloo, 1, 3)], "+92 300 1111111", 2), "g-2");
  await send(order(5003, "#G3", [L({ variant_id: 47000000000099, product_id: 9000000000099, sku: "ASB-VEG-099",
                                     title: "Bhindi — 1 kg | بھنڈی", price: "160.00" }, 1, 4)], "+92 300 2222222", 3), "g-3");
  // 4. exact redelivery
  const s = await H.postShopify(base, order(5001, "#G1", [L(H.GROCERY.aloo, 2, 1), L(H.GROCERY.mango, 1, 2)], "+92 300 1111111", 1), { id: "g-1" });
  if (s !== 200) throw new Error("redelivery not 200");
  // 5. grocery price change from Shopify
  await send({ id: 9000000000002, title: "Chonsa Aam — 1 kg | آم", status: "active", product_type: "Fruits",
               vendor: "Apna Sasta Bazaar", tags: "", variants: [{ id: 47000000000002, sku: "ASB-FRT-001", price: "240.00", compare_at_price: "340.00" }] },
             "p-1", "products/update");
  // 6. WhatsApp: a customer writes, then orders on Shopify inside the 24h window (bill goes as free text)
  const inbound = { object: "whatsapp_business_account", entry: [{ id: "1", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { phone_number_id: "000000" },
    contacts: [{ profile: { name: "Sana" }, wa_id: "923003333333" }],
    messages: [{ from: "923003333333", id: "wamid.IN1", timestamp: "1791427200", type: "text", text: { body: "Salam, aloo hai?" } }] } }] }] };
  if ((await H.postWhatsApp(base, inbound)) !== 200) throw new Error("wa webhook");
  await H.waitFor(async () => (await db.query(`SELECT 1 FROM whatsapp_messages WHERE wamid = 'wamid.IN1'`)).rows.length);
  await send(order(5004, "#G4", [L(H.GROCERY.mango, 2, 5)], "+92 300 3333333", 4), "g-4");
  // 7. an order typed in the inbox (WhatsApp ordering)
  const orders = require(path.join(repoDir, "orders.js"));
  await db.tx((c) => orders.saveInboxOrder(c, { phone: "923004444444", name: "Inbox Bibi",
    orderedAt: new Date("2026-10-08T03:00:00Z"), lines: [{ sku: "ASB-VEG-001", packs: 3 }, { sku: "ASB-FRT-001", packs: 1 }],
    enteredBy: "golden" }));

  const dump = {};
  const q = async (k, sql) => { dump[k] = normalise((await db.query(sql)).rows); };
  await q("products", `SELECT * FROM products ORDER BY id`);
  await q("customers", `SELECT * FROM customers ORDER BY id`);
  await q("cycles", `SELECT * FROM cycles ORDER BY id`);
  await q("orders", `SELECT * FROM orders ORDER BY id`);
  await q("order_items", `SELECT * FROM order_items ORDER BY id`);
  await q("cycle_prices", `SELECT * FROM cycle_prices ORDER BY id`);
  await q("procurement", `SELECT * FROM v_cycle_procurement ORDER BY cycle_id, product_id`);
  await q("packing", `SELECT * FROM v_packing_queue ORDER BY order_id`);
  await q("webhook_events", `SELECT source, event_id, topic, status, attempts, error_detail FROM webhook_events ORDER BY source, event_id`);
  await q("whatsapp_messages", `SELECT idempotency_key, customer_id, order_id, phone, direction, template_name, wamid, status,
                                       msg_type, body_preview FROM whatsapp_messages ORDER BY idempotency_key NULLS LAST, wamid`);
  dump.sends = sent;

  const has016 = (await db.query(`SELECT to_regclass('community_intake') IS NOT NULL AS t`)).rows[0].t;
  const community = has016
    ? (await db.query(`SELECT (SELECT count(*) FROM community_intake)::int AS intake,
                              (SELECT count(*) FROM community_products)::int AS products`)).rows[0]
    : null;

  process.stdout.write("\n@@RESULT@@" + JSON.stringify({ dump, community }) + "\n");
  await db.shutdown();
  process.exit(0);
}

main().catch((e) => { console.error("scenario failed:", e); process.exit(1); });
