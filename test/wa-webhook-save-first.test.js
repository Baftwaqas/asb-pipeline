// The WhatsApp webhook says "received" only after the event is saved (19 Nov 2026).
// That day the database was paused: ten customer messages were answered 200,
// failed to save, and Meta never resent them. Now a failed save answers 503,
// so Meta retries, and the retried message is saved once the database is back.
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const H = require("./support/harness");

const ROOT = path.join(__dirname, "..");
let db, server, base;

before(async () => {
  const url = await H.createDatabase("asb_t_wa_save_first", ROOT);
  H.setEnv(url);
  H.stubOutside(ROOT);
  const mod = require(path.join(ROOT, "server.js"));
  db = require(path.join(ROOT, "db"));
  server = mod.app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  server?.close();
  await new Promise((r) => setTimeout(r, 200));
  await db?.shutdown();
});

const hook = (wamid, text) => ({
  object: "whatsapp_business_account",
  entry: [{ id: "1", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp",
    contacts: [{ wa_id: "923001112233", profile: { name: "Ayesha" } }],
    messages: [{ from: "923001112233", id: wamid, timestamp: "1795000000", type: "text", text: { body: text } }],
  } }] }],
});
const saved = async (wamid) => (await db.query(`SELECT body_preview FROM whatsapp_messages WHERE wamid = $1`, [wamid])).rows[0];

test("database down: 503 so Meta retries, nothing acknowledged; the retry is saved once it is back", async () => {
  const real = db.recordWebhook;
  db.recordWebhook = async () => { throw new Error("Your account or project has exceeded the quota."); };
  try {
    assert.equal(await H.postWhatsApp(base, hook("wamid.DOWN1", "2 kg aloo chahiye")), 503);
  } finally { db.recordWebhook = real; }
  assert.equal(await saved("wamid.DOWN1"), undefined);

  // Meta's retry: the very same payload
  assert.equal(await H.postWhatsApp(base, hook("wamid.DOWN1", "2 kg aloo chahiye")), 200);
  await H.waitFor(async () => saved("wamid.DOWN1"));
  assert.equal((await saved("wamid.DOWN1")).body_preview, "2 kg aloo chahiye");
});

test("database up: 200, saved once; a repeat delivery is ignored", async () => {
  assert.equal(await H.postWhatsApp(base, hook("wamid.UP1", "tamatar ka rate?")), 200);
  await H.waitFor(async () => saved("wamid.UP1"));
  assert.equal(await H.postWhatsApp(base, hook("wamid.UP1", "tamatar ka rate?")), 200);
  const n = (await db.query(`SELECT count(*)::int AS n FROM whatsapp_messages WHERE wamid = 'wamid.UP1'`)).rows[0].n;
  assert.equal(n, 1);
});
