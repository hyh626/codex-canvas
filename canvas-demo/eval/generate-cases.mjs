import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { mockLayout } from "../html.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const casesRoot = path.join(here, "cases", "v1");
const faultsRoot = path.join(here, "fault-corpus", "v1");

const card = (id, title, body, color = "#6366f1") => ({ id, title, body, color });
const html = (title = "A shared HTML component", body = "Edit this node, then ask the agent to change the layout.") =>
  `<article data-node-id="root" style="display:flex;flex-direction:column;gap:16px;padding:24px;background:#eef2ff;border-radius:16px">\n  <header data-node-id="heading"><small data-node-id="eyebrow">CUJ PLAYGROUND</small><h2 data-node-id="title">${title}</h2></header>\n  <section data-node-id="content"><p data-node-id="body">${body}</p><ul data-node-id="features"><li data-node-id="feature-one">Stable comment anchors</li><li data-node-id="feature-two">One shared history</li></ul></section>\n</article>`;

const fixtures = {
  "human-edit": { components: [card("welcome", "Build something together.", "Double-click this title to begin.")] },
  "comment-agent": { components: [card("welcome", "A rough direction", "Comments are durable model context, not prompt-only UI state.")] },
  "shared-undo": { components: [card("welcome", "Baseline", "Human and agent commits use the same history.")] },
  "component-lifecycle": { components: [card("alpha", "Alpha", "Duplicate this card."), card("omega", "Omega", "Keep this card unchanged.", "#0d9488")] },
  "html-component": { components: [{ id: "hero", kind: "html", html: html() }] },
  "audited-request": { components: [card("welcome", "Audit the request", "Enable capture, then run a deterministic proposal.")] },
};

const clone = (value) => JSON.parse(JSON.stringify(value));
const selectedAfter = (record, componentId) => Object.assign(record, { selectedComponentId: componentId });
const escapeHTML = (text) => text.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[character]));
const canonical = (value) => `${JSON.stringify(value, null, 2)}\n`;
const sha256 = (value) => crypto.createHash("sha256").update(typeof value === "string" ? value : canonical(value)).digest("hex");

function live(...phases) {
  return phases.map((phase) => {
    const point = { phase, ready_when: { signal: phase === "before" ? "selector_visible" : phase === "during" ? "loading_visible" : phase === "conflict" ? "conflict_visible" : phase === "error" ? "error_visible" : "render_idle" } };
    if (phase === "before") point.ready_when.selector = "[data-testid=canvas]";
    if (phase === "during") point.response_gate = { name: "proposal-gate", pause_at: "before_model_commit", release: "after_capture" };
    return [point];
  }).flat();
}

function action(actionId, kind, driver, input, status = "succeeded", phases = ["after"], eventTypes = null) {
  return {
    action: {
      schema_version: 1,
      action_id: actionId,
      step: 0,
      kind,
      driver,
      input,
      expectation_checkpoint_id: `${actionId}-checkpoint`,
      live_capture_points: live(...phases),
    },
    status,
    eventTypes,
  };
}

function eventTypesFor(kind, status) {
  if (status !== "succeeded") return [];
  if (kind === "load_scenario") return ["scenario.started"];
  if (kind === "comment") return ["comment.created"];
  if (kind === "agent_proposal") return ["model.request_prepared", "workspace.edit_committed"];
  if (kind === "restart") return ["session.restarted"];
  return ["workspace.edit_committed"];
}

function ui(selectedComponentId, scenarioId, status, phase = "after", extra = {}) {
  const base = { selected_component_id: selectedComponentId, selected_scenario_id: scenarioId, connection: "connected", running: phase === "during" };
  if (phase === "conflict" || phase === "error" || status === "rejected" || status === "failed") base.status = { tone: "error" };
  return { ...base, ...extra };
}

