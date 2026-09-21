import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";

import { validate as validateModel } from "../store.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const schemaDir = path.join(here, "..", "eval", "schema");
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });
const schemas = Object.fromEntries(
  fs.readdirSync(schemaDir).map((file) => {
    const schema = JSON.parse(fs.readFileSync(path.join(schemaDir, file), "utf8"));
    return [file, { schema, validate: ajv.compile(schema) }];
  }),
);
const digest = "a".repeat(64);
const ref = (media_type = "application/json") => ({
  sha256: digest,
  size_bytes: 2,
  media_type,
});
const model = {
  components: [
    {
      id: "welcome",
      title: "Start your project",
      body: "Double-click this title to begin.",
      color: "#6366f1",
    },
  ],
};
const check = (file, value) => {
  const valid = schemas[file].validate(value);
  assert.equal(valid, true, JSON.stringify(schemas[file].validate.errors));
};

test("all eval schemas compile and their IDs are unique", () => {
  assert.equal(Object.keys(schemas).length, 11);
  assert.equal(
    new Set(Object.values(schemas).map(({ schema }) => schema.$id)).size,
    Object.keys(schemas).length,
  );
});

test("run metadata pins both capture modes and summary separates coverage from pass", () => {
  check("run.schema.json", {
    format: "canvas-render-eval-run-v1",
    run_id: "run-1",
    created_at: "2026-09-20T18:30:00.000Z",
    source: {
      repository: "https://github.com/hyh626/codex-canvas",
      commit: "b".repeat(40),
      dirty: false,
      model_schema: "urn:canvas-demo:model:v1",
      event_schema_version: 1,
    },
    runtime: {
      runner: "canvas-render-eval/0.1.0",
      node: "22.20.0",
      browser: { name: "chromium", version: "154.0.0", headless: true },
      os_image: "canvas-eval@sha256:digest",
      locale: "en-US",
      timezone: "UTC",
      color_scheme: "light",
      reduced_motion: "reduce",
      fonts: ["Inter@digest"],
    },
    defaults: {
      viewport: { width: 1440, height: 1000, device_scale_factor: 1 },
      surfaces: ["app", "canvas"],
      capture_modes: ["event_replay", "live_checkpoint"],
      event_capture_phase: "after_event",
      comparison: {
        raw_trajectory: "byte-exact-within-run",
        cross_run: "semantic-fingerprint-plus-render-artifacts",
      },
    },
  });
  check("summary.schema.json", {
    format: "canvas-render-eval-summary-v1",
    case_id: "html-component/boundary",
    status: "fail",
    coverage: {
      events: { expected: 6, captured: 6, complete: true },
      live_checkpoints: { expected: 2, captured: 2, complete: true },
    },
    counts: {
      actions: 2,
      captures_ok: 7,
      captures_failed: 1,
      assertions: 31,
      required_failed: 1,
    },
    final: { event_seq: 6, revision: 2, model_hash: digest },
    timing_ms: { execute: 83, replay_render: 1124, oracles: 217 },
    failures: [
      { assertion_id: "iframe-ready", message: "Iframe did not stabilize" },
    ],
  });
});

