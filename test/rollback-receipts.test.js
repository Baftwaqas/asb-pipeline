"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const H = require("./support/harness");

const ROOT = path.join(__dirname, "..");
let db, server, base;

function receiptBody(statuses) {
  return { object: "whatsapp_business_account", entry: [{ id: "1", changes: [{
    field: "messages", value: { messaging_product: "whatsapp",
      metadata: { phone_number_id: "000000" }, statuses }
  }] }] };
}
const st = (id, status, ts, recipient = "923000000001") =>
  ({ id, status, timestamp: String(ts), recipient_id: recipient });

before(async () => {
  const url = await H.createDatabase("asb_t_rollback_receipts", ROOT);
  H.setEnv(url);
  H.stubOutside(ROOT);
  const mod = require(path.join(ROOT, "server.js"));
  db = require(path.join(ROOT, "db"));
  await new Promise((resolve) => {
    server = mod.app.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((resolve) => server.close(resolve));
  if (db?.shutdown) await db.shutdown();
});

test("L3 receipt journal failure answers 503 before Meta ACK", async () => {
  await db.query(`ALTER TABLE whatsapp_receipt_backlog RENAME TO wrb_hidden`);
  let status;
  try {
    status = await H.postWhatsApp(base, receiptBody([
      st("wamid.L3-JFAIL", "delivered", 1791878000)
    ]));
  } finally {
    await db.query(`ALTER TABLE wrb_hidden RENAME TO whatsapp_receipt_backlog`);
  }
  assert.equal(status, 503);
});

test("L3 journals before ACK and never downgrades read on a late sent receipt", async () => {
  await db.query(
    `INSERT INTO whatsapp_messages
       (idempotency_key, phone, direction, status, wamid, msg_type, body_preview,
        sent_at, delivered_at, read_at, received_at)
     VALUES ('l3:read','923000000003','outbound','read','wamid.L3-READ','text','x',
             now()-interval '3 min',now()-interval '2 min',now()-interval '1 min',now()-interval '3 min')`
  );

  assert.equal(await H.postWhatsApp(base, receiptBody([
    st("wamid.L3-READ", "sent", 1791878060, "923000000003")
  ])), 200);

  await H.waitFor(async () => (
    await db.query(`SELECT 1 FROM whatsapp_receipt_backlog
      WHERE wamid='wamid.L3-READ' AND status='sent'`)
  ).rows.length);

  const m = (await db.query(
    `SELECT status::text, delivered_at, read_at FROM whatsapp_messages WHERE wamid='wamid.L3-READ'`
  )).rows[0];
  assert.equal(m.status, "read");
  assert.ok(m.delivered_at);
  assert.ok(m.read_at);

  const j = (await db.query(
    `SELECT applied_at FROM whatsapp_receipt_backlog
      WHERE wamid='wamid.L3-READ' AND status='sent'`
  )).rows[0];
  assert.equal(j.applied_at, null, "017 must still own bill-proof reconciliation");
});

test("L3 preserves a receipt that arrives before its outbound message row exists", async () => {
  assert.equal(await H.postWhatsApp(base, receiptBody([
    st("wamid.L3-EARLY", "delivered", 1791878120, "923000000004")
  ])), 200);

  const j = await H.waitFor(async () => (
    await db.query(`SELECT applied_at FROM whatsapp_receipt_backlog
      WHERE wamid='wamid.L3-EARLY' AND status='delivered'`)
  ).rows[0] || null);
  assert.equal(j.applied_at, null);

  assert.equal((await db.query(
    `SELECT count(*)::int n FROM whatsapp_messages WHERE wamid='wamid.L3-EARLY'`
  )).rows[0].n, 0);

  // Duplicate Meta delivery remains one durable journal row.
  assert.equal(await H.postWhatsApp(base, receiptBody([
    st("wamid.L3-EARLY", "delivered", 1791878120, "923000000004")
  ])), 200);
  assert.equal((await db.query(
    `SELECT count(*)::int n FROM whatsapp_receipt_backlog
      WHERE wamid='wamid.L3-EARLY' AND status='delivered'`
  )).rows[0].n, 1);
});