function buildExpectations(scenarioId, selectedComponentId, initial, actionRecords, models) {
  const checkpoints = actionRecords.map((record, index) => {
    const { action: item, status, eventTypes } = record;
    const expectedSelectedComponentId = record.selectedComponentId ?? selectedComponentId;
    const expectedModel = clone(models[index]);
    const points = item.live_capture_points.map((point) => ({
      phase: point.phase,
      expected_ui: ui(expectedSelectedComponentId, scenarioId, status, point.phase),
      invariants: [],
    }));
    return {
      checkpoint_id: item.expectation_checkpoint_id,
      after_action_id: item.action_id,
      expected_action_status: status,
      expected_events: { sequence: eventTypes, allow_additional: true },
      expected_model: expectedModel,
      invariants: [],
      live_checkpoints: points,
    };
  });
  return {
    format: "canvas-render-eval-expectations-v1",
    case_id: `${scenarioId}/${actionRecords.caseExampleId}`,
    initial_model: clone(initial),
    checkpoints,
    final_checkpoint_id: checkpoints.at(-1).checkpoint_id,
  };
}

function loadAction(scenarioId) {
  return action("load-scenario", "load_scenario", "api", { scenario_id: scenarioId }, "succeeded", ["after"], eventTypesFor("load_scenario", "succeeded"));
}

function buildDefinition(scenarioId, exampleId, seed, title, tags, make) {
  const initial = clone(fixtures[scenarioId]);
  const { records, models, faultProfile = null, selectedComponentId = initial.components[0]?.id ?? null } = make(initial);
  records.forEach((record, index) => {
    record.action.step = index + 1;
    record.action.expectation_checkpoint_id = `${record.action.action_id}-checkpoint`;
    record.eventTypes = record.eventTypes ?? eventTypesFor(record.action.kind, record.status);
  });
  const caseId = `${scenarioId}/${exampleId}`;
  const expectations = buildExpectations(scenarioId, selectedComponentId, initial, Object.assign(records, { caseExampleId: exampleId }), models);
  return {
    spec: {
      schema_version: 1,
      case_id: caseId,
      scenario_id: scenarioId,
      example_id: exampleId,
      title,
      seed,
      fixture: "fixture.json",
      expectations: "expectations.json",
      actions: "actions.jsonl",
      viewport: { width: 1440, height: 1000, device_scale_factor: 1 },
      view_policy: { selected_component_id: selectedComponentId, open_panel: "none", focus: null, scroll: { app_x: 0, app_y: 0, canvas_x: 0, canvas_y: 0 } },
      fault_profile: faultProfile,
      tags,
    },
    fixture: initial,
    expectations,
    records,
  };
}

function mutateModel(model, operation) {
  const next = clone(model);
  if (operation.componentId && operation.field) next.components.find((item) => item.id === operation.componentId)[operation.field] = operation.value;
  if (operation.kind === "duplicate") next.components.splice(1, 0, card("card-01", next.components[0].title, next.components[0].body, next.components[0].color));
  if (operation.kind === "delete") next.components = next.components.filter((item) => item.id !== operation.componentId);
  if (operation.kind === "move") next.components = [next.components[0], ...next.components.slice(1).reverse()];
  if (operation.kind === "create") next.components.push(card(operation.id, operation.title, operation.body));
  return next;
}

