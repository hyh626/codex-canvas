import assert from "node:assert/strict";
import test from "node:test";

import { validateEvalSemantics } from "../eval/validate-semantics.mjs";

const events = [1, 2, 3, 4, 5].map((seq) => ({ seq, event_id: `event-${seq}` }));
const liveCapture = {
  schema_version: 1,
  capture_id: "human-edit/nominal@generate-copy-during",
  case_id: "human-edit/nominal",
  mode: "live_checkpoint",
  status: "ok",
  trigger: { action: { action_id: "generate-copy", phase: "during", event_seq_at_capture: 4, event_seq_after_capture: 4 } },
  state: { events_through_seq: 4 },
  evidence: { stability: { renderer_seq: 4 } },
};
const releasedResult = {
  action_id: "generate-copy",
  capture_ids: [liveCapture.capture_id],
  gate: {
    status: "released",
    release_reason: "captured",
    observations: [
      { ordinal: 1, phase: "gate_armed" },
      { ordinal: 2, phase: "gate_paused" },
      { ordinal: 3, phase: "capture_started", capture_id: liveCapture.capture_id },
      { ordinal: 4, phase: "capture_finished", capture_id: liveCapture.capture_id },
      { ordinal: 5, phase: "gate_released" },
    ],
  },
};

test("semantic validator accepts an ordered gate capture and aligned renderer cutoff", () => {
  assert.deepEqual(validateEvalSemantics({ action_results: [releasedResult], captures: [liveCapture], events }), []);
});

test("semantic validator rejects gate order and references that schema cannot compare", () => {
  const result = structuredClone(releasedResult);
  result.gate.observations[2].ordinal = 7;
  [result.gate.observations[3], result.gate.observations[4]] = [
    result.gate.observations[4],
    result.gate.observations[3],
  ];
  const codes = validateEvalSemantics({ action_results: [result], captures: [], events }).map(({ code }) => code);
  assert.ok(codes.includes("gate.ordinal"));
  assert.ok(codes.includes("gate.capture_order"));
  assert.ok(codes.includes("gate.capture_reference"));
});

test("semantic validator binds gate observations to the same during action", () => {
  const capture = structuredClone(liveCapture);
  capture.trigger.action.action_id = "another-action";
  const codes = validateEvalSemantics({ action_results: [releasedResult], captures: [capture], events }).map(({ code }) => code);
  assert.ok(codes.includes("gate.capture_subject"));
});

test("semantic validator separates authoritative cutoff from renderer-applied seq", () => {
  const capture = structuredClone(liveCapture);
  capture.trigger.action.event_seq_at_capture = 3;
  capture.trigger.action.event_seq_after_capture = 3;
  capture.state.events_through_seq = 4;
  capture.evidence.stability.renderer_seq = 4;
  const codes = validateEvalSemantics({ captures: [capture], events, allow_partial_bundle: true }).map(({ code }) => code);
  assert.ok(codes.includes("capture.renderer_future"));

  capture.status = "blocked";
  capture.trigger.action.event_seq_at_capture = null;
  capture.trigger.action.event_seq_after_capture = null;
  delete capture.state;
  delete capture.evidence;
  assert.deepEqual(validateEvalSemantics({ captures: [capture], events, allow_partial_bundle: true }), []);
});

test("semantic validator preserves a changing trajectory tail only as blocked evidence", () => {
  const capture = structuredClone(liveCapture);
  capture.trigger.action.event_seq_after_capture = 5;
  const codes = validateEvalSemantics({ captures: [capture], events, allow_partial_bundle: true }).map(({ code }) => code);
  assert.ok(codes.includes("capture.cutoff_changed"));

  capture.status = "blocked";
  delete capture.state;
  delete capture.evidence;
  assert.deepEqual(validateEvalSemantics({ captures: [capture], events, allow_partial_bundle: true }), []);

  capture.trigger.action.event_seq_at_capture = 5;
  capture.trigger.action.event_seq_after_capture = 4;
  const regressedCodes = validateEvalSemantics({ captures: [capture], events, allow_partial_bundle: true }).map(({ code }) => code);
  assert.ok(regressedCodes.includes("capture.cutoff_regressed"));

  capture.trigger.action.event_seq_at_capture = 4;
  capture.trigger.action.event_seq_after_capture = 6;
  const missingCodes = validateEvalSemantics({ captures: [capture], events, allow_partial_bundle: true }).map(({ code }) => code);
  assert.ok(missingCodes.includes("capture.cutoff_missing"));
  assert.ok(missingCodes.includes("capture.cutoff_future"));
});

