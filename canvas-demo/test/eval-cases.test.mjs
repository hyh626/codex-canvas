import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

import { validate as validateModel } from "../store.mjs";
import { buildCases, buildFaultCorpus } from "../eval/generate-cases.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const evalRoot = path.join(here, "..", "eval");
const schemaDir = path.join(evalRoot, "schema");
const casesRoot = path.join(evalRoot, "cases", "v1");
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
const validators = Object.fromEntries(fs.readdirSync(schemaDir).map((file) => {
  const schema = JSON.parse(fs.readFileSync(path.join(schemaDir, file), "utf8"));
  return [file, ajv.compile(schema)];
}));

function readJson(file) { return JSON.parse(fs.readFileSync(file, "utf8")); }
function readJsonl(file) { return fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }
function check(schema, value, label) {
  assert.equal(validators[schema](value), true, `${label}: ${JSON.stringify(validators[schema].errors)}`);
}

test("generated corpus has the planned 18 cases with three examples per scenario", () => {
  const generated = buildCases();
  assert.equal(generated.length, 18);
  const byScenario = new Map();
  for (const item of generated) byScenario.set(item.spec.scenario_id, (byScenario.get(item.spec.scenario_id) ?? 0) + 1);
  assert.deepEqual(Object.fromEntries(byScenario), {
    "human-edit": 3,
    "comment-agent": 3,
    "shared-undo": 3,
    "component-lifecycle": 3,
    "html-component": 3,
    "audited-request": 3,
  });
  assert.deepEqual(generated.map(({ spec }) => spec.case_id), readJson(path.join(casesRoot, "manifest.json")).cases);
});

test("every generated input and compiled case passes its schema", () => {
  for (const generated of buildCases()) {
    const { spec, fixture, expectations, actions, compiled } = generated;
    const directory = path.join(casesRoot, spec.scenario_id, spec.example_id);
    check("case-spec.schema.json", spec, `${spec.case_id} spec`);
    check("case.schema.json", compiled, `${spec.case_id} case`);
    check("expectations.schema.json", expectations, `${spec.case_id} expectations`);
    validateModel(fixture);
    assert.deepEqual(readJson(path.join(directory, "fixture.json")), fixture);
    assert.deepEqual(readJson(path.join(directory, "expectations.json")), expectations);
    assert.deepEqual(readJson(path.join(directory, "case.json")), compiled);
    assert.deepEqual(readJsonl(path.join(directory, "actions.jsonl")), actions);
    validateModel(expectations.initial_model);
    expectations.checkpoints.forEach((checkpoint) => validateModel(checkpoint.expected_model));
    actions.forEach((action, index) => {
      check("action.schema.json", action, `${spec.case_id} action ${action.action_id}`);
      assert.equal(action.step, index + 1);
      assert.equal(action.expectation_checkpoint_id, `${action.action_id}-checkpoint`);
    });
    assert.equal(new Set(actions.map((action) => action.action_id)).size, actions.length);
    assert.equal(new Set(expectations.checkpoints.map((checkpoint) => checkpoint.checkpoint_id)).size, expectations.checkpoints.length);
    assert.deepEqual(expectations.checkpoints.map((checkpoint) => checkpoint.after_action_id), actions.map((action) => action.action_id));
  }
});

test("generation is deterministic and fault corpus covers nine valid plus three invalid fixtures", () => {
  const first = JSON.stringify(buildCases());
  const second = JSON.stringify(buildCases());
  assert.equal(first, second);
  const faults = buildFaultCorpus();
  assert.equal(faults.length, 12);
  assert.equal(faults.filter((fault) => fault.kind === "valid-fault").length, 9);
  assert.equal(faults.filter((fault) => fault.kind === "invalid-mutation").length, 3);
  const manifest = readJson(path.join(evalRoot, "fault-corpus", "v1", "manifest.json"));
  assert.deepEqual(manifest.faults, faults.map(({ id }) => id));
  for (const fault of faults) {
    const directory = path.join(evalRoot, "fault-corpus", "v1", fault.id);
    assert.deepEqual(readJson(path.join(directory, "source.json")), { source_case_id: fault.sourceCaseId });
    assert.deepEqual(readJson(path.join(directory, "mutation.json")), fault.mutation);
    assert.deepEqual(readJson(path.join(directory, "expected.json")), { kind: fault.kind, ...fault.expected });
  }
});
