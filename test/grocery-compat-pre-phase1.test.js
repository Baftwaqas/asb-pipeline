// ============================================================================
// Fixed compatibility test: grocery + WhatsApp behaviour is still identical
// to the pre-Phase-1 commit 2904c910 (the last code before Community
// isolation). Kept until it is deliberately retired by an approved decision.
// ============================================================================
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { runGolden } = require("./support/golden");

const PRE_PHASE_1 = "2904c9108c4f0ba56ac6873a71a76daba6baef15";

test("grocery + WhatsApp behaviour identical to pre-Phase-1 2904c91", { timeout: 300000 }, (t) => {
  const r = runGolden(t, { sha: PRE_PHASE_1, label: "pre-Phase-1 2904c91" });
  if (!r) return;
  assert.equal(r.before.community, null, "the baseline really predates migration 016");
  assert.deepEqual(r.after.community, { intake: 0, products: 0 });
});