test("semantic validator accepts cancellation after pause and before capture", () => {
  const result = structuredClone(releasedResult);
  result.capture_ids = [];
  result.gate.release_reason = "cancelled";
  result.gate.observations = [
    { ordinal: 1, phase: "gate_armed" },
    { ordinal: 2, phase: "gate_paused" },
    { ordinal: 3, phase: "gate_released" },
  ];
  assert.deepEqual(validateEvalSemantics({ action_results: [result], events }), []);
});

test("semantic validator rejects captures outside the paused gate window", () => {
  const afterRelease = structuredClone(releasedResult);
  afterRelease.gate.release_reason = "cancelled";
  afterRelease.gate.observations = [
    { ordinal: 1, phase: "gate_armed" },
    { ordinal: 2, phase: "gate_paused" },
    { ordinal: 3, phase: "gate_released" },
    { ordinal: 4, phase: "capture_started", capture_id: liveCapture.capture_id },
  ];
  let codes = validateEvalSemantics({ action_results: [afterRelease], captures: [liveCapture], events })
    .map(({ code }) => code);
  assert.ok(codes.includes("gate.lifecycle"));
  assert.ok(codes.includes("gate.capture_order"));

  const withoutPause = structuredClone(releasedResult);
  withoutPause.gate.status = "not_reached";
  withoutPause.gate.release_reason = "runner_error";
  withoutPause.gate.observations = [
    { ordinal: 1, phase: "gate_armed" },
    { ordinal: 2, phase: "capture_started", capture_id: liveCapture.capture_id },
    { ordinal: 3, phase: "capture_finished", capture_id: liveCapture.capture_id },
  ];
  codes = validateEvalSemantics({ action_results: [withoutPause], captures: [liveCapture], events })
    .map(({ code }) => code);
  assert.ok(codes.includes("gate.lifecycle"));
  assert.ok(codes.includes("gate.capture_order"));
  assert.ok(codes.includes("gate.release_reason"));
});

test("semantic validator rejects incomplete or interleaved capture pairs", () => {
  const incomplete = structuredClone(releasedResult);
  incomplete.gate.release_reason = "cancelled";
  incomplete.gate.observations.splice(3, 1);
  incomplete.gate.observations[3].ordinal = 4;
  let codes = validateEvalSemantics({ action_results: [incomplete], captures: [liveCapture], events })
    .map(({ code }) => code);
  assert.ok(codes.includes("gate.capture_order"));

  const interleaved = structuredClone(releasedResult);
  const secondId = "human-edit/nominal@second-during";
  const secondCapture = structuredClone(liveCapture);
  secondCapture.capture_id = secondId;
  interleaved.capture_ids.push(secondId);
  interleaved.gate.observations = [
    { ordinal: 1, phase: "gate_armed" },
    { ordinal: 2, phase: "gate_paused" },
    { ordinal: 3, phase: "capture_started", capture_id: liveCapture.capture_id },
    { ordinal: 4, phase: "capture_started", capture_id: secondId },
    { ordinal: 5, phase: "capture_finished", capture_id: liveCapture.capture_id },
    { ordinal: 6, phase: "capture_finished", capture_id: secondId },
    { ordinal: 7, phase: "gate_released" },
  ];
  codes = validateEvalSemantics({ action_results: [interleaved], captures: [liveCapture, secondCapture], events })
    .map(({ code }) => code);
  assert.ok(codes.includes("gate.capture_order"));
});

