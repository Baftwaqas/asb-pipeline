// ============================================================================
// Golden test: ordinary grocery + WhatsApp traffic must produce EXACTLY the
// same database rows and the same customer messages on this branch as on
// `main` (or GOLDEN_BASE_REF).
//
// It exports the base ref with `git archive` into a temp folder, runs
// test/support/scenario.js against each checkout with its own fresh database
// and its own migrations, and compares the normalised dumps.
// ============================================================================

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync, execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const REF = process.env.GOLDEN_BASE_REF || "main";
const SCENARIO = path.join(__dirname, "support", "scenario.js");

function run(repoDir, dbName) {
  const out = execFileSync(process.execPath, [SCENARIO, repoDir, dbName], {
    env: { ...process.env, PORT: "" }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120000,
  });
  const at = out.lastIndexOf("@@RESULT@@");
  assert.ok(at >= 0, "scenario printed no result:\n" + out.slice(-2000));
  const start = at + "@@RESULT@@".length;
  const end = out.indexOf("\n", start);
  return JSON.parse(out.slice(start, end < 0 ? undefined : end));
}

test(`grocery + WhatsApp behaviour identical to ${REF}`, (t) => {
  let baseDir;
  try {
    execSync(`git -C "${ROOT}" rev-parse --verify ${REF}`, { stdio: "pipe" });
  } catch {
    t.skip(`git ref ${REF} not available`);
    return;
  }
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "asb-golden-"));
  try {
    execSync(`git -C "${ROOT}" archive ${REF} | tar -x -C "${baseDir}"`, { stdio: "pipe", shell: "/bin/bash" });
    fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(baseDir, "node_modules"), "dir");

    const before = run(baseDir, "asb_t_golden_base");
    const after = run(ROOT, "asb_t_golden_branch");

    for (const k of Object.keys(before.dump)) {
      assert.deepEqual(after.dump[k], before.dump[k], `"${k}" differs from ${REF}`);
    }
    assert.ok(before.dump.orders.length >= 3, "scenario created grocery orders");
    assert.ok(before.dump.sends.length >= 3, "scenario sent grocery bills");
    // And the branch's new tables stayed empty under grocery-only traffic.
    assert.deepEqual(after.community, { intake: 0, products: 0 });
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
});