test("parameterized case, expectations, action and result validate", () => {
  validateModel(model);
  check("case.schema.json", {
    format: "canvas-render-eval-case-v1",
    case_id: "human-edit/nominal",
    scenario_id: "human-edit",
    example_id: "nominal",
    title: "Edit a short title",
    seed: 1101,
    generation: { mode: "execute_actions", parameterized_scenario: true },
    viewport: { width: 1440, height: 1000, device_scale_factor: 1 },
    view_policy: {
      selected_component_id: "welcome",
      selected_scenario_id: "human-edit",
      open_panel: "none",
      focus: null,
      scroll: { app_x: 0, app_y: 0, canvas_x: 0, canvas_y: 0 },
    },
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
    oracles: {
      structural: true,
      visual_regression: { enabled: false, baseline_manifest: null },
      visual_quality: {
        enabled: true,
        rubric_version: "canvas-quality-v1",
        blocking: false,
      },
    },
    reproducibility: {
      semantic_fingerprint: digest,
      generated_id_strategy: "deterministic-provider",
      volatile_event_fields: ["/event_id", "/session_id", "/timestamp"],
    },
  });
  check("expectations.schema.json", {
    format: "canvas-render-eval-expectations-v1",
    case_id: "human-edit/nominal",
    initial_model: model,
    checkpoints: [
      {
        checkpoint_id: "title-edited",
        after_action_id: "edit-title",
        expected_action_status: "succeeded",
        expected_events: {
          sequence: ["workspace.edit_committed"],
          allow_additional: false,
        },
        expected_model: model,
        invariants: [
          { scope: "model", operator: "unchanged", path: "/components/0/id", compare_to: "model_pre_action" },
        ],
        live_checkpoints: [
          {
            phase: "after",
            expected_ui: { running: false, status: { tone: "success" } },
            invariants: [{ scope: "ui", operator: "equals", path: "/running", value: false }],
          },
        ],
      },
    ],
    final_checkpoint_id: "title-edited",
  });
  check("action.schema.json", {
    schema_version: 1,
    action_id: "edit-title",
    step: 2,
    kind: "set_text",
    driver: "ui",
    input: { component_id: "welcome", node_id: "title", text: "Start your project" },
    expectation_checkpoint_id: "title-edited",
    live_capture_points: [
      { phase: "before", ready_when: { signal: "render_idle" } },
      { phase: "after", ready_when: { signal: "render_idle" } },
    ],
  });
  check("action-result.schema.json", {
    schema_version: 1,
    action_id: "edit-title",
    step: 2,
    status: "succeeded",
    http_status: 200,
    emitted_events: [
      { seq: 4, event_id: "event-4", type: "workspace.edit_committed" },
    ],
    capture_ids: [
      "human-edit/nominal@edit-title-before",
      "human-edit/nominal@edit-title-after",
    ],
    duration_ms: 42,
  });
});

test("successful and failed capture outcomes preserve different evidence requirements", () => {
  const successful = {
    schema_version: 1,
    capture_id: "human-edit/nominal@event-000004",
    case_id: "human-edit/nominal",
    mode: "event_replay",
    status: "ok",
    trigger: {
      event: {
        seq: 4,
        event_id: "event-4",
        type: "workspace.edit_committed",
        phase: "after_event",
      },
    },
    state: {
      events_through_seq: 4,
      revision: 2,
      model: ref(),
      model_hash: digest,
      ui_state: ref(),
    },
    evidence: {
      stability: {
        renderer_seq: 4,
        fonts_ready: true,
        pending_requests: 0,
        animation_frames_waited: 2,
        iframes_expected: 0,
        iframes_ready: 0,
      },
      captures: [
        { surface: "app", artifact: ref("image/png"), width: 1440, height: 1000 },
        {
          surface: "canvas",
          selector: "#canvas",
          artifact: ref("image/png"),
          width: 780,
          height: 520,
        },
      ],
      dom: ref("text/html"),
      accessibility: ref(),
      console: ref(),
      iframes: [],
    },
  };
  check("capture.schema.json", successful);
  const successfulLive = structuredClone(successful);
  successfulLive.capture_id = "human-edit/nominal@edit-title-after";
  successfulLive.mode = "live_checkpoint";
  successfulLive.trigger = {
    action: {
      action_id: "edit-title",
      phase: "after",
      event_seq_at_capture: 4,
      event_seq_after_capture: 4,
    },
  };
  check("capture.schema.json", successfulLive);
  delete successfulLive.trigger.action.event_seq_after_capture;
  assert.equal(schemas["capture.schema.json"].validate(successfulLive), false);
  check("capture.schema.json", {
    schema_version: 1,
    capture_id: "html-component/boundary@event-000006",
    case_id: "html-component/boundary",
    mode: "event_replay",
    status: "timeout",
    trigger: {
      event: {
        seq: 6,
        event_id: "event-6",
        type: "workspace.edit_committed",
        phase: "after_event",
      },
    },
    error: {
      stage: "stability",
      name: "IframeReadyTimeout",
      message: "Expected one iframe",
    },
    evidence: { console: ref() },
  });

  const missingEvidence = structuredClone(successful);
  delete missingEvidence.evidence;
  assert.equal(schemas["capture.schema.json"].validate(missingEvidence), false);

  const missingError = {
    schema_version: 1,
    capture_id: "html-component/boundary@event-000006",
    case_id: "html-component/boundary",
    mode: "event_replay",
    status: "timeout",
    trigger: successful.trigger,
  };
  assert.equal(schemas["capture.schema.json"].validate(missingError), false);
});

