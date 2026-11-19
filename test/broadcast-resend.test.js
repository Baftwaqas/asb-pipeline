// The "please send your message again" notice goes out through the same
// broadcast worker as the rate list, as its own approved template (19 Nov 2026).
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const H = require("./support/harness");

const ROOT = path.join(__dirname, "..");
let db, broadcast, wa, T;
const calls = [];

before(async () => {
  const url = await H.createDatabase("asb_t_bc_resend", ROOT);
  H.setEnv(url);
  H.stubOutside(ROOT);
  process.env.BROADCAST_GAP_MS = "1";
  db = require(path.join(ROOT, "db"));
  wa = require(path.join(ROOT, "whatsapp.js"));
  T = require(path.join(ROOT, "templates.js"));
  wa.sendTemplate = async (to, name, params, opts) => {
    calls.push({ to, name, params, header: opts.headerImageId || null });
    return { ok: true, wamid: "wamid.bc" + calls.length, data: {} };
  };
  broadcast = require(path.join(ROOT, "broadcast.js"));
});
after(async () => { await db?.shutdown(); });

async function runToEnd(id) {
  broadcast.start(db, id, null);
  await H.waitFor(async () => ["done", "stopped"].includes((await broadcast.status(db, id)).status));
  return broadcast.status(db, id);
}

test("the notice: its own template, no poster, no wording to fill; STOP numbers left out", async () => {
  await db.query(`INSERT INTO marketing_opt_outs (phone, source) VALUES ('923009990000', 'replied STOP')`);
  calls.length = 0;
  const id = await broadcast.create(db, {
    agent: "test", phones: ["923001110001", "923001110002", "923009990000"], kind: "resend_request",
  });
  const s = await runToEnd(id);
  assert.equal(s.status, "done");
  assert.equal(s.sent, 2);
  assert.equal(s.skipped, 1);
  assert.deepEqual(calls.map((c) => [c.name, c.params.length, c.header]), [
    ["asb_resend_request_v1", 0, null], ["asb_resend_request_v1", 0, null],
  ]);
});

test("the rate list is unchanged: its template, the poster and the two filled-in lines", async () => {
  calls.length = 0;
  const id = await broadcast.create(db, {
    agent: "test", phones: ["923001110003"], mediaId: "media-9", delivery: "Monday, 23 November", cutoff: "Sunday, 8 PM",
  });
  await runToEnd(id);
  assert.equal(calls[0].name, T.TEMPLATES.rateList.name);
  assert.equal(calls[0].header, "media-9");
  assert.equal(calls[0].params.length, 2);
});

test("what is submitted to Meta for the notice has no example block (it has no variables)", () => {
  const d = T.definition(T.TEMPLATES.resendRequest);
  const bodyC = d.components.find((c) => c.type === "BODY");
  assert.equal(bodyC.example, undefined);
  assert.equal(d.category, "UTILITY");
});

test("who gets the notice: chosen from the chat history by 7 / 14 / 30 days, ever, or one by one; STOP never", async () => {
  const now = new Date("2026-11-19T09:00:00Z");
  const day = 86400000;
  const msg = (phone, daysAgo, i) => db.query(
    `INSERT INTO whatsapp_messages (wamid, phone, direction, body_preview, msg_type, status, received_at, profile_name)
     VALUES ($1, $2, 'inbound', 'x', 'text', 'delivered', $3, 'P')`,
    [`wamid.pick${i}`, phone, new Date(now.getTime() - daysAgo * day)]);
  await msg("923002000001", 2, 1);     // this week
  await msg("923002000002", 10, 2);    // two weeks
  await msg("923002000003", 25, 3);    // this month
  await msg("923002000004", 200, 4);   // long ago
  await msg("923002000005", 1, 5);     // this week, but said STOP
  await db.query(`INSERT INTO marketing_opt_outs (phone, source) VALUES ('923002000005', 'replied STOP')`);
  // a customer who never messaged is never picked by the notice
  await db.query(`INSERT INTO customers (phone) VALUES ('923002000099') ON CONFLICT DO NOTHING`);

  const pick = async (who, chosen) => (await broadcast.pickFromChats(db, { who, chosen, now })).phones.sort();
  assert.deepEqual(await pick("7"), ["923002000001"]);
  assert.deepEqual(await pick("14"), ["923002000001", "923002000002"]);
  assert.deepEqual(await pick("30"), ["923002000001", "923002000002", "923002000003"]);
  assert.ok((await pick("ever")).includes("923002000004"));
  assert.ok(!(await pick("ever")).includes("923002000099"));
  assert.ok(!(await pick("ever")).includes("923002000005"));
  assert.deepEqual(await pick("choose", ["923002000002", "0300 2000005", "0321-1234567"]), ["923002000002", "923211234567"]);
  const counts = broadcast.chatCounts(await broadcast.chatPeople(db), now);
  assert.equal(counts["7"], 1);
  assert.equal(counts["30"], 3);
});
