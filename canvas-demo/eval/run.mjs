import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import containerChromium from "@sparticuz/chromium";

import { createApp } from "../server.mjs";
import { scenarioById } from "../scenarios.mjs";
import { stable, hash } from "../store.mjs";
import { validateEvalSemantics } from "./validate-semantics.mjs";
import { validateV2Inputs } from "./validate-v2-inputs.mjs";
import { ArtifactStore, capturePage, partialEqual, writeJson, writeJsonl } from "./runner/artifacts.mjs";
import { executeV2P0Action } from "./runner/v2-p0-actions.mjs";
import { executeV2P1Action } from "./runner/v2-p1-actions.mjs";
import { inspectMindMapDom, judgeMindMapDom, judgeMindMapModel } from "./runner/mind-map-judge.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(here, "..");
const repoRoot = path.resolve(appRoot, "..");
const defaultInputRoot = path.join(here, "cases", "v1");
const defaultRunsRoot = path.join(here, "runs");

const readJson = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const readJsonl = (file) => fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);

function caseConfigForV3(spec, fixture, expectations, actions) {
  const semanticFingerprint = crypto.createHash("sha256")
    .update(`${JSON.stringify({ spec, fixture, expectations, actions }, null, 2)}\n`)
    .digest("hex");
  return {
    format: "canvas-render-eval-case-v1",
    case_id: spec.case_id,
    scenario_id: spec.scenario_id,
    example_id: spec.example_id,
    title: spec.title,
    seed: spec.seed,
    generation: { mode: "execute_actions", parameterized_scenario: true },
    viewport: spec.viewport,
    view_policy: { ...spec.view_policy, selected_scenario_id: "human-edit", open_panel: "none" },
    paths: { expectations: "expectations.json", actions: "actions.jsonl", action_results: "execution/action-results.jsonl", events: "trajectory/events.jsonl", trajectory_blobs: "trajectory/blobs/sha256", id_aliases: "execution/id-aliases.json", captures: "observations/captures.jsonl", artifacts: "artifacts/sha256", assertions: "results/assertions.jsonl", summary: "results/summary.json" },
    oracles: { structural: true, visual_regression: { enabled: false, baseline_manifest: null }, visual_quality: { enabled: false, rubric_version: "v1", blocking: false } },
    reproducibility: { semantic_fingerprint: semanticFingerprint, generated_id_strategy: "deterministic-provider", volatile_event_fields: ["/event_id", "/session_id", "/timestamp"] },
  };
}

function runId() {
  return `${new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "Z")}_${execFileSync("git", ["rev-parse", "--short=8", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim()}_chromium`;
}

function orderedSubsequence(actual, expected) {
  let cursor = 0;
  for (const value of actual) if (value === expected[cursor]) cursor += 1;
  return cursor === expected.length;
}

function atPointer(value, pointer) {
  const segments = pointer === "" ? [] : pointer.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  let current = value;
  for (const segment of segments) {
    if (current === null || typeof current !== "object" || !Object.hasOwn(current, segment))
      return { exists: false, value: undefined };
    current = current[segment];
  }
  return { exists: true, value: current };
}

function modelInvariantResult(invariant, actualModel, references) {
  if (invariant.scope !== "model") return { supported: false, pass: false, actual: null };
  const actual = atPointer(actualModel, invariant.path);
  if (invariant.operator === "exists") return { supported: true, pass: actual.exists, actual: actual.exists };
  if (invariant.operator === "absent") return { supported: true, pass: !actual.exists, actual: actual.exists };
  if (invariant.operator === "equals") return { supported: true, pass: actual.exists && stable(actual.value) === stable(invariant.value), actual: actual.value ?? null };
  if (invariant.operator === "count-equals") return { supported: true, pass: actual.exists && Array.isArray(actual.value) && actual.value.length === invariant.value, actual: Array.isArray(actual.value) ? actual.value.length : null };
  if (invariant.operator === "contains") return { supported: true, pass: actual.exists && (typeof actual.value === "string" ? actual.value.includes(invariant.value) : Array.isArray(actual.value) && actual.value.some((item) => stable(item) === stable(invariant.value))), actual: actual.value ?? null };
  if (invariant.operator === "unchanged") {
    const reference = atPointer(references[invariant.compare_to], invariant.path);
    return { supported: true, pass: actual.exists === reference.exists && stable(actual.value) === stable(reference.value), actual: actual.value ?? null };
  }
  return { supported: false, pass: false, actual: null };
}

function normalizeModel(model, aliases) {
  const normalized = structuredClone(model);
  for (const component of normalized.components) {
    component.id = aliases.get(component.id) ?? component.id;
    if (component.kind === "mind_map" && Array.isArray(component.nodes)) {
      const children = new Map();
      for (const node of component.nodes) {
        const siblings = children.get(node.parentId) ?? [];
        siblings.push(node);
        children.set(node.parentId, siblings);
      }
      for (const siblings of children.values()) siblings.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
      const ordered = [];
      const seen = new Set();
      const visit = (node) => {
        if (!node || seen.has(node.id)) return;
        seen.add(node.id);
        ordered.push(node);
        for (const child of children.get(node.id) ?? []) visit(child);
      };
      visit(component.nodes.find(({ id }) => id === component.rootId));
      for (const node of component.nodes) visit(node);
      component.nodes = ordered;
    }
  }
  return normalized;
}

function reconcileComponentAliases(actual, expected, aliases, reverseAliases) {
  for (let index = 0; index < Math.min(actual.components.length, expected.components.length); index += 1) {
    const actualId = actual.components[index].id;
    const expectedId = expected.components[index].id;
    if (!aliases.has(actualId) && !reverseAliases.has(expectedId)) {
      aliases.set(actualId, expectedId);
      reverseAliases.set(expectedId, actualId);
    }
  }
}