test("partial failure evidence, startup failure summaries and observed UI state validate", () => {
  check("summary.schema.json", {
    format: "canvas-render-eval-summary-v1",
    case_id: "human-edit/startup-failure",
    status: "incomplete",
    coverage: {
      events: { expected: 0, captured: 0, complete: false },
      live_checkpoints: { expected: 0, captured: 0, complete: false },
    },
    counts: { actions: 0, captures_ok: 0, captures_failed: 0, assertions: 0, required_failed: 0 },
    final: null,
    failure_stage: "setup",
    run_error: { name: "BrowserLaunchError", message: "Chromium did not start" },
    timing_ms: { execute: 0, replay_render: 0, oracles: 0 },
    failures: [],
  });

  const invalidPass = {
    format: "canvas-render-eval-summary-v1",
    case_id: "human-edit/startup-failure",
    status: "pass",
    coverage: {
      events: { expected: 0, captured: 0, complete: true },
      live_checkpoints: { expected: 0, captured: 0, complete: true },
    },
    counts: { actions: 0, captures_ok: 0, captures_failed: 0, assertions: 0, required_failed: 0 },
    final: null,
    timing_ms: { execute: 0, replay_render: 0, oracles: 0 },
    failures: [],
  };
  assert.equal(schemas["summary.schema.json"].validate(invalidPass), false);

  check("ui-state.schema.json", {
    schema_version: 1,
    selected_component_id: "welcome",
    selected_scenario_id: "human-edit",
    open_panel: "none",
    focus: null,
    scroll: { app_x: 0, app_y: 0, canvas_x: 0, canvas_y: 0 },
    dirty: false,
    running: true,
    connection: "connected",
    dialogs: [],
    editor: { mode: "none", draft: null, error: null, rebase_available: false },
    status: { text: "Applying edit", tone: "pending" },
    controls: { undo_enabled: true, redo_enabled: false, run_enabled: false },
  });
});