function productCases() {
  const defs = [];
  defs.push(buildDefinition("human-edit", "nominal", 1101, "Edit one short title", ["p0", "text", "human"], (initial) => {
    const next = mutateModel(initial, { componentId: "welcome", field: "title", value: "Start your project" });
    return { records: [loadAction("human-edit"), action("edit-title", "set_text", "ui", { component_id: "welcome", node_id: "title", value: "Start your project", base_revision: 1 }, "succeeded", ["before", "after"])], models: [initial, next] };
  }));
  defs.push(buildDefinition("human-edit", "unicode-escape", 1102, "Edit body with Unicode and literal markup", ["p0", "unicode", "escape"], (initial) => {
    const next = mutateModel(initial, { componentId: "welcome", field: "body", value: "你好 👋 <b>literal</b> & goodbye" });
    return { records: [loadAction("human-edit"), action("edit-body-unicode", "set_text", "ui", { component_id: "welcome", node_id: "body", value: "你好 👋 <b>literal</b> & goodbye", base_revision: 1 }, "succeeded", ["before", "after"])], models: [initial, next] };
  }));
  defs.push(buildDefinition("human-edit", "stale-conflict", 1103, "Reject a stale draft without changing the model", ["p0", "conflict", "revision"], (initial) => {
    const committed = mutateModel(initial, { componentId: "welcome", field: "title", value: "Committed by B" });
    return { records: [loadAction("human-edit"), action("commit-window-b", "set_text", "ui", { component_id: "welcome", node_id: "title", value: "Committed by B", base_revision: 1 }, "succeeded", ["after"]), action("submit-stale-a", "set_text", "ui", { component_id: "welcome", node_id: "title", value: "Draft from A", base_revision: 1 }, "rejected", ["conflict"])], models: [initial, committed, committed] };
  }));

  defs.push(buildDefinition("comment-agent", "nominal", 1201, "Comment on title and run an agent", ["p0", "comment", "agent"], (initial) => {
    const next = mutateModel(initial, { componentId: "welcome", field: "title", value: "Build together" });
    return { records: [loadAction("comment-agent"), action("comment-title", "comment", "ui", { component_id: "welcome", node_id: "title", text: "标题：Build together", revision: 1 }, "succeeded", ["after"]), action("agent-title", "agent_proposal", "engine", { engine: "mock", prompt: "标题：Build together", comment_id: "comment-01" }, "succeeded", ["during", "after"])], models: [initial, initial, next] };
  }));
  defs.push(buildDefinition("comment-agent", "body-anchor", 1202, "Keep a body comment anchored across selection changes", ["p0", "comment", "anchor"], (initial) => {
    const next = mutateModel(initial, { componentId: "welcome", field: "title", value: "Body reviewed" });
    return { records: [loadAction("comment-agent"), action("comment-body", "comment", "ui", { component_id: "welcome", node_id: "body", text: "Review this paragraph", revision: 1 }, "succeeded", ["after"]), action("select-title", "select_component", "ui", { component_id: "welcome", node_id: "title" }, "succeeded", ["after"], []), action("agent-from-body-comment", "agent_proposal", "engine", { engine: "mock", prompt: "标题：Body reviewed", comment_id: "comment-01", anchored_node_id: "body" }, "succeeded", ["during", "after"])], models: [initial, initial, initial, next] };
  }));
  defs.push(buildDefinition("comment-agent", "invalid-proposal", 1203, "Fail closed on an invalid agent proposal", ["p0", "comment", "error"], (initial) => ({ records: [loadAction("comment-agent"), action("comment-title", "comment", "ui", { component_id: "welcome", node_id: "title", text: "标题：Invalid", revision: 1 }, "succeeded", ["after"]), action("invalid-agent", "agent_proposal", "engine", { engine: "mock", prompt: "invalid proposal", comment_id: "comment-01", fault_profile: "invalid-proposal" }, "failed", ["error"])], models: [initial, initial, initial], faultProfile: { id: "invalid-proposal", stage: "provider", outcome: "failed" } }))); 

  defs.push(buildDefinition("shared-undo", "nominal", 1301, "Share undo between human and agent", ["p0", "history", "undo"], (initial) => {
    const human = mutateModel(initial, { componentId: "welcome", field: "title", value: "Human version" });
    const agent = mutateModel(human, { componentId: "welcome", field: "title", value: "Agent version" });
    return { records: [loadAction("shared-undo"), action("human-edit", "set_text", "ui", { component_id: "welcome", node_id: "title", value: "Human version", base_revision: 1 }), action("agent-edit", "agent_proposal", "engine", { engine: "mock", prompt: "标题：Agent version" }, "succeeded", ["during", "after"]), action("undo-agent", "undo", "ui", { count: 1 }), action("undo-human", "undo", "ui", { count: 1 }), action("redo-human", "redo", "ui", { count: 1 })], models: [initial, human, agent, human, initial, human] };
  }));
  defs.push(buildDefinition("shared-undo", "branch-invalidation", 1302, "Invalidate redo after a new branch", ["p0", "history", "branch"], (initial) => {
    const human = mutateModel(initial, { componentId: "welcome", field: "title", value: "Human version" });
    const branch = mutateModel(initial, { componentId: "welcome", field: "title", value: "New branch" });
    return { records: [loadAction("shared-undo"), action("human-edit", "set_text", "ui", { component_id: "welcome", node_id: "title", value: "Human version", base_revision: 1 }), action("undo-human", "undo", "ui", { count: 1 }), action("branch-edit", "set_text", "ui", { component_id: "welcome", node_id: "title", value: "New branch", base_revision: 1 }), action("redo-rejected", "redo", "ui", { count: 1 }, "rejected", ["error"])], models: [initial, human, initial, branch, branch] };
  }));
  defs.push(buildDefinition("shared-undo", "restart", 1303, "Restore shared history across restart", ["p0", "history", "restart"], (initial) => {
    const edited = mutateModel(initial, { componentId: "welcome", field: "title", value: "Persisted version" });
    return { records: [loadAction("shared-undo"), action("human-edit", "set_text", "ui", { component_id: "welcome", node_id: "title", value: "Persisted version", base_revision: 1 }), action("restart", "restart", "api", { checkpoint: "after-human-edit" }, "succeeded", ["after"], []), action("undo-after-restart", "undo", "ui", { count: 1 }), action("redo-after-restart", "redo", "ui", { count: 1 })], models: [initial, edited, edited, initial, edited] };
  }));

  defs.push(buildDefinition("component-lifecycle", "nominal", 1401, "Duplicate, move, delete and undo a component", ["p0", "lifecycle", "identity"], (initial) => {
    const duplicated = mutateModel(initial, { kind: "duplicate" });
    const moved = mutateModel(duplicated, { kind: "move" });
    const deleted = mutateModel(moved, { kind: "delete", componentId: "card-01" });
    return { records: [loadAction("component-lifecycle"), selectedAfter(action("duplicate-alpha", "duplicate", "ui", { component_id: "alpha", new_component_id: "card-01" }), "card-01"), selectedAfter(action("move-duplicate", "move", "ui", { component_id: "card-01", index: 2 }), "card-01"), action("delete-duplicate", "delete", "ui", { component_id: "card-01" }), action("undo-delete", "undo", "ui", { count: 1 })], models: [initial, duplicated, moved, deleted, moved] };
  }));
  defs.push(buildDefinition("component-lifecycle", "capacity", 1402, "Reject the ninth component at the capacity boundary", ["p0", "lifecycle", "capacity"], (initial) => {
    const records = [loadAction("component-lifecycle")];
    const models = [initial];
    let current = clone(initial);
    for (let index = 1; index <= 6; index += 1) { current = mutateModel(current, { kind: "create", id: `card-0${index}`, title: `Card ${index}`, body: "Capacity test" }); records.push(selectedAfter(action(`create-card-${index}`, "create", "ui", { component_id: `card-0${index}`, title: `Card ${index}`, body: "Capacity test" }), `card-0${index}`)); models.push(current); }
    records.push(selectedAfter(action("create-card-08", "create", "ui", { component_id: "card-08", title: "Card 8", body: "Overflow" }, "rejected", ["error"]), "card-06")); models.push(current);
    return { records, models };
  }));
  defs.push(buildDefinition("component-lifecycle", "idempotent-retry", 1403, "Apply a retried command only once", ["p0", "lifecycle", "idempotency"], (initial) => {
    const created = mutateModel(initial, { kind: "create", id: "card-01", title: "Retry card", body: "One commit" });
    return { records: [loadAction("component-lifecycle"), selectedAfter(action("create-retry-first", "create", "api", { command_id: "cmd-retry-01", component_id: "card-01", title: "Retry card", body: "One commit" }), "card-01"), selectedAfter(action("create-retry-same", "create", "api", { command_id: "cmd-retry-01", component_id: "card-01", title: "Retry card", body: "One commit" }, "succeeded", ["after"], []), "card-01"), selectedAfter(action("create-retry-conflict", "create", "api", { command_id: "cmd-retry-01", component_id: "card-01", title: "Different input", body: "Must reject" }, "rejected", ["error"]), "card-01")], models: [initial, created, created, created] };
  }));

  defs.push(buildDefinition("html-component", "nominal", 1501, "Edit an HTML text node and change layout", ["p0", "html", "layout"], (initial) => {
    const edited = { components: [{ ...initial.components[0], html: initial.components[0].html.replace("A shared HTML component", "A shared launch") }] };
    const laidOut = { components: [{ ...edited.components[0], html: mockLayout(edited.components[0].html) }] };
    return { records: [loadAction("html-component"), action("edit-html-title", "set_text", "ui", { component_id: "hero", node_id: "title", value: "A shared launch", base_revision: 1 }, "succeeded", ["before", "after"]), action("layout-horizontal", "agent_proposal", "engine", { engine: "mock", prompt: "layout: horizontal" }, "succeeded", ["during", "after"])], models: [initial, edited, laidOut], selectedComponentId: "hero" };
  }));
  defs.push(buildDefinition("html-component", "nested-unicode", 1502, "Edit a nested HTML leaf with long Unicode text", ["p0", "html", "unicode"], (initial) => {
    const value = "中文内容 👋 — nested leaf with literal <b>markup</b>";
    const edited = { components: [{ ...initial.components[0], html: initial.components[0].html.replace("Edit this node, then ask the agent to change the layout.", escapeHTML(value)) }] };
    return { records: [loadAction("html-component"), action("edit-html-body-unicode", "set_text", "ui", { component_id: "hero", node_id: "body", value, base_revision: 1 }, "succeeded", ["before", "after"])], models: [initial, edited], selectedComponentId: "hero" };
  }));
  defs.push(buildDefinition("html-component", "security-error", 1503, "Reject unsafe or ambiguous HTML mutations", ["p0", "html", "security"], (initial) => ({ records: [loadAction("html-component"), action("unsafe-html", "set_html_source", "ui", { component_id: "hero", html: "<article data-node-id=\"root\"><script>alert(1)</script><img src=\"https://external.invalid/x.png\" onclick=\"alert(1)\"></article>", fault_profile: "html-security-active-content" }, "failed", ["error"])], models: [initial, initial], selectedComponentId: "hero", faultProfile: { id: "html-security-active-content", stage: "input", outcome: "failed" } }))); 

  defs.push(buildDefinition("audited-request", "capture-off", 1601, "Run an auditable request without full capture", ["p0", "request", "capture-off"], (initial) => {
    const next = mutateModel(initial, { componentId: "welcome", field: "color", value: "#0d9488" });
    return { records: [loadAction("audited-request"), action("agent-color-off", "agent_proposal", "engine", { engine: "mock", prompt: "change color", capture: false, assert: true }, "succeeded", ["during", "after"])], models: [initial, next] };
  }));
  defs.push(buildDefinition("audited-request", "capture-on", 1602, "Run the same request with full capture enabled", ["p0", "request", "capture-on"], (initial) => {
    const next = mutateModel(initial, { componentId: "welcome", field: "color", value: "#0d9488" });
    return { records: [loadAction("audited-request"), action("agent-color-on", "agent_proposal", "engine", { engine: "mock", prompt: "change color", capture: true, assert: true }, "succeeded", ["before", "during", "after"])], models: [initial, next] };
  }));
  defs.push(buildDefinition("audited-request", "corrupt-reconstruction", 1603, "Fail closed when a request fragment is corrupt", ["p0", "request", "reconstruction"], (initial) => ({ records: [loadAction("audited-request"), action("agent-corrupt", "agent_proposal", "engine", { engine: "mock", prompt: "change color", capture: true, assert: true, fault_profile: "request-fragment-corruption" }, "failed", ["error"])], models: [initial, initial], faultProfile: { id: "request-fragment-corruption", stage: "reconstruction", outcome: "failed" } }))); 
  return defs;
}