function replayView(store, throughSeq) {
  const events = store.events.filter((event) => event.seq <= throughSeq);
  let state = store.get(events[0].payload.snapshot);
  let revision = 0;
  const undo = [];
  const redo = [];
  for (const event of events) {
    if (event.type !== "workspace.edit_committed") continue;
    state = store.get(event.payload.after);
    revision = event.payload.revision;
    if (event.payload.mode === "undo") redo.push(undo.pop());
    else if (event.payload.mode === "redo") undo.push(redo.pop());
    else {
      undo.push(event.event_id);
      redo.length = 0;
    }
  }
  return { state, revision, canUndo: undo.length > 0, canRedo: redo.length > 0, events };
}

function makeControl() {
  const control = { fault: null, gate: null };
  const hooks = {
    beforeAgentRequest() {
      if (control.fault === "request-fragment-corruption") throw Error("Request reconstruction failed: injected fragment corruption");
      if (control.fault === "timeout") throw Error("Agent request timed out (injected eval timeout)");
    },
    transformProposal({ proposal }) {
      if (control.fault === "invalid-proposal") return { components: [] };
      return proposal;
    },
    async beforeAgentCommit() {
      if (!control.gate) return;
      control.gate.pause();
      await control.gate.released;
    },
  };
  return { control, hooks };
}

