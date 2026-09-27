import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runEval } from "../eval/run.mjs";
import { validateRun } from "../eval/validate-run.mjs";

test("G9 runner executes, captures and validates a real headless Chromium case", { timeout: 120_000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-g9-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const result = await runEval({ caseIds: ["human-edit/nominal", "comment-agent/nominal", "comment-agent/invalid-proposal"], runsRoot: root, id: "test-run" });
  for (const item of result.results) {
    assert.equal(item.summary.status, "pass", `${item.caseId}: ${JSON.stringify(item.summary.failures, null, 2)}`);
  }
  assert.deepEqual(validateRun(result.output), []);
  const caseRoot = path.join(result.output, "cases", "human-edit", "nominal");
  assert.ok(fs.readFileSync(path.join(caseRoot, "trajectory", "events.jsonl"), "utf8").includes("workspace.edit_committed"));
  const capture = JSON.parse(fs.readFileSync(path.join(caseRoot, "observations", "captures.jsonl"), "utf8").split("\n")[0]);
    const artifact = capture.evidence.captures[0].artifact;
    const png = fs.readFileSync(path.join(caseRoot, "artifacts", "sha256", artifact.path ?? artifact.sha256));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const agentRoot = path.join(result.output, "cases", "comment-agent", "nominal");
  const trajectory = JSON.parse(fs.readFileSync(path.join(agentRoot, "execution", "action-results.jsonl"), "utf8").trim().split("\n").at(-1));
  assert.equal(trajectory.status, "succeeded");
  assert.equal(trajectory.gate.status, "released");
  assert.ok(trajectory.capture_ids.some((id) => id.endsWith("-during")));
  const failedRoot = path.join(result.output, "cases", "comment-agent", "invalid-proposal");
  const failedActions = fs.readFileSync(path.join(failedRoot, "execution", "action-results.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(failedActions.at(-1).status, "failed");
  const gateFailure = await runEval({ caseIds: ["comment-agent/nominal"], runsRoot: root, id: "gate-failure-run", faultOverrides: { "agent-title": "agent-fails-before-gate" } });
  const gateFailureCase = path.join(gateFailure.output, "cases", "comment-agent", "nominal");
  const gateFailureActions = fs.readFileSync(path.join(gateFailureCase, "execution", "action-results.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  assert.equal(gateFailureActions.at(-1).status, "failed");
  assert.equal(gateFailureActions.at(-1).gate.status, "not_reached");
});