function compileCase(definition) {
  const { spec, fixture, expectations, records } = definition;
  const actions = records.map(({ action: item }) => item);
  const semanticFingerprint = sha256({ spec, fixture, expectations, actions });
  const compiled = {
    format: "canvas-render-eval-case-v1",
    case_id: spec.case_id,
    scenario_id: spec.scenario_id,
    example_id: spec.example_id,
    title: spec.title,
    seed: spec.seed,
    generation: { mode: "execute_actions", parameterized_scenario: true },
    viewport: spec.viewport,
    view_policy: { selected_component_id: spec.view_policy.selected_component_id ?? "", selected_scenario_id: spec.scenario_id, open_panel: spec.view_policy.open_panel, focus: spec.view_policy.focus, scroll: spec.view_policy.scroll },
    paths: {
      expectations: "inputs/expectations.json",
      actions: "inputs/actions.jsonl",
      action_results: "execution/action-results.jsonl",
      events: "trajectory/events.jsonl",
      trajectory_blobs: "trajectory/blobs/sha256",
      id_aliases: "execution/id-aliases.json",
      captures: "observations/captures.jsonl",
      artifacts: "artifacts/sha256",
      assertions: "results/assertions.jsonl",
      summary: "results/summary.json",
    },
    oracles: { structural: true, visual_regression: { enabled: false, baseline_manifest: null }, visual_quality: { enabled: true, rubric_version: "v1", blocking: false } },
    reproducibility: { semantic_fingerprint: semanticFingerprint, generated_id_strategy: "deterministic-provider", volatile_event_fields: ["/event_id", "/session_id", "/timestamp"] },
  };
  return { ...definition, actions, compiled };
}