function armGate() {
  let pause;
  let release;
  const paused = new Promise((resolve) => { pause = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  return { paused, released, pause, release };
}

async function listen(app) {
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${app.server.address().port}`;
}

async function closeApp(app) {
  if (!app) return;
  await new Promise((resolve) => {
    app.server.once("close", resolve);
    app.close();
  });
}

async function loadPage(context, url, consoleMessages) {
  const page = await context.newPage();
  page.on("console", (message) => consoleMessages.push({ type: message.type(), text: message.text() }));
  page.on("pageerror", (error) => consoleMessages.push({ type: "pageerror", text: error.message }));
  await page.goto(`${url}/?eval=1`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => Boolean(globalThis.__canvasEval));
  await page.waitForFunction(() => document.getElementById("connection")?.textContent.includes("Connected"));
  return page;
}

async function runCase({ browser, caseId, runRoot, inputRoot }) {
  const [corpusScenarioId, exampleId] = caseId.split("/");
  const sourceDir = path.join(inputRoot, corpusScenarioId, exampleId);
  const scenarioId = scenarioById.has(corpusScenarioId) ? corpusScenarioId : "human-edit";
  const spec = readJson(path.join(sourceDir, "spec.json"));
  const expectations = readJson(path.join(sourceDir, "expectations.json"));
  const actions = readJsonl(path.join(sourceDir, "actions.jsonl"));
  const caseConfigPath = path.join(sourceDir, "case.json");
  const caseConfig = fs.existsSync(caseConfigPath)
    ? readJson(caseConfigPath)
    : caseConfigForV3(spec, readJson(path.join(sourceDir, "fixture.json")), expectations, actions);
  const caseDir = path.join(runRoot, "cases", corpusScenarioId, exampleId);
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `canvas-eval-${corpusScenarioId}-${exampleId}-`));
  const artifacts = new ArtifactStore(path.join(caseDir, "artifacts", "sha256"));
  const captures = [];
  const captureStates = new Map();
  const actionResults = [];
  const assertions = [];
  const consoleMessages = [];
  const aliases = new Map(expectations.initial_model.components.map((component) => [component.id, component.id]));
  const reverseAliases = new Map(expectations.initial_model.components.map((component) => [component.id, component.id]));
  const retriedCommands = new Map();
  const v2ActionContext = new Map();
  const { control, hooks } = makeControl();
  let app;
  let baseUrl;
  let token;
  let context;
  let page;
  let executeMs = 0;
  let replayMs = 0;
  let oracleMs = 0;

  const checkpointByAction = new Map(expectations.checkpoints.map((checkpoint) => [checkpoint.after_action_id, checkpoint]));
  const actualComponentId = (alias) => reverseAliases.get(alias) ?? alias;
  const eventTail = () => app.store.events.at(-1)?.seq ?? 0;
  const addAssertion = ({ id, subject, oracle, name, pass, actual, expected, message }) => {
    const record = { schema_version: 1, assertion_id: id, case_id: caseId, subject, oracle, name, required: true, status: pass ? "pass" : "fail", actual, expected };
    if (message) record.message = message;
    assertions.push(record);
  };
  const renderCurrent = async () => {
    const state = await (await fetch(`${baseUrl}/api/state`)).json();
    await page.evaluate(({ state, scenarioId }) => globalThis.__canvasEval.renderSnapshot(state, { scenarioId }), { state, scenarioId });
    return state;
  };
  const post = async (route, payload) => {
    const response = await fetch(`${baseUrl}/api/${route}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Canvas-Token": token },
      body: JSON.stringify(payload),
    });
    const body = await response.json();
    return { ok: response.ok, status: response.status, body };
  };
  const request = async (method, pathname, payload) => {
    const response = await fetch(`${baseUrl}${pathname}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Canvas-Token": token },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    });
    return { ok: response.ok, status: response.status, body: await response.json() };
  };
  const liveCapture = async (actionItem, phase) => {
    const captureId = `${caseId}@${actionItem.action_id}-${phase}`;
    const result = await capturePage({ page, artifacts, caseId, captureId, mode: "live_checkpoint", trigger: { action: { action_id: actionItem.action_id, phase } }, eventsThroughSeq: eventTail, consoleMessages });
    captures.push(result.record);
    captureStates.set(captureId, result.uiState);
    return result.record;
  };

  try {
    app = createApp({ dir: dataDir, evalHooks: hooks });
    baseUrl = await listen(app);
    token = (await (await fetch(`${baseUrl}/api/state`)).json()).token;
    context = await browser.newContext({ viewport: { width: spec.viewport.width, height: spec.viewport.height }, deviceScaleFactor: spec.viewport.device_scale_factor, locale: "en-US", timezoneId: "UTC", colorScheme: "light", reducedMotion: "reduce" });
    page = await loadPage(context, baseUrl, consoleMessages);

    for (const actionItem of actions) {
      const checkpoint = checkpointByAction.get(actionItem.action_id);
      const started = performance.now();
      const beforeEvents = app.store.events.length;
      const beforeState = structuredClone(app.store.state);
      const captureIds = [];
      let outcome = { ok: true, status: 200, body: null };
      let gate = null;
      control.fault = actionItem.input.fault_profile ?? null;

      const requestedAlias = actionItem.input.component_id ?? spec.view_policy.selected_component_id;
      const creatingNewAlias = actionItem.kind === "create" && !reverseAliases.has(requestedAlias);
      const selectedActual = actualComponentId(creatingNewAlias ? spec.view_policy.selected_component_id : requestedAlias);
      if (!creatingNewAlias) await page.evaluate((componentId) => globalThis.__canvasEval.select(componentId), selectedActual);

      if (actionItem.kind === "set_text" && actionItem.action_id === "commit-window-b") {
        await page.evaluate(({ componentId, value, baseRevision }) => globalThis.__canvasEval.openInline(componentId, "title", value, baseRevision), { componentId: selectedActual, value: "Draft from A", baseRevision: app.store.revision });
      } else if (actionItem.kind === "set_text" && actionItem.action_id !== "submit-stale-a") {
        await page.evaluate(({ componentId, nodeId, value, baseRevision }) => globalThis.__canvasEval.openInline(componentId, nodeId, value, baseRevision), { componentId: selectedActual, nodeId: actionItem.input.node_id, value: actionItem.input.value, baseRevision: app.store.revision });
      } else if (actionItem.kind === "agent_proposal") {
        await page.locator("#prompt").fill(actionItem.input.prompt);
        await page.locator("#engine").selectOption(actionItem.input.engine);
        await page.locator("#capture").setChecked(actionItem.input.capture === true);
      }

      for (const point of actionItem.live_capture_points.filter((point) => point.phase === "before")) captureIds.push((await liveCapture(actionItem, point.phase)).capture_id);

      if (actionItem.kind === "seed_fixture") {
        const fixture = readJson(path.join(sourceDir, "fixture.json"));
        try {
          app.store.commit({ state: fixture, baseRevision: app.store.revision, commandId: `eval-seed-${caseId.replaceAll("/", "-")}`, actor: "eval", intent: "seed_fixture" });
          await renderCurrent();
          outcome = { ok: true, status: 200, body: {} };
        } catch (error) {
          outcome = { ok: false, status: error.status ?? 400, body: { error: error.message } };
        }
      } else if (actionItem.kind === "agent_proposal") {
        const during = actionItem.live_capture_points.find((point) => point.phase === "during");
        if (during) {
          const armed = armGate();
          control.gate = armed;
          gate = { name: during.response_gate.name, pause_at: "before_model_commit", status: "released", release_reason: "captured", observations: [{ ordinal: 1, phase: "gate_armed" }] };
        }
        await page.locator("#run").click();
        if (gate) {
          await control.gate.paused;
          gate.observations.push({ ordinal: 2, phase: "gate_paused" });
          if (actionItem.input.human_edit_while_paused) {
            const edit = actionItem.input.human_edit_while_paused;
            const componentId = actualComponentId(edit.component_id);
            const component = app.store.state.components.find((item) => item.id === componentId);
            const field = edit.node_id === "title" ? "title" : edit.node_id === "body" ? "body" : null;
            if (component && field) {
              const humanOutcome = await post("component", { operation: "set_text", componentId, nodeId: edit.node_id, text: edit.value, baseRevision: app.store.revision, commandId: `eval-human-during-${actionItem.step}` });
              if (humanOutcome.ok) await page.evaluate(({ body, scenarioId }) => globalThis.__canvasEval.renderSnapshot(body, { scenarioId }), { body: humanOutcome.body, scenarioId });
            }
          }
          const captureId = `${caseId}@${actionItem.action_id}-during`;
          gate.observations.push({ ordinal: gate.observations.length + 1, phase: "capture_started", capture_id: captureId });
          captureIds.push((await liveCapture(actionItem, "during")).capture_id);
          gate.observations.push({ ordinal: gate.observations.length + 1, phase: "capture_finished", capture_id: captureId });
          control.gate.release();
          gate.observations.push({ ordinal: gate.observations.length + 1, phase: "gate_released" });
        }
        await page.waitForFunction(() => !document.getElementById("run").disabled, null, { timeout: 10000 });
        const observed = await page.evaluate(() => globalThis.__canvasEval.observedUIState());
        outcome = { ok: observed.status.tone !== "error", status: observed.status.tone === "error" ? 400 : 200, body: observed.status };
      } else if (actionItem.kind === "load_scenario") {
        outcome = await post("scenario", { scenarioId: actionItem.input.scenario_id, baseRevision: app.store.revision, commandId: `eval-${actionItem.step}` });
        if (outcome.ok) await page.evaluate(({ body, scenarioId }) => globalThis.__canvasEval.renderSnapshot(body, { scenarioId }), { body: outcome.body, scenarioId });
      } else if (actionItem.kind === "set_text") {
        if (actionItem.action_id === "commit-window-b") {
          outcome = await post("component", { operation: "set_text", componentId: selectedActual, nodeId: actionItem.input.node_id, text: actionItem.input.value, baseRevision: actionItem.input.base_revision, commandId: `eval-${actionItem.step}` });
          if (outcome.ok) await page.evaluate(({ body, scenarioId }) => globalThis.__canvasEval.renderSnapshot(body, { scenarioId }), { body: outcome.body, scenarioId });
        } else {
          await page.locator("#inlineForm button[type=submit]").click();
          if (checkpoint.expected_action_status === "succeeded") await page.waitForFunction(() => !document.getElementById("inlineEdit").open);
          else await page.waitForFunction(() => Boolean(document.getElementById("inlineError").textContent));
          const observed = await page.evaluate(() => globalThis.__canvasEval.observedUIState());
          outcome = { ok: !observed.editor.error, status: observed.editor.error ? 409 : 200, body: observed.editor.error ? { error: observed.editor.error } : {} };
        }
      } else if (actionItem.kind === "comment") {
        outcome = await post("comment", { componentId: selectedActual, nodeId: actionItem.input.node_id, text: actionItem.input.text, baseRevision: app.store.revision, commandId: `eval-${actionItem.step}` });
        await renderCurrent();
      } else if (actionItem.kind === "select_component") {
        outcome = { ok: true, status: 200, body: {} };
      } else if (["create", "duplicate", "delete", "move"].includes(actionItem.kind)) {
        const commandId = actionItem.input.command_id ?? `eval-${actionItem.step}`;
        const previousCommand = retriedCommands.get(commandId);
        const input = {
          operation: actionItem.kind,
          componentId: previousCommand?.componentId ?? (actionItem.kind === "create" ? requestedAlias : selectedActual),
          baseRevision: previousCommand?.baseRevision ?? app.store.revision,
          commandId,
          ...(actionItem.kind === "create" ? { title: actionItem.input.title, body: actionItem.input.body, color: actionItem.input.color } : {}),
        };
        if (!previousCommand) retriedCommands.set(commandId, { componentId: input.componentId, baseRevision: input.baseRevision });
        if (actionItem.kind === "move") {
          const currentIndex = app.store.state.components.findIndex((component) => component.id === selectedActual);
          input.direction = actionItem.input.index > currentIndex ? 1 : -1;
        }
        outcome = await post("component", input);
        if (outcome.ok) {
          reconcileComponentAliases(outcome.body.state, checkpoint.expected_model, aliases, reverseAliases);
          const selectedAfterAction = ["create", "duplicate"].includes(actionItem.kind) ? outcome.body.selectedComponentId : selectedActual;
          await page.evaluate(({ body, scenarioId, selectedAfterAction }) => globalThis.__canvasEval.renderSnapshot(body, { scenarioId, selectedComponentId: selectedAfterAction }), { body: outcome.body, scenarioId, selectedAfterAction });
        } else await page.evaluate((message) => globalThis.__canvasEval.showError(message), outcome.body.error);
      } else if (["undo", "redo"].includes(actionItem.kind)) {
        outcome = await post(actionItem.kind, { baseRevision: app.store.revision, commandId: `eval-${actionItem.step}` });
        if (outcome.ok) await page.evaluate(({ body, scenarioId }) => globalThis.__canvasEval.renderSnapshot(body, { scenarioId }), { body: outcome.body, scenarioId });
        else await page.evaluate((message) => globalThis.__canvasEval.showError(message), outcome.body.error);
      } else if (actionItem.kind === "restart") {
        await closeApp(app);
        app = createApp({ dir: dataDir, evalHooks: hooks });
        baseUrl = await listen(app);
        token = (await (await fetch(`${baseUrl}/api/state`)).json()).token;
        await page.goto(`${baseUrl}/?eval=1`, { waitUntil: "networkidle" });
        await page.waitForFunction(() => Boolean(globalThis.__canvasEval));
        await page.waitForFunction(() => document.getElementById("connection")?.textContent.includes("Connected"));
        outcome = { ok: true, status: 200, body: {} };
      } else if (actionItem.kind === "set_html_source") {
        const next = structuredClone(app.store.state);
        next.components.find((component) => component.id === selectedActual).html = actionItem.input.html;
        outcome = await post("edit", { state: next, baseRevision: app.store.revision, commandId: `eval-${actionItem.step}` });
        if (!outcome.ok) await page.evaluate((message) => globalThis.__canvasEval.showError(message), outcome.body.error);
      } else if (["proposal_stage", "proposal_decision", "human_edit_commit"].includes(actionItem.kind)) {
        try {
          outcome = await executeV2P0Action({ actionItem, post, page, app, selectedActual, actualComponentId, scenarioId, renderCurrent, context: v2ActionContext });
        } catch (error) {
          outcome = { ok: false, status: 500, body: { error: error.message } };
        }
      } else if (["coordinated_change", "comment_lifecycle", "export_restore", "reconnect", "keyboard_interaction"].includes(actionItem.kind)) {
        try {
          outcome = await executeV2P1Action({ action: actionItem, context: {
            page, app, request, renderCurrent,
            renderSnapshot: async (body, options = {}) => page.evaluate(({ body, scenarioId, options }) => globalThis.__canvasEval.renderSnapshot(body, { scenarioId, ...options }), { body, scenarioId, options }),
            selectedComponentId: selectedActual,
          } });
        } catch (error) {
          outcome = { ok: false, status: 500, body: { error: error.message } };
        }
      } else if (actionItem.kind === "mind_map_rename_cancel") {
        const input = actionItem.input;
        const componentId = actualComponentId(input.component_id ?? requestedAlias);
        await page.evaluate(({ componentId, nodeId, text, baseRevision }) => globalThis.__canvasEval.openInline(componentId, nodeId, text, baseRevision), {
          componentId, nodeId: input.node_id, text: input.draft_text, baseRevision: input.base_revision ?? app.store.revision,
        });
        await page.locator("#inlineText").fill(input.draft_text);
        await page.locator("#cancelInline").click();
        outcome = { ok: true, status: 200, body: {} };
      } else if (["mind_map_create", "mind_map_add", "mind_map_rename", "mind_map_move", "mind_map_duplicate", "mind_map_delete"].includes(actionItem.kind)) {
        const input = actionItem.input;
        const operation = actionItem.kind === "mind_map_create" ? "create_mind_map" : actionItem.kind;
        const payload = {
          operation,
          componentId: actualComponentId(input.component_id ?? requestedAlias),
          baseRevision: input.base_revision ?? app.store.revision,
          commandId: input.command_id ?? `eval-${actionItem.step}`,
        };
        if (input.node_id) payload.nodeId = input.node_id;
        if (input.parent_id) payload.parentId = input.parent_id;
        if (input.order !== undefined) payload.order = input.order;
        if (input.text !== undefined) payload.text = input.text;
        else if (input.label !== undefined) payload.text = input.label;
        else if (input.root_label !== undefined) payload.text = input.root_label;
        if (input.root_id) payload.nodeId = input.root_id;
        if (input.id_map) payload.idMap = input.id_map;
        outcome = await post("command", payload);
        if (outcome.ok) await page.evaluate(({ body, scenarioId, selectedComponentId }) => globalThis.__canvasEval.renderSnapshot(body, { scenarioId, selectedComponentId }), { body: outcome.body, scenarioId, selectedComponentId: outcome.body.selectedComponentId ?? payload.componentId });
        else await page.evaluate((message) => globalThis.__canvasEval.showError(message), outcome.body.error);
      } else if (actionItem.kind === "selection_request") {
        const input = actionItem.input;
        outcome = await post("agent", {
          prompt: input.instruction,
          engine: "mock",
          componentId: actualComponentId(input.component_id ?? requestedAlias),
          baseRevision: input.base_revision ?? app.store.revision,
          capture: input.capture === true,
          reviewMode: "stage",
          commandId: `eval-selection-${actionItem.step}`,
          selection: { mode: input.selection.mode, nodeIds: input.selection.node_ids },
        });
        if (outcome.ok) await page.evaluate(({ body, scenarioId }) => globalThis.__canvasEval.renderSnapshot(body, { scenarioId }), { body: outcome.body, scenarioId });
        else await page.evaluate((message) => globalThis.__canvasEval.showError(message), outcome.body.error);
      } else {
        outcome = { ok: false, status: 501, body: { error: `Runner does not implement action kind: ${actionItem.kind}` }, unsupported: true };
      }

      control.gate = null;
      control.fault = null;
      const actualStatus = outcome.ok
        ? "succeeded"
        : outcome.status >= 400 && outcome.status < 500 && !["agent_proposal", "set_html_source"].includes(actionItem.kind) && !outcome.unsupported
          ? "rejected"
          : "failed";
      const afterEvents = app.store.events.slice(beforeEvents);
      reconcileComponentAliases(app.store.state, checkpoint.expected_model, aliases, reverseAliases);

      for (const point of actionItem.live_capture_points.filter((point) => point.phase !== "before" && point.phase !== "during")) {
        captureIds.push((await liveCapture(actionItem, point.phase)).capture_id);
      }

      const actionResult = {
        schema_version: 1,
        action_id: actionItem.action_id,
        step: actionItem.step,
        status: actualStatus,
        http_status: outcome.status,
        emitted_events: afterEvents.map(({ seq, event_id, type }) => ({ seq, event_id, type })),
        capture_ids: captureIds,
        duration_ms: performance.now() - started,
      };
      if (!outcome.ok) actionResult.error = { name: "ActionError", message: outcome.body?.error ?? outcome.body?.text ?? "Action failed" };
      if (outcome.evidence) actionResult.response = artifacts.put(outcome.evidence);
      if (gate) actionResult.gate = gate;
      actionResults.push(actionResult);

      const normalized = normalizeModel(app.store.state, aliases);
      const statusMatches = actualStatus === checkpoint.expected_action_status && !outcome.unsupported;
      addAssertion({ id: `${actionItem.action_id}-status`, subject: { action_id: actionItem.action_id }, oracle: "trajectory", name: "action status", pass: statusMatches, actual: actualStatus, expected: checkpoint.expected_action_status, message: statusMatches ? undefined : `HTTP ${outcome.status}: ${outcome.body?.error ?? "unexpected status"}` });
      addAssertion({ id: `${actionItem.action_id}-model`, subject: { action_id: actionItem.action_id }, oracle: "model", name: "expected model", pass: stable(normalized) === stable(checkpoint.expected_model), actual: normalized, expected: checkpoint.expected_model });
      if (Object.hasOwn(checkpoint, "expected_selection_context")) {
        const actualContext = outcome.body?.selectionContext ?? null;
        addAssertion({ id: `${actionItem.action_id}-selection-context`, subject: { action_id: actionItem.action_id }, oracle: "model", name: "agent receives canonical selected tree context", pass: stable(actualContext) === stable(checkpoint.expected_selection_context), actual: actualContext, expected: checkpoint.expected_selection_context });
      }
      for (const component of normalized.components.filter((item) => item.kind === "mind_map")) {
        const modelResult = judgeMindMapModel(component);
        addAssertion({ id: `${actionItem.action_id}-mind-map-tree-${component.id}`, subject: { action_id: actionItem.action_id }, oracle: "model", name: "mind map is a valid rooted ordered tree", pass: modelResult.pass, actual: modelResult, expected: { pass: true } });
        const dom = await inspectMindMapDom(page, actualComponentId(component.id));
        const domResult = judgeMindMapDom(component, dom, { requireViewportFit: spec.tags?.includes("v3") && spec.tags?.includes("p0") });
        addAssertion({ id: `${actionItem.action_id}-mind-map-layout-${component.id}`, subject: { action_id: actionItem.action_id }, oracle: "layout", name: "mind map nodes and connectors render with valid geometry", pass: domResult.pass, actual: domResult, expected: { pass: true, node_ids: component.nodes.map(({ id }) => id) } });
      }
      const emittedTypes = afterEvents.map((event) => event.type);
      const listedCommitCount = checkpoint.expected_events.sequence.filter((type) => type === "workspace.edit_committed").length;
      const expectedCommitCount = ["load_scenario", "seed_fixture"].includes(actionItem.kind)
        ? Math.max(1, listedCommitCount)
        : listedCommitCount;
      const actualCommitCount = emittedTypes.filter((type) => type === "workspace.edit_committed").length;
      const eventsMatch = orderedSubsequence(emittedTypes, checkpoint.expected_events.sequence) &&
        (checkpoint.expected_events.allow_additional || stable(emittedTypes) === stable(checkpoint.expected_events.sequence)) &&
        actualCommitCount === expectedCommitCount;
      addAssertion({ id: `${actionItem.action_id}-events`, subject: { action_id: actionItem.action_id }, oracle: "trajectory", name: "expected event sequence and edit commit count", pass: eventsMatch, actual: emittedTypes, expected: checkpoint.expected_events.sequence });
      if (actionItem.kind === "export_restore") {
        const restoreExpected = actionItem.input.operation === "roundtrip";
        const integrity = restoreExpected ? outcome.evidence?.destination_restored : outcome.evidence?.destination_unchanged;
        addAssertion({ id: `${actionItem.action_id}-destination`, subject: { action_id: actionItem.action_id }, oracle: "model", name: restoreExpected ? "destination restored exactly" : "destination unchanged after failed import", pass: integrity === true, actual: integrity ?? null, expected: true });
        const expectedHttp = restoreExpected ? 200 : actionItem.input.fault === "missing_blob" ? 422 : 500;
        addAssertion({ id: `${actionItem.action_id}-import-http`, subject: { action_id: actionItem.action_id }, oracle: "trajectory", name: "import contract status", pass: outcome.status === expectedHttp, actual: outcome.status, expected: expectedHttp });
      }
      for (const [invariantIndex, invariant] of checkpoint.invariants.entries()) {
        const result = modelInvariantResult(invariant, normalized, {
          model_pre_action: normalizeModel(beforeState, aliases),
          previous_model_checkpoint: expectations.checkpoints[Math.max(0, actionItem.step - 2)]?.expected_model,
          initial_model: expectations.initial_model,
        });
        addAssertion({ id: `${actionItem.action_id}-invariant-${invariantIndex + 1}`, subject: { action_id: actionItem.action_id }, oracle: "model", name: `invariant ${invariant.scope}:${invariant.operator} ${invariant.path}`, pass: result.pass, actual: result.actual, expected: invariant.value ?? invariant.compare_to ?? true, message: result.supported ? undefined : "Invariant operator is not implemented by the eval runner" });
      }
      for (const liveExpected of checkpoint.live_checkpoints) {
        const id = `${caseId}@${actionItem.action_id}-${liveExpected.phase}`;
        const actualUI = captureStates.get(id);
        const comparable = actualUI ? structuredClone(actualUI) : null;
        if (comparable?.selected_component_id) comparable.selected_component_id = aliases.get(comparable.selected_component_id) ?? comparable.selected_component_id;
        addAssertion({ id: `${actionItem.action_id}-${liveExpected.phase}-ui`, subject: { capture_id: id }, oracle: "dom", name: `${liveExpected.phase} UI state`, pass: Boolean(comparable) && partialEqual(comparable, liveExpected.expected_ui), actual: comparable, expected: liveExpected.expected_ui });
      }
      executeMs += performance.now() - started;
    }

    const replayStarted = performance.now();
    const events = structuredClone(app.store.events);
    for (const event of events) {
      const view = replayView(app.store, event.seq);
      const selected = actualComponentId(spec.view_policy.selected_component_id);
      await page.evaluate(({ view, selected, scenarioId }) => globalThis.__canvasEval.renderSnapshot(view, { selectedComponentId: selected, scenarioId }), { view, selected, scenarioId });
      const captureId = `${caseId}@event-${String(event.seq).padStart(6, "0")}`;
      const result = await capturePage({ page, artifacts, caseId, captureId, mode: "event_replay", trigger: { event: { seq: event.seq, event_id: event.event_id, type: event.type, phase: "after_event" } }, eventsThroughSeq: () => event.seq, consoleMessages });
      captures.push(result.record);
    }
    replayMs = performance.now() - replayStarted;

    const oracleStarted = performance.now();
    const semanticErrors = validateEvalSemantics({ action_results: actionResults, captures, events });
    for (const error of semanticErrors) addAssertion({ id: `semantic-${assertions.length + 1}`, subject: { case_id: caseId }, oracle: "trajectory", name: error.code, pass: false, actual: error, expected: null, message: error.message });
    const unexpectedConsoleErrors = consoleMessages.filter((entry) =>
      entry.type === "pageerror" ||
      (entry.type === "error" && !/Failed to load resource: the server responded with a status of (400|409)/.test(entry.text)),
    );
    addAssertion({ id: "console-errors", subject: { case_id: caseId }, oracle: "console", name: "no unexpected browser errors", pass: unexpectedConsoleErrors.length === 0, actual: unexpectedConsoleErrors, expected: [] });
    oracleMs = performance.now() - oracleStarted;

    fs.mkdirSync(path.join(caseDir, "inputs"), { recursive: true });
    const outputCaseConfig = structuredClone(caseConfig);
    outputCaseConfig.paths.expectations = "inputs/expectations.json";
    outputCaseConfig.paths.actions = "inputs/actions.jsonl";
    writeJson(path.join(caseDir, "case.json"), outputCaseConfig);
    for (const file of ["actions.jsonl", "expectations.json", "fixture.json", "spec.json"]) fs.copyFileSync(path.join(sourceDir, file), path.join(caseDir, "inputs", file));
    fs.mkdirSync(path.join(caseDir, "trajectory", "blobs", "sha256"), { recursive: true });
    fs.copyFileSync(path.join(dataDir, "events.jsonl"), path.join(caseDir, "trajectory", "events.jsonl"));
    for (const file of fs.readdirSync(path.join(dataDir, "blobs", "sha256"))) fs.copyFileSync(path.join(dataDir, "blobs", "sha256", file), path.join(caseDir, "trajectory", "blobs", "sha256", file));
    writeJsonl(path.join(caseDir, "execution", "action-results.jsonl"), actionResults);
    const aliasMappings = [
      { kind: "session", actual_id: events[0].session_id, alias: "session-01", defined_at_seq: 1 },
      ...events.map((event) => ({ kind: "event", actual_id: event.event_id, alias: `event-${String(event.seq).padStart(6, "0")}`, defined_at_seq: event.seq })),
      ...[...new Map(events.filter((event) => event.payload.command_id).map((event) => [event.payload.command_id, event.seq]))].map(([actual_id, defined_at_seq], index) => ({ kind: "command", actual_id, alias: `command-${String(index + 1).padStart(4, "0")}`, defined_at_seq })),
      ...[...aliases].filter(([actualId, alias]) => actualId !== alias).map(([actual_id, alias]) => ({ kind: "component", actual_id, alias, defined_at_seq: 1 })),
    ];
    writeJson(path.join(caseDir, "execution", "id-aliases.json"), { format: "canvas-render-eval-id-aliases-v1", case_id: caseId, references_preserved: true, event_reference_paths: ["/event_id", "/caused_by/*", "/payload/target", "/payload/request_event_id", "/payload/command_id"], derived_value_paths: [{ path: "/payload/fingerprint", comparison: "recompute_from_canonical_projection" }], mappings: aliasMappings });
    writeJsonl(path.join(caseDir, "observations", "captures.jsonl"), captures);
    writeJsonl(path.join(caseDir, "results", "assertions.jsonl"), assertions);
    const failures = assertions.filter((item) => item.required && item.status === "fail").map((item) => ({ assertion_id: item.assertion_id, message: item.message ?? `${item.name} did not match` }));
    const capturesOk = captures.filter((capture) => capture.status === "ok").length;
    const expectedLive = actions.reduce((sum, item) => sum + item.live_capture_points.length, 0);
    const summary = {
      format: "canvas-render-eval-summary-v1",
      case_id: caseId,
      status: failures.length || capturesOk !== captures.length ? "fail" : "pass",
      coverage: { events: { expected: events.length, captured: captures.filter((capture) => capture.mode === "event_replay").length, complete: captures.filter((capture) => capture.mode === "event_replay").length === events.length }, live_checkpoints: { expected: expectedLive, captured: captures.filter((capture) => capture.mode === "live_checkpoint").length, complete: captures.filter((capture) => capture.mode === "live_checkpoint").length === expectedLive } },
      counts: { actions: actions.length, captures_ok: capturesOk, captures_failed: captures.length - capturesOk, assertions: assertions.length, required_failed: failures.length },
      final: { event_seq: events.at(-1).seq, revision: app.store.revision, model_hash: hash(stable(app.store.state)) },
      timing_ms: { execute: executeMs, replay_render: replayMs, oracles: oracleMs },
      failures,
    };
    writeJson(path.join(caseDir, "results", "summary.json"), summary);
    return { caseId, summary, captureCount: captures.length };
  } finally {
    if (context) await context.close().catch(() => {});
    await closeApp(app).catch(() => {});
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

function reportHtml(run, results) {
  const rows = results.map(({ caseId, summary }) => `<tr><td><a href="#${caseId.replace("/", "-")}">${caseId}</a></td><td class="${summary.status}">${summary.status}</td><td>${summary.counts.actions}</td><td>${summary.coverage.events.captured}/${summary.coverage.events.expected}</td><td>${summary.coverage.live_checkpoints.captured}/${summary.coverage.live_checkpoints.expected}</td><td>${summary.counts.required_failed}</td></tr>`).join("");
  const sections = results.map(({ caseId, summary, captures }) => {
    const links = `<a href="cases/${caseId}/trajectory/events.jsonl">trajectory</a> · <a href="cases/${caseId}/observations/captures.jsonl">captures</a> · <a href="cases/${caseId}/results/assertions.jsonl">assertions</a> · <a href="cases/${caseId}/results/summary.json">summary</a>`;
    const cards = captures.filter((capture) => capture.status === "ok").map((capture) => {
      const image = capture.evidence.captures.find((item) => item.surface === "app");
      const imagePath = image ? `cases/${caseId}/artifacts/sha256/${image.artifact.path ?? image.artifact.sha256}` : "";
      const artifactLinks = capture.evidence.captures.map((item) => `<a href="cases/${caseId}/artifacts/sha256/${item.artifact.path ?? item.artifact.sha256}">${item.surface}</a>`).join(" · ");
      return `<figure><a href="${imagePath}"><img loading="lazy" src="${imagePath}" alt="${capture.capture_id}"></a><figcaption><b>${capture.capture_id}</b><br>${capture.mode} · ${artifactLinks}</figcaption></figure>`;
    }).join("");
    return `<section id="${caseId.replace("/", "-")}"><h2>${caseId} <span class="${summary.status}">${summary.status}</span></h2><p>${links}</p><div class="gallery">${cards}</div></section>`;
  }).join("");
  return `<!doctype html><meta charset="utf-8"><title>Canvas eval ${run.run_id}</title><style>body{font:15px system-ui;margin:40px;color:#202039;background:#fafafa}table{border-collapse:collapse;width:100%;background:white}th,td{padding:10px;border-bottom:1px solid #ddd;text-align:left}.pass{color:#08783e}.fail{color:#b42318}code{background:#f3f4f6;padding:2px 5px}section{margin-top:48px}.gallery{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:16px}figure{margin:0;padding:10px;background:white;border:1px solid #ddd;border-radius:8px}img{display:block;width:100%;height:180px;object-fit:contain;background:#f3f4f6}figcaption{padding-top:8px;font-size:12px;overflow-wrap:anywhere}a{color:#4f46e5}</style><h1>Canvas render eval</h1><p><code>${run.run_id}</code> · ${results.length} cases</p><table><thead><tr><th>Case</th><th>Status</th><th>Actions</th><th>Events</th><th>Live</th><th>Failures</th></tr></thead><tbody>${rows}</tbody></table>${sections}`;
}

export function rebuildReport(runDirectory) {
  const run = readJson(path.join(runDirectory, "run.json"));
  const index = readJson(path.join(runDirectory, "index.json"));
  const results = index.cases.map((entry) => {
    const caseDirectory = path.join(runDirectory, "cases", entry.case_id);
    return { caseId: entry.case_id, summary: readJson(path.join(caseDirectory, "results", "summary.json")), captures: readJsonl(path.join(caseDirectory, "observations", "captures.jsonl")) };
  });
  fs.writeFileSync(path.join(runDirectory, "report.html"), reportHtml(run, results));
}

export async function runEval({ caseIds, runsRoot = defaultRunsRoot, id = runId(), corpus = defaultInputRoot } = {}) {
  const inputRoot = path.resolve(corpus);
  const manifest = readJson(path.join(inputRoot, "manifest.json"));
  if (manifest.format === "canvas-render-eval-input-manifest-v2") {
    const errors = validateV2Inputs(inputRoot);
    if (errors.length) throw Error(`Invalid v2 CUJ inputs:\n${errors.join("\n")}`);
  }
  const selected = caseIds?.length ? caseIds : manifest.cases;
  const output = path.join(runsRoot, id);
  fs.mkdirSync(output, { recursive: true });
  let executablePath;
  let chromiumArgs = [];
  if (process.env.CANVAS_EVAL_BROWSER_EXECUTABLE) {
    executablePath = process.env.CANVAS_EVAL_BROWSER_EXECUTABLE;
    if (!fs.existsSync(executablePath)) throw Error(`Eval browser does not exist: ${executablePath}`);
  } else if (process.platform === "linux") {
    const originalGetuid = process.getuid;
    try {
      if (originalGetuid) process.getuid = () => -1;
      executablePath = await containerChromium.executablePath();
      chromiumArgs = containerChromium.args;
    } finally {
      if (originalGetuid) process.getuid = originalGetuid;
    }
  } else {
    executablePath = chromium.executablePath();
    if (!fs.existsSync(executablePath)) {
      throw Error(`Playwright Chromium is not installed for ${process.platform}; run "npx playwright install chromium"`);
    }
  }
  const launchBrowser = () => chromium.launch({ executablePath, headless: true, args: chromiumArgs });
  let browser = await launchBrowser();
  const browserVersion = browser.version();
  const run = {
    format: "canvas-render-eval-run-v1",
    run_id: id,
    created_at: new Date().toISOString(),
    source: { repository: "https://github.com/hyh626/codex-canvas", commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim(), dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).trim()), model_schema: "urn:canvas-demo:model:v1", event_schema_version: 1 },
    runtime: { runner: "canvas-render-eval/0.1.0", node: process.versions.node, browser: { name: "chromium", version: browserVersion, headless: true }, os_image: `${process.platform}-${os.release()}`, locale: "en-US", timezone: "UTC", color_scheme: "light", reduced_motion: "reduce", fonts: ["system-ui"] },
    defaults: { viewport: { width: 1440, height: 1000, device_scale_factor: 1 }, surfaces: ["app", "canvas"], capture_modes: ["event_replay", "live_checkpoint"], event_capture_phase: "after_event", comparison: { raw_trajectory: "byte-exact-within-run", cross_run: "semantic-fingerprint-plus-render-artifacts" } },
  };
  writeJson(path.join(output, "run.json"), run);
  const results = [];
  for (let index = 0; index < selected.length; index += 1) {
    const caseId = selected[index];
    if (index > 0) browser = await launchBrowser();
    try {
      const result = await runCase({ browser, caseId, runRoot: output, inputRoot });
      results.push(result);
      console.log(`${result.summary.status.toUpperCase()} ${caseId} (${result.captureCount} captures)`);
    } finally {
      await browser.close().catch(() => {});
    }
  }
  writeJson(path.join(output, "index.json"), { format: "canvas-render-eval-index-v1", run_id: id, cases: results.map(({ caseId, summary }) => ({ case_id: caseId, status: summary.status, summary: `cases/${caseId}/results/summary.json` })) });
  rebuildReport(output);
  return { output, run, results };
}

function parseArguments(argv) {
  const cases = [];
  let id;
  let corpus = defaultInputRoot;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === "--case") cases.push(argv[++index]);
    else if (argv[index] === "--run-id") id = argv[++index];
    else if (argv[index] === "--corpus") {
      const value = argv[++index];
      if (!value) throw Error("--corpus requires a path or version (v1, v2)");
      corpus = ["v1", "v2", "v3"].includes(value) ? path.join(here, "cases", value) : value;
    }
    else throw Error(`Unknown argument: ${argv[index]}`);
  }
  return { caseIds: cases.length ? cases : undefined, id, corpus };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runEval(parseArguments(process.argv.slice(2)));
  assert.ok(result.results.length > 0);
  console.log(`report: ${path.join(result.output, "report.html")}`);
  if (result.results.some(({ summary }) => summary.status !== "pass")) process.exitCode = 1;
}
