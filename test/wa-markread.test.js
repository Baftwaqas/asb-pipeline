"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

test("a read receipt answered {success:true} is a success, not AMBIGUOUS", async () => {
  process.env.PHONE_NUMBER_ID = process.env.PHONE_NUMBER_ID || "1";
  process.env.WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN || "test-only";
  const wa = require("../whatsapp");
  const real = global.fetch, realErr = console.error;
  const errors = [];
  console.error = (...a) => errors.push(a.join(" "));
  global.fetch = async () => new Response(JSON.stringify({ success: true }), { status: 200 });
  try {
    const r = await wa.markRead("wamid.test");
    assert.equal(r.ok, true);
    assert.equal(errors.filter((e) => /AMBIGUOUS/.test(e)).length, 0);
  } finally {
    global.fetch = real; console.error = realErr;
  }
});