function faultCorpus() {
  const valid = [
    ["gate-provider-before-pause", "provider", "not_reached", "gate_armed"],
    ["gate-cancel-after-pause", "capture", "released", "gate_released"],
    ["gate-capture-timeout", "capture", "released", "gate_released"],
    ["gate-release-failed", "capture", "release_failed", "gate_release_failed"],
    ["gate-crash-before-outcome", "capture", "paused", "capture_started"],
    ["gate-crash-after-outcome", "capture", "paused", "capture_started"],
    ["capture-tail-moved", "capture", "blocked", "capture_finished"],
    ["capture-render-error", "capture", "failed", "capture_finished"],
    ["browser-startup-failure", "browser", "incomplete", null],
  ].map(([id, stage, expectedStatus, terminal]) => ({ id, kind: "valid-fault", sourceCaseId: "audited-request/capture-on", mutation: { stage, fault: id }, expected: { bundle_valid: true, summary_status: expectedStatus, terminal_observation: terminal } }));
  const invalid = [
    ["invalid-capture-owner", "capture.action_reference", "remove capture owner action result"],
    ["invalid-gate-order", "gate.lifecycle", "append capture_started after gate_released"],
    ["invalid-cutoff-regression", "capture.cutoff_regressed", "set after cutoff lower than before cutoff"],
  ].map(([id, code, description]) => ({ id, kind: "invalid-mutation", sourceCaseId: "audited-request/capture-on", mutation: { description }, expected: { bundle_valid: false, error_codes: [code] } }));
  return [...valid, ...invalid];
}