test("operator semantics, live barriers and ID causality are machine constrained", () => {
  const expectation = {
    format: "canvas-render-eval-expectations-v1",
    case_id: "human-edit/semantics",
    initial_model: model,
    checkpoints: [{
      checkpoint_id: "done",
      after_action_id: "edit-title",
      expected_action_status: "succeeded",
      expected_events: { sequence: ["workspace.edit_committed"], allow_additional: false },
      expected_model: model,
      invariants: [{
        scope: "event",
        operator: "equals",
        path: "/payload/component_id",
        value: "welcome",
        event_match: { type: "workspace.edit_committed", occurrence: "exact_one" },
        event_scope: "current_action",
      }],
      live_checkpoints: [],
    }],
    final_checkpoint_id: "done",
  };
  check("expectations.schema.json", expectation);
  const missingValue = structuredClone(expectation);
  delete missingValue.checkpoints[0].invariants[0].value;
  assert.equal(schemas["expectations.schema.json"].validate(missingValue), false);
  const missingMatch = structuredClone(expectation);
  delete missingMatch.checkpoints[0].invariants[0].event_match;
  assert.equal(schemas["expectations.schema.json"].validate(missingMatch), false);
  const missingComparisonBase = structuredClone(expectation);
  missingComparisonBase.checkpoints[0].invariants = [{
    scope: "model",
    operator: "unchanged",
    path: "/components/0/id",
  }];
  assert.equal(schemas["expectations.schema.json"].validate(missingComparisonBase), false);
  const unknownUiField = structuredClone(expectation);
  unknownUiField.checkpoints[0].live_checkpoints = [{
    phase: "during",
    expected_ui: { spinnerish: true },
    invariants: [],
  }];
  assert.equal(schemas["expectations.schema.json"].validate(unknownUiField), false);

  const duringAction = {
    schema_version: 1,
    action_id: "generate-copy",
    step: 3,
    kind: "generate_copy",
    driver: "ui",
    input: {},
    expectation_checkpoint_id: "done",
    live_capture_points: [{
      phase: "during",
      ready_when: { signal: "loading_visible" },
      response_gate: {
        name: "generate-copy-response",
        pause_at: "before_model_commit",
        release: "after_capture",
      },
    }],
  };
  check("action.schema.json", duringAction);
  const missingGate = structuredClone(duringAction);
  delete missingGate.live_capture_points[0].response_gate;
  assert.equal(schemas["action.schema.json"].validate(missingGate), false);
  check("action-result.schema.json", {
    schema_version: 1,
    action_id: "generate-copy",
    step: 3,
    status: "succeeded",
    emitted_events: [{ seq: 5, event_id: "event-5", type: "workspace.edit_committed" }],
    capture_ids: ["human-edit/semantics@generate-copy-during"],
    duration_ms: 42,
    gate: {
      name: "generate-copy-response",
      pause_at: "before_model_commit",
      status: "released",
      release_reason: "captured",
      observations: [
        { ordinal: 1, phase: "gate_armed" },
        { ordinal: 2, phase: "gate_paused" },
        { ordinal: 3, phase: "capture_started", capture_id: "human-edit/semantics@generate-copy-during" },
        { ordinal: 4, phase: "capture_finished", capture_id: "human-edit/semantics@generate-copy-during" },
        { ordinal: 5, phase: "gate_released" },
      ],
    },
  });

  const aliases = {
    format: "canvas-render-eval-id-aliases-v1",
    case_id: "human-edit/semantics",
    references_preserved: true,
    event_reference_paths: ["/event_id", "/caused_by/*", "/payload/target", "/payload/request_event_id", "/payload/command_id"],
    derived_value_paths: [{
      path: "/payload/fingerprint",
      comparison: "recompute_from_canonical_projection",
    }],
    mappings: [
      { kind: "event", actual_id: "evt-random-1", alias: "event-1", defined_at_seq: 1 },
      { kind: "event", actual_id: "evt-random-2", alias: "event-2", defined_at_seq: 2 },
      { kind: "command", actual_id: "random-command-id", alias: "command-1", defined_at_seq: 2 },
    ],
  };
  check("id-aliases.schema.json", aliases);
  const missingCommandPath = structuredClone(aliases);
  missingCommandPath.event_reference_paths.pop();
  assert.equal(schemas["id-aliases.schema.json"].validate(missingCommandPath), false);
});

test("partial state, draft evidence and gate semantics cannot be silently weakened", () => {
  const partialFailure = {
    schema_version: 1,
    capture_id: "human-edit/nominal@event-000001",
    case_id: "human-edit/nominal",
    mode: "event_replay",
    status: "timeout",
    trigger: { event: { seq: 1, event_id: "event-1", type: "session.started", phase: "after_event" } },
    state: { revision: 0, model: ref(), model_hash: digest },
    evidence: { stability: { fonts_ready: true } },
    error: { stage: "capture", name: "UiStateTimeout", message: "State inspection timed out" },
  };
  check("capture.schema.json", partialFailure);

  const fullUi = {
    schema_version: 1,
    selected_component_id: "welcome",
    selected_scenario_id: "human-edit",
    open_panel: "none",
    focus: "#inlineText",
    scroll: { app_x: 0, app_y: 0, canvas_x: 0, canvas_y: 0 },
    dirty: true,
    running: false,
    connection: "connected",
    dialogs: [{ id: "inlineEdit", open: true }],
    editor: {
      mode: "inline_text",
      draft: { component_id: "welcome", node_id: "title", base_revision: 3, value: "Retained conflict draft" },
      error: "Revision conflict",
      rebase_available: true,
    },
    status: { text: "Revision conflict", tone: "error" },
    controls: { undo_enabled: true, redo_enabled: false, run_enabled: true },
  };
  check("ui-state.schema.json", fullUi);
  const noDraft = structuredClone(fullUi);
  noDraft.editor.draft = null;
  assert.equal(schemas["ui-state.schema.json"].validate(noDraft), false);

  const invalidDuring = {
    schema_version: 1,
    action_id: "invalid-during",
    step: 4,
    kind: "generate_copy",
    driver: "ui",
    input: {},
    expectation_checkpoint_id: "done",
    live_capture_points: [{
      phase: "during",
      ready_when: { signal: "render_idle" },
      response_gate: { name: "gate", pause_at: "before_model_commit", release: "after_capture" },
    }],
  };
  assert.equal(schemas["action.schema.json"].validate(invalidDuring), false);

  const liveCapture = {
    schema_version: 1,
    capture_id: "human-edit/nominal@generate-copy-during",
    case_id: "human-edit/nominal",
    mode: "live_checkpoint",
    status: "timeout",
    trigger: { action: { action_id: "generate-copy", phase: "during", event_seq_at_capture: 4, event_seq_after_capture: 4 } },
    error: { stage: "capture", name: "ScreenshotTimeout", message: "Screenshot did not finish" },
  };
  check("capture.schema.json", liveCapture);
  delete liveCapture.trigger.action.event_seq_at_capture;
  delete liveCapture.trigger.action.event_seq_after_capture;
  check("capture.schema.json", liveCapture);
  liveCapture.trigger.action.event_seq_at_capture = null;
  liveCapture.trigger.action.event_seq_after_capture = null;
  check("capture.schema.json", liveCapture);
  liveCapture.status = "blocked";
  liveCapture.trigger.action.event_seq_at_capture = 4;
  liveCapture.trigger.action.event_seq_after_capture = 5;
  check("capture.schema.json", liveCapture);
});

