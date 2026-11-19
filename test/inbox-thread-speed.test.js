// Opening a chat (19 Nov 2026): the header comes from direct queries, not the
// all-chats view, and the newest messages are returned (not the oldest 500).
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const H = require("./support/harness");

const ROOT = path.join(__dirname, "..");
let db, server, base, cookie;

before(async () => {
  const url = await H.createDatabase("asb_t_inbox_thread", ROOT);
  H.setEnv(url);
  process.env.INBOX_PASSWORD = "local-test-only";
  process.env.INBOX_COOKIE_SECRET = "local-test-only-secret";
  H.stubOutside(ROOT);
  const mod = require(path.join(ROOT, "server.js"));
  db = require(path.join(ROOT, "db"));
  server = mod.app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const r = await fetch(`${base}/api/inbox/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ password: "local-test-only", name: "test" }),
  });
  assert.equal(r.status, 200);
  cookie = (r.headers.get("set-cookie") || "").split(";")[0];
});
after(async () => {
  server?.close();
  await new Promise((r) => setTimeout(r, 200));
  await db?.shutdown();
});

const thread = async (phone) => (await fetch(`${base}/api/inbox/thread/${phone}`, { headers: { cookie } })).json();

test("header: saved name, else WhatsApp name; reply window from her last message", async () => {
  const now = Date.now();
  await db.query(
    `INSERT INTO whatsapp_messages (wamid, phone, direction, body_preview, msg_type, status, received_at, profile_name)
     VALUES ('wamid.h1', '923004440001', 'inbound', 'salam', 'text', 'delivered', $1, 'Ayesha WA')`, [new Date(now - 3600e3)]);
  let t = await thread("923004440001");
  assert.equal(t.conversation.display_name, "Ayesha WA");
  assert.equal(t.conversation.window_open, true);
  assert.ok(t.conversation.window_minutes_left > 1300 && t.conversation.window_minutes_left <= 1380);

  await db.query(`INSERT INTO customers (phone, name) VALUES ('923004440001', 'Ayesha Khan')`);
  t = await thread("923004440001");
  assert.equal(t.conversation.display_name, "Ayesha Khan");

  t = await thread("923004440009");   // nobody: still answers, window closed
  assert.equal(t.conversation.window_open, null);
  assert.deepEqual(t.messages, []);
});

test("a long chat shows its NEWEST 300 messages, oldest first", async () => {
  const t0 = new Date("2026-01-01T00:00:00Z").getTime();
  const vals = [];
  for (let i = 0; i < 350; i++) vals.push(`('wamid.l${i}', '923004440002', 'inbound', 'm${i}', 'text', 'delivered', to_timestamp(${(t0 + i * 60000) / 1000}))`);
  await db.query(`INSERT INTO whatsapp_messages (wamid, phone, direction, body_preview, msg_type, status, received_at) VALUES ${vals.join(",")}`);
  const t = await thread("923004440002");
  assert.equal(t.messages.length, 300);
  assert.equal(t.messages[0].body_preview, "m50");
  assert.equal(t.messages.at(-1).body_preview, "m349");
});