function prepareDir(directory) { fs.mkdirSync(directory, { recursive: true }); }
function writeJson(file, value) { prepareDir(path.dirname(file)); fs.writeFileSync(file, canonical(value)); }
function writeJsonl(file, values) { prepareDir(path.dirname(file)); fs.writeFileSync(file, values.map((value) => JSON.stringify(value)).join("\n") + "\n"); }

export function buildCases() { return productCases().map(compileCase); }
export function buildFaultCorpus() { return faultCorpus(); }

export function generate() {
  const cases = buildCases();
  for (const definition of cases) {
    const directory = path.join(casesRoot, definition.spec.scenario_id, definition.spec.example_id);
    writeJson(path.join(directory, "spec.json"), definition.spec);
    writeJson(path.join(directory, "fixture.json"), definition.fixture);
    writeJson(path.join(directory, "expectations.json"), definition.expectations);
    writeJsonl(path.join(directory, "actions.jsonl"), definition.actions);
    writeJson(path.join(directory, "case.json"), definition.compiled);
  }
  const manifest = { format: "canvas-render-eval-input-manifest-v1", generator: "generate-cases.mjs", generator_version: "1", cases: cases.map(({ spec }) => spec.case_id), case_count: cases.length, examples_per_scenario: 3 };
  writeJson(path.join(casesRoot, "manifest.json"), manifest);
  const faults = buildFaultCorpus();
  for (const fault of faults) {
    const directory = path.join(faultsRoot, fault.id);
    writeJson(path.join(directory, "source.json"), { source_case_id: fault.sourceCaseId });
    writeJson(path.join(directory, "mutation.json"), fault.mutation);
    writeJson(path.join(directory, "expected.json"), { kind: fault.kind, ...fault.expected });
  }
  writeJson(path.join(faultsRoot, "manifest.json"), { format: "canvas-render-eval-fault-manifest-v1", faults: faults.map(({ id }) => id), fault_count: faults.length, valid_fault_count: 9, invalid_mutation_count: 3 });
  return { cases, faults };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = generate();
  console.log(`generated ${result.cases.length} cases and ${result.faults.length} fault fixtures`);
}