test("gate lifecycle records capture order and supports failure before the gate", () => {
  const released = {
    schema_version: 1,
    action_id: "generate-copy",
    step: 3,
    status: "succeeded",
    emitted_events: [],
    capture_ids: ["human-edit/nominal@generate-copy-during"],
    duration_ms: 30,
    gate: {
      name: "generate-copy-response",
      pause_at: "before_model_commit",
      status: "released",
      release_reason: "captured",
      observations: [
        { ordinal: 1, phase: "gate_armed" },
        { ordinal: 2, phase: "gate_paused" },
        { ordinal: 3, phase: "capture_started", capture_id: "human-edit/nominal@generate-copy-during" },
        { ordinal: 4, phase: "capture_finished", capture_id: "human-edit/nominal@generate-copy-during" },
        { ordinal: 5, phase: "gate_released" },
      ],
    },
  };
  check("action-result.schema.json", released);
  const missingLifecycleStep = structuredClone(released);
  missingLifecycleStep.gate.observations.pop();
  assert.equal(schemas["action-result.schema.json"].validate(missingLifecycleStep), false);
  const notReached = structuredClone(released);
  notReached.status = "failed";
  notReached.error = { name: "ProviderTimeout", message: "No proposal" };
  notReached.gate = {
    name: "generate-copy-response",
    pause_at: "before_model_commit",
    status: "not_reached",
    observations: [{ ordinal: 1, phase: "gate_armed" }],
    error: { name: "ProviderTimeout", message: "No proposal" },
  };
  check("action-result.schema.json", notReached);
  notReached.gate.release_reason = "runner_error";
  assert.equal(schemas["action-result.schema.json"].validate(notReached), false);
  delete notReached.gate.release_reason;
  const cancelled = structuredClone(released);
  cancelled.status = "failed";
  cancelled.error = { name: "Cancelled", message: "Cancelled before capture" };
  cancelled.capture_ids = [];
  cancelled.gate.release_reason = "cancelled";
  cancelled.gate.observations = [
    { ordinal: 1, phase: "gate_armed" },
    { ordinal: 2, phase: "gate_paused" },
    { ordinal: 3, phase: "gate_released" },
  ];
  check("action-result.schema.json", cancelled);

  const pausedAfterCapture = structuredClone(released);
  pausedAfterCapture.status = "failed";
  pausedAfterCapture.error = { name: "RunnerInterrupted", message: "Stopped before release" };
  pausedAfterCapture.gate.status = "paused";
  pausedAfterCapture.gate.error = { name: "RunnerInterrupted", message: "Stopped before release" };
  delete pausedAfterCapture.gate.release_reason;
  pausedAfterCapture.gate.observations.pop();
  check("action-result.schema.json", pausedAfterCapture);

  const pausedDuringCapture = structuredClone(pausedAfterCapture);
  pausedDuringCapture.capture_ids = [];
  pausedDuringCapture.gate.observations.pop();
  check("action-result.schema.json", pausedDuringCapture);
});

