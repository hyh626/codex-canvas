import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";
import Ajv2020 from "ajv/dist/2020.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const corpusRoot = path.join(here, "cases", "v2");
const schemaRoot = path.join(here, "schema");
const expectedScenarios = [
  "proposal-review",
  "agent-concurrent-edit",
  "agent-failure",
  "coordinated-change",
  "comment-lifecycle",
  "export-restore",
  "reconnect",
  "accessibility",
];

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const readJsonl = (file) =>
  fs.readFileSync(file, "utf8").split("\n").filter(Boolean).map(JSON.parse);

function loadValidators() {
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
  const files = ["case.schema.json", "action.schema.json", "expectations.schema.json"];
  return Object.fromEntries(
    files.map((file) => [file, ajv.compile(readJson(path.join(schemaRoot, file)))]).concat([
      ["model.schema.json", ajv.compile(readJson(path.join(here, "..", "model.schema.json")))],
    ]),
  );
}

function checkSchema(validators, schema, value, label, errors) {
  if (!validators[schema](value))
    errors.push(`${label}: ${JSON.stringify(validators[schema].errors)}`);
}

export function validateV2Inputs(root = corpusRoot) {
  const errors = [];
  const validators = loadValidators();
  let manifest;
  try {
    manifest = readJson(path.join(root, "manifest.json"));
  } catch (error) {
    return [`manifest.json: ${error.message}`];
  }
  if (manifest.format !== "canvas-render-eval-input-manifest-v2")
    errors.push("manifest.json: invalid format");
  if (!Array.isArray(manifest.cases)) return [...errors, "manifest.json: cases must be an array"];
  const isV3 = manifest.cases.length === 15 && manifest.cases.every((id) => /^(create|text|branch|move|selection)\//.test(id));
  if (isV3) return validateV3Inputs(root, manifest, validators);
  if (manifest.cases.length !== 24 || manifest.case_count !== 24)
    errors.push("manifest.json: expected exactly 24 new cases");
  if (manifest.examples_per_scenario !== 3)
    errors.push("manifest.json: examples_per_scenario must be 3");
  if (new Set(manifest.cases).size !== manifest.cases.length)
    errors.push("manifest.json: case IDs must be unique");

  for (const scenario of expectedScenarios) {
    const count = manifest.cases.filter((id) => id.startsWith(`${scenario}/`)).length;
    if (count !== 3) errors.push(`manifest.json: ${scenario} requires three examples, found ${count}`);
  }

  for (const caseId of manifest.cases) {
    if (typeof caseId !== "string" || !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(caseId)) {
      errors.push(`manifest.json: invalid case ID ${String(caseId)}`);
      continue;
    }
    const directory = path.join(root, caseId);
    let spec;
    let config;
    let fixture;
    let actions;
    let expectations;
    try {
      spec = readJson(path.join(directory, "spec.json"));
      config = readJson(path.join(directory, "case.json"));
      fixture = readJson(path.join(directory, "fixture.json"));
      actions = readJsonl(path.join(directory, "actions.jsonl"));
      expectations = readJson(path.join(directory, "expectations.json"));
    } catch (error) {
      errors.push(`${caseId}: ${error.message}`);
      continue;
    }
    if (spec.case_id !== caseId || config.case_id !== caseId || expectations.case_id !== caseId)
      errors.push(`${caseId}: case IDs must agree across files`);
    if (spec.scenario_id !== caseId.split("/")[0] || config.scenario_id !== spec.scenario_id)
      errors.push(`${caseId}: scenario IDs must agree across files`);
    checkSchema(validators, "case.schema.json", config, `${caseId}/case.json`, errors);
    checkSchema(validators, "expectations.schema.json", expectations, `${caseId}/expectations.json`, errors);
    checkSchema(validators, "model.schema.json", fixture, `${caseId}/fixture.json`, errors);
    checkSchema(validators, "model.schema.json", expectations.initial_model, `${caseId}/initial_model`, errors);
    if (!isDeepStrictEqual(fixture, expectations.initial_model))
      errors.push(`${caseId}: fixture and independent initial model disagree`);
    const fingerprint = crypto.createHash("sha256")
      .update(`${JSON.stringify({ spec, fixture, expectations, actions }, null, 2)}\n`)
      .digest("hex");
    if (config.reproducibility?.semantic_fingerprint !== fingerprint)
      errors.push(`${caseId}: semantic fingerprint does not match inputs`);
    if (actions.length < 2 || actions[0]?.kind !== "seed_fixture")
      errors.push(`${caseId}: first action must seed the fixture and one further action is required`);
    if (actions.length !== expectations.checkpoints?.length)
      errors.push(`${caseId}: each action requires one expectation checkpoint`);
    const checkpoints = new Map(expectations.checkpoints?.map((entry) => [entry.checkpoint_id, entry]) ?? []);
    const actionIds = new Set();
    for (const [index, action] of actions.entries()) {
      checkSchema(validators, "action.schema.json", action, `${caseId}/action ${index + 1}`, errors);
      if (action.step !== index + 1) errors.push(`${caseId}: action steps must be consecutive`);
      if (actionIds.has(action.action_id)) errors.push(`${caseId}: duplicate action ID ${action.action_id}`);
      actionIds.add(action.action_id);
      const checkpoint = checkpoints.get(action.expectation_checkpoint_id);
      if (!checkpoint || checkpoint.after_action_id !== action.action_id)
        errors.push(`${caseId}: action ${action.action_id} must match one checkpoint`);
      if (checkpoint) {
        checkSchema(validators, "model.schema.json", checkpoint.expected_model, `${caseId}/${checkpoint.checkpoint_id}/model`, errors);
        const actualPhases = action.live_capture_points.map((point) => point.phase).sort();
        const expectedPhases = checkpoint.live_checkpoints.map((point) => point.phase).sort();
        if (JSON.stringify(actualPhases) !== JSON.stringify(expectedPhases))
          errors.push(`${caseId}: capture phases differ for ${action.action_id}`);
      }
    }
    if (!checkpoints.has(expectations.final_checkpoint_id))
      errors.push(`${caseId}: final checkpoint is missing`);
  }
  return errors;
}

function validateV3Inputs(root, manifest, validators) {
  const errors = [];
  const expectedGroups = ["create", "text", "branch", "move", "selection"];
  if (manifest.case_count !== 15 || manifest.examples_per_scenario !== 3)
    errors.push("v3 manifest must declare 15 cases and three examples per group");
  for (const group of expectedGroups) {
    const count = manifest.cases.filter((id) => id.startsWith(`${group}/`)).length;
    if (count !== 3) errors.push(`v3 manifest: ${group} requires three cases, found ${count}`);
  }
  for (const caseId of manifest.cases) {
    if (typeof caseId !== "string" || !/^[a-z0-9-]+\/[a-z0-9-]+$/.test(caseId)) {
      errors.push(`manifest.json: invalid case ID ${String(caseId)}`);
      continue;
    }
    const directory = path.join(root, caseId);
    let spec, fixture, actions, expectations;
    try {
      spec = readJson(path.join(directory, "spec.json"));
      fixture = readJson(path.join(directory, "fixture.json"));
      actions = readJsonl(path.join(directory, "actions.jsonl"));
      expectations = readJson(path.join(directory, "expectations.json"));
    } catch (error) {
      errors.push(`${caseId}: ${error.message}`);
      continue;
    }
    if (spec.case_id !== caseId || expectations.case_id !== caseId || spec.scenario_id !== caseId.split("/")[0])
      errors.push(`${caseId}: case IDs must agree across files`);
    checkSchema(validators, "expectations.schema.json", expectations, `${caseId}/expectations.json`, errors);
    checkSchema(validators, "model.schema.json", fixture, `${caseId}/fixture.json`, errors);
    checkSchema(validators, "model.schema.json", expectations.initial_model, `${caseId}/initial_model`, errors);
    if (!isDeepStrictEqual(fixture, expectations.initial_model)) errors.push(`${caseId}: fixture and initial model disagree`);
    if (actions.length < 2 || actions[0]?.kind !== "seed_fixture") errors.push(`${caseId}: first action must seed the fixture`);
    if (actions.length !== expectations.checkpoints?.length) errors.push(`${caseId}: each action requires one expectation checkpoint`);
    const checkpoints = new Map(expectations.checkpoints?.map((entry) => [entry.checkpoint_id, entry]) ?? []);
    for (const [index, action] of actions.entries()) {
      checkSchema(validators, "action.schema.json", action, `${caseId}/action ${index + 1}`, errors);
      if (action.step !== index + 1) errors.push(`${caseId}: action steps must be consecutive`);
      const checkpoint = checkpoints.get(action.expectation_checkpoint_id);
      if (!checkpoint || checkpoint.after_action_id !== action.action_id) errors.push(`${caseId}: action ${action.action_id} must match a checkpoint`);
      if (checkpoint) checkSchema(validators, "model.schema.json", checkpoint.expected_model, `${caseId}/${checkpoint.checkpoint_id}/model`, errors);
    }
    if (!checkpoints.has(expectations.final_checkpoint_id)) errors.push(`${caseId}: final checkpoint is missing`);
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const corpusArg = process.argv.indexOf("--corpus");
  const namedCorpus = corpusArg >= 0 ? process.argv[corpusArg + 1] : null;
  const rootArg = namedCorpus
    ? path.join(here, "cases", namedCorpus)
    : process.argv[2] && !process.argv[2].startsWith("-")
      ? path.resolve(process.argv[2])
      : corpusRoot;
  const errors = validateV2Inputs(rootArg);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else console.log(`valid CUJ input corpus: ${readJson(path.join(rootArg, "manifest.json")).cases.length} cases`);
}
