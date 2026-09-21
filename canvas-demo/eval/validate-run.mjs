import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

import { validateEvalSemantics } from "./validate-semantics.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaDir = path.join(here, "schema");
const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const readJsonl = (file) => fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const hash = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

function validators() {
  const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
  return Object.fromEntries(fs.readdirSync(schemaDir).map((file) => [file, ajv.compile(readJson(path.join(schemaDir, file)))]));
}

function validateOne(all, schema, value, label, errors) {
  if (!all[schema](value)) errors.push(`${label}: ${JSON.stringify(all[schema].errors)}`);
}

function references(value, found = []) {
  if (!value || typeof value !== "object") return found;
  if (typeof value.sha256 === "string" && Number.isInteger(value.size_bytes) && typeof value.media_type === "string") found.push(value);
  for (const child of Object.values(value)) references(child, found);
  return found;
}

function verifyReferences(refs, directory, label, errors) {
  for (const ref of refs) {
    const relativePath = ref.path ?? ref.sha256;
    if (path.isAbsolute(relativePath) || relativePath.includes("..") || path.basename(relativePath).split(".")[0] !== ref.sha256) {
      errors.push(`${label}: invalid artifact path ${relativePath}`);
      continue;
    }
    const file = path.join(directory, relativePath);
    if (!fs.existsSync(file)) {
      errors.push(`${label}: missing ${ref.sha256}`);
      continue;
    }
    const bytes = fs.readFileSync(file);
    if (bytes.length !== ref.size_bytes) errors.push(`${label}: size mismatch ${ref.sha256}`);
    if (hash(bytes) !== ref.sha256) errors.push(`${label}: hash mismatch ${ref.sha256}`);
  }
}

export function validateRun(runDirectory) {
  const errors = [];
  const all = validators();
  const run = readJson(path.join(runDirectory, "run.json"));
  const index = readJson(path.join(runDirectory, "index.json"));
  validateOne(all, "run.schema.json", run, "run.json", errors);
  if (index.run_id !== run.run_id) errors.push("index.run_id does not match run.json");
  if (!fs.existsSync(path.join(runDirectory, "report.html"))) errors.push("report.html is missing");
  for (const entry of index.cases) {
    const caseDirectory = path.join(runDirectory, "cases", entry.case_id);
    const caseConfig = readJson(path.join(caseDirectory, "case.json"));
    const expectations = readJson(path.join(caseDirectory, caseConfig.paths.expectations));
    const actions = readJsonl(path.join(caseDirectory, caseConfig.paths.actions));
    const actionResults = readJsonl(path.join(caseDirectory, caseConfig.paths.action_results));
    const events = readJsonl(path.join(caseDirectory, caseConfig.paths.events));
    const aliases = readJson(path.join(caseDirectory, caseConfig.paths.id_aliases));
    const captures = readJsonl(path.join(caseDirectory, caseConfig.paths.captures));
    const assertions = readJsonl(path.join(caseDirectory, caseConfig.paths.assertions));
    const summary = readJson(path.join(caseDirectory, caseConfig.paths.summary));
    validateOne(all, "case.schema.json", caseConfig, `${entry.case_id}/case.json`, errors);
    validateOne(all, "expectations.schema.json", expectations, `${entry.case_id}/expectations.json`, errors);
    actions.forEach((value, indexValue) => validateOne(all, "action.schema.json", value, `${entry.case_id}/actions:${indexValue + 1}`, errors));
    actionResults.forEach((value, indexValue) => validateOne(all, "action-result.schema.json", value, `${entry.case_id}/action-results:${indexValue + 1}`, errors));
    validateOne(all, "id-aliases.schema.json", aliases, `${entry.case_id}/id-aliases.json`, errors);
    captures.forEach((value, indexValue) => validateOne(all, "capture.schema.json", value, `${entry.case_id}/captures:${indexValue + 1}`, errors));
    assertions.forEach((value, indexValue) => validateOne(all, "assertion.schema.json", value, `${entry.case_id}/assertions:${indexValue + 1}`, errors));
    validateOne(all, "summary.schema.json", summary, `${entry.case_id}/summary.json`, errors);
    errors.push(...validateEvalSemantics({ action_results: actionResults, captures, events }).map((error) => `${entry.case_id}/${error.code}: ${error.message}`));
    verifyReferences(references(events), path.join(caseDirectory, caseConfig.paths.trajectory_blobs), `${entry.case_id}/trajectory`, errors);
    verifyReferences(references(captures), path.join(caseDirectory, caseConfig.paths.artifacts), `${entry.case_id}/artifacts`, errors);
    if (entry.status !== summary.status) errors.push(`${entry.case_id}: index status does not match summary`);
  }
  return errors;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2];
  assert.ok(directory, "usage: node eval/validate-run.mjs <run-directory>");
  const errors = validateRun(path.resolve(directory));
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else console.log(`valid eval bundle: ${path.resolve(directory)}`);
}
