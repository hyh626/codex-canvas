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
  const result = await runEval({ caseIds: ["human-edit/nominal"], runsRoot: root, id: "test-run" });
  assert.equal(
    result.results[0].summary.status,
    "pass",
    JSON.stringify(result.results[0].summary.failures, null, 2),
  );
  assert.deepEqual(validateRun(result.output), []);
  const caseRoot = path.join(result.output, "cases", "human-edit", "nominal");
  assert.ok(fs.readFileSync(path.join(caseRoot, "trajectory", "events.jsonl"), "utf8").includes("workspace.edit_committed"));
  const capture = JSON.parse(fs.readFileSync(path.join(caseRoot, "observations", "captures.jsonl"), "utf8").split("\n")[0]);
    const artifact = capture.evidence.captures[0].artifact;
    const png = fs.readFileSync(path.join(caseRoot, "artifacts", "sha256", artifact.path ?? artifact.sha256));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
});