test("summary, invariant scope and canonical reference rules reject contradictory data", () => {
  const contradictoryPass = {
    format: "canvas-render-eval-summary-v1",
    case_id: "human-edit/nominal",
    status: "pass",
    coverage: {
      events: { expected: 4, captured: 0, complete: false },
      live_checkpoints: { expected: 2, captured: 0, complete: false },
    },
    counts: { actions: 2, captures_ok: 0, captures_failed: 1, assertions: 1, required_failed: 1 },
    final: { event_seq: 4, revision: 2, model_hash: digest },
    timing_ms: { execute: 0, replay_render: 0, oracles: 0 },
    failures: [{ assertion_id: "failed", message: "required assertion failed" }],
  };
  assert.equal(schemas["summary.schema.json"].validate(contradictoryPass), false);

  const invalidEventScope = {
    format: "canvas-render-eval-expectations-v1",
    case_id: "human-edit/scope",
    initial_model: model,
    checkpoints: [{
      checkpoint_id: "done",
      after_action_id: "edit-title",
      expected_action_status: "succeeded",
      expected_events: { sequence: [], allow_additional: true },
      expected_model: model,
      invariants: [{
        scope: "event",
        operator: "equals",
        path: "/type",
        value: "workspace.edit_committed",
        event_match: { type: "workspace.edit_committed", occurrence: "exact_one" },
      }],
      live_checkpoints: [],
    }],
    final_checkpoint_id: "done",
  };
  assert.equal(schemas["expectations.schema.json"].validate(invalidEventScope), false);
  invalidEventScope.checkpoints[0].invariants[0].event_scope = "current_action";
  check("expectations.schema.json", invalidEventScope);
  invalidEventScope.checkpoints[0].invariants = [{
    scope: "ui", operator: "unchanged", path: "/dirty", compare_to: "initial_model",
  }];
  assert.equal(schemas["expectations.schema.json"].validate(invalidEventScope), false);
  invalidEventScope.checkpoints[0].invariants = [{
    scope: "model", operator: "count-equals", path: "/components", value: -1,
  }];
  assert.equal(schemas["expectations.schema.json"].validate(invalidEventScope), false);
});

test("visual baselines require deterministic IDs and caused_by cannot be ignored", () => {
  const baseCase = {
    format: "canvas-render-eval-case-v1",
    case_id: "human-edit/visual",
    scenario_id: "human-edit",
    example_id: "visual",
    title: "Visual baseline",
    seed: 1,
    generation: { mode: "execute_actions", parameterized_scenario: true },
    viewport: { width: 1440, height: 1000, device_scale_factor: 1 },
    view_policy: {
      selected_component_id: "welcome",
      selected_scenario_id: "human-edit",
      open_panel: "none",
      focus: null,
      scroll: { app_x: 0, app_y: 0, canvas_x: 0, canvas_y: 0 },
    },
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
    oracles: {
      structural: true,
      visual_regression: { enabled: true, baseline_manifest: ref() },
      visual_quality: { enabled: false, rubric_version: "canvas-quality-v1", blocking: false },
    },
    reproducibility: {
      semantic_fingerprint: digest,
      generated_id_strategy: "semantic-alias-map",
      volatile_event_fields: ["/event_id", "/session_id", "/timestamp"],
    },
  };
  assert.equal(schemas["case.schema.json"].validate(baseCase), false);
  baseCase.reproducibility.generated_id_strategy = "deterministic-provider";
  check("case.schema.json", baseCase);
  baseCase.reproducibility.volatile_event_fields.push("/caused_by");
  assert.equal(schemas["case.schema.json"].validate(baseCase), false);
});

test("rejected actions and skipped assertions require explanations", () => {
  check("action-result.schema.json", {
    schema_version: 1,
    action_id: "stale-edit",
    step: 3,
    status: "rejected",
    http_status: 409,
    emitted_events: [],
    capture_ids: ["human-edit/nominal@stale-edit-conflict"],
    duration_ms: 12,
    error: { name: "RevisionConflict", message: "Reload, then reapply" },
  });
  check("assertion.schema.json", {
    schema_version: 1,
    assertion_id: "visual-baseline",
    case_id: "human-edit/nominal",
    subject: { case_id: "human-edit/nominal" },
    oracle: "visual-regression",
    name: "baseline-not-established",
    required: false,
    status: "skip",
    message: "No human-approved immutable baseline exists yet",
  });
});
