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
