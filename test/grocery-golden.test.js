// ============================================================================
// Golden test (ongoing): grocery + WhatsApp behaviour is identical to the
// PREVIOUS PRODUCTION RELEASE (test/golden-baseline.json), apart from the
// reviewed expected differences listed there.
// ============================================================================
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { runGolden } = require("./support/golden");
const baseline = require("./golden-baseline.json");

test(`grocery + WhatsApp behaviour identical to the previous release ${baseline.tag} (${baseline.sha.slice(0, 7)})`,
  { timeout: 300000 }, (t) => {
    const r = runGolden(t, { sha: baseline.sha, tag: baseline.tag, label: baseline.tag, expectedDiff: baseline.expected_diff });
    if (!r) return;
    assert.deepEqual(r.after.community, { intake: 0, products: 0 });
    // 017 bookkeeping for the same traffic: every order applied once, every bill sent once.
    assert.deepEqual(r.after.grocery017, {
      sources: { applied: 4 }, bills: { sent: 4 }, attempts: 4, duplicates: 0, alerts: 0,
    });
  });
