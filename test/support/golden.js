// ============================================================================
// Golden comparison runner (shared by the two golden tests).
//
// Runs test/support/scenario.js against a baseline checkout (git archive of a
// fixed commit) and against this working tree, each with its own fresh
// database, and requires identical grocery + WhatsApp rows and messages,
// except for keys listed as an EXPECTED difference for that baseline.
//
// Guards: a missing baseline FAILS when CI=1 (skips locally with a reason); a
// baseline whose tree equals a clean HEAD fails as vacuous.
// ============================================================================
"use strict";

const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { execFileSync, execSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const SCENARIO = path.join(__dirname, "scenario.js");

function git(args) {
  return execSync(`git -C "${ROOT}" ${args}`, { stdio: "pipe", encoding: "utf8" }).trim();
}

function run(repoDir, dbName) {
  const out = execFileSync(process.execPath, [SCENARIO, repoDir, dbName], {
    env: { ...process.env, PORT: "" }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 180000,
  });
  const at = out.lastIndexOf("@@RESULT@@");
  assert.ok(at >= 0, "scenario printed no result:\n" + out.slice(-2000));
  const start = at + "@@RESULT@@".length;
  const end = out.indexOf("\n", start);
  return JSON.parse(out.slice(start, end < 0 ? undefined : end));
}

/** Resolve the baseline commit; returns null (with reason) when unavailable. */
function resolveBaseline({ sha, tag }) {
  let have;
  try { have = git(`rev-parse --verify ${sha}^{commit}`); } catch { return { missing: `commit ${sha} not in this clone` }; }
  if (tag) {
    let tagged = null;
    try { tagged = git(`rev-parse --verify refs/tags/${tag}^{commit}`); } catch { /* tag not fetched */ }
    if (tagged && tagged !== have) throw new Error(`tag ${tag} points at ${tagged}, golden-baseline.json says ${have}`);
  }
  return { sha: have };
}

function runGolden(t, { sha, tag, label, expectedDiff = [] }) {
  const b = resolveBaseline({ sha, tag });
  if (b.missing) {
    if (process.env.CI === "1") assert.fail(`golden baseline ${label}: ${b.missing} (fetch it: git fetch origin ${sha})`);
    t.skip(`golden baseline ${label}: ${b.missing}`);
    return null;
  }
  const clean = git("status --porcelain") === "";
  if (clean && git(`rev-parse ${b.sha}^{tree}`) === git("rev-parse HEAD^{tree}")) {
    assert.fail(`golden baseline ${label} has the same tree as HEAD - the comparison would prove nothing`);
  }
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "asb-golden-"));
  try {
    execSync(`git -C "${ROOT}" archive ${b.sha} | tar -x -C "${baseDir}"`, { stdio: "pipe", shell: "/bin/bash" });
    fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(baseDir, "node_modules"), "dir");
    const tag8 = b.sha.slice(0, 8);
    const before = run(baseDir, `asb_t_golden_${tag8}`);
    const after = run(ROOT, `asb_t_golden_head_${tag8}`);
    for (const k of Object.keys(before.dump)) {
      if (expectedDiff.includes(k)) continue;
      assert.deepEqual(after.dump[k], before.dump[k], `"${k}" differs from ${label}`);
    }
    assert.ok(before.dump.orders.length >= 3, "scenario created grocery orders");
    assert.ok(before.dump.sends.length >= 3, "scenario sent grocery bills");
    return { before, after };
  } finally {
    fs.rmSync(baseDir, { recursive: true, force: true });
  }
}

module.exports = { runGolden, ROOT };