test("failed capture may retain partial renderer evidence", () => {
  const capture = structuredClone(liveCapture);
  capture.status = "blocked";
  capture.trigger.action.event_seq_after_capture = 5;
  capture.state.events_through_seq = 5;
  capture.evidence.stability.renderer_seq = 5;
  assert.deepEqual(validateEvalSemantics({ captures: [capture], events, allow_partial_bundle: true }), []);
});

test("paused gate preserves completed and interrupted capture prefixes", () => {
  const completed = structuredClone(releasedResult);
  completed.gate.status = "paused";
  delete completed.gate.release_reason;
  completed.gate.observations.pop();
  assert.deepEqual(validateEvalSemantics({ action_results: [completed], captures: [liveCapture], events }), []);

  const interrupted = structuredClone(completed);
  interrupted.capture_ids = [];
  interrupted.gate.observations.pop();
  assert.deepEqual(validateEvalSemantics({ action_results: [interrupted], events }), []);

  interrupted.capture_ids = [liveCapture.capture_id];
  assert.deepEqual(validateEvalSemantics({ action_results: [interrupted], captures: [liveCapture], events }), []);

  interrupted.capture_ids = [];
  const codes = validateEvalSemantics({ action_results: [interrupted], captures: [liveCapture], events })
    .map(({ code }) => code);
  assert.ok(codes.includes("capture.action_reference"));
  assert.ok(codes.includes("gate.capture_reference"));
});

test("paused gate rejects malformed capture prefixes", () => {
  const result = structuredClone(releasedResult);
  result.gate.status = "paused";
  delete result.gate.release_reason;
  result.gate.observations = [
    { ordinal: 1, phase: "gate_armed" },
    { ordinal: 2, phase: "gate_paused" },
    { ordinal: 3, phase: "capture_finished", capture_id: liveCapture.capture_id },
  ];
  const codes = validateEvalSemantics({ action_results: [result], captures: [liveCapture], events })
    .map(({ code }) => code);
  assert.ok(codes.includes("gate.capture_order"));
});

test("semantic validator closes action capture references", () => {
  const missing = structuredClone(releasedResult);
  missing.gate = undefined;
  missing.capture_ids = ["human-edit/nominal@missing-after"];
  let codes = validateEvalSemantics({ action_results: [missing] }).map(({ code }) => code);
  assert.ok(codes.includes("action.capture_reference"));

  const wrongOwner = structuredClone(liveCapture);
  wrongOwner.trigger.action.action_id = "other-action";
  const noGate = structuredClone(releasedResult);
  noGate.gate = undefined;
  codes = validateEvalSemantics({ action_results: [noGate], captures: [wrongOwner], events })
    .map(({ code }) => code);
  assert.ok(codes.includes("action.capture_subject"));

  const orphanDuring = structuredClone(releasedResult);
  orphanDuring.gate.status = "paused";
  delete orphanDuring.gate.release_reason;
  orphanDuring.gate.observations = [
    { ordinal: 1, phase: "gate_armed" },
    { ordinal: 2, phase: "gate_paused" },
  ];
  orphanDuring.capture_ids = [];
  codes = validateEvalSemantics({ action_results: [orphanDuring], captures: [liveCapture], events })
    .map(({ code }) => code);
  assert.ok(codes.includes("capture.action_reference"));

  const missingGate = structuredClone(releasedResult);
  delete missingGate.gate;
  codes = validateEvalSemantics({ action_results: [missingGate], captures: [liveCapture], events })
    .map(({ code }) => code);
  assert.ok(codes.includes("capture.gate_reference"));

  codes = validateEvalSemantics({
    captures: [liveCapture, structuredClone(liveCapture)],
    events,
    allow_partial_bundle: true,
  })
    .map(({ code }) => code);
  assert.ok(codes.includes("capture.id_duplicate"));

  codes = validateEvalSemantics({ captures: [liveCapture], events }).map(({ code }) => code);
  assert.ok(codes.includes("capture.action_reference"));

  codes = validateEvalSemantics({
    action_results: [releasedResult, structuredClone(releasedResult)],
    captures: [liveCapture],
    events,
  }).map(({ code }) => code);
  assert.ok(codes.includes("action.id_duplicate"));
});
