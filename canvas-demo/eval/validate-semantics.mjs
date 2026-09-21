const add = (errors, code, message, subject = {}) =>
  errors.push({ code, message, subject });

const positions = (observations, phase) =>
  observations
    .map((observation, index) => ({ observation, index }))
    .filter(({ observation }) => observation.phase === phase);

function validateActionCaptures(result, capturesById, errors) {
  for (const captureId of result.capture_ids ?? []) {
    const capture = capturesById.get(captureId);
    if (!capture) {
      add(errors, "action.capture_reference", "Every action capture_id must reference a persisted capture outcome.", {
        action_id: result.action_id,
        capture_id: captureId,
      });
    } else if (
      capture.mode !== "live_checkpoint" ||
      capture.trigger?.action?.action_id !== result.action_id
    ) {
      add(errors, "action.capture_subject", "An action result may reference only its own live checkpoint captures.", {
        action_id: result.action_id,
        capture_id: captureId,
      });
    }
  }
}

function validateLiveCaptureOwners(captures, actionResultsById, allowPartialBundle, errors) {
  if (allowPartialBundle) return;
  for (const capture of captures) {
    if (capture.mode !== "live_checkpoint") continue;
    const actionId = capture.trigger?.action?.action_id;
    const result = actionResultsById.get(actionId);
    if (!result || !result.capture_ids?.includes(capture.capture_id)) {
      add(errors, "capture.action_reference", "Every live capture outcome must be referenced by its owning action result.", {
        action_id: actionId,
        capture_id: capture.capture_id,
      });
      continue;
    }
    if (capture.trigger.action.phase === "during" && !result.gate)
      add(errors, "capture.gate_reference", "A during capture outcome requires gate lifecycle observations on its owning action result.", {
        action_id: actionId,
        capture_id: capture.capture_id,
      });
  }
}

function validateGate(result, capturesById, errors) {
  const gate = result.gate;
  if (!gate) return;
  const observations = gate.observations ?? [];
  for (let index = 0; index < observations.length; index++) {
    const expected = index === 0 ? 1 : observations[index - 1].ordinal + 1;
    if (observations[index].ordinal !== expected)
      add(errors, "gate.ordinal", "Gate ordinals must be contiguous and strictly increasing.", {
        action_id: result.action_id,
        ordinal: observations[index].ordinal,
      });
  }

  const armed = positions(observations, "gate_armed");
  const paused = positions(observations, "gate_paused");
  const released = positions(observations, "gate_released");
  const releaseFailed = positions(observations, "gate_release_failed");
  if (gate.status !== "released" && gate.release_reason !== undefined)
    add(errors, "gate.release_reason", "release_reason is valid only when the gate status is released.", { action_id: result.action_id });
  if (armed.length !== 1)
    add(errors, "gate.armed", "A gate result must contain exactly one gate_armed observation.", { action_id: result.action_id });
  if (gate.status === "not_reached" && (paused.length || released.length || releaseFailed.length))
    add(errors, "gate.not_reached", "A gate that was not reached cannot be paused or released.", { action_id: result.action_id });
  if (["paused", "released", "release_failed"].includes(gate.status) && paused.length !== 1)
    add(errors, "gate.paused", "This gate status requires exactly one gate_paused observation.", { action_id: result.action_id });
  if (gate.status === "released" && released.length !== 1)
    add(errors, "gate.released", "A released gate must contain exactly one gate_released observation.", { action_id: result.action_id });
  if (gate.status === "released" && releaseFailed.length)
    add(errors, "gate.terminal", "A released gate cannot also contain gate_release_failed.", { action_id: result.action_id });
  if (gate.status === "release_failed" && releaseFailed.length !== 1)
    add(errors, "gate.release_failed", "A failed release must contain exactly one gate_release_failed observation.", { action_id: result.action_id });
  if (gate.status === "release_failed" && released.length)
    add(errors, "gate.terminal", "A failed release cannot also contain gate_released.", { action_id: result.action_id });
  if (gate.status === "paused" && (released.length || releaseFailed.length))
    add(errors, "gate.terminal", "A paused gate cannot contain a terminal gate observation.", { action_id: result.action_id });

  if (armed[0] && paused[0] && armed[0].index >= paused[0].index)
    add(errors, "gate.order", "gate_armed must precede gate_paused.", { action_id: result.action_id });
  const terminal = released[0] ?? releaseFailed[0];
  if (paused[0] && terminal && paused[0].index >= terminal.index)
    add(errors, "gate.order", "gate_paused must precede the terminal gate observation.", { action_id: result.action_id });

  const expectedTerminal = gate.status === "released"
    ? "gate_released"
    : gate.status === "release_failed"
      ? "gate_release_failed"
      : null;
  if (observations[0]?.phase !== "gate_armed")
    add(errors, "gate.lifecycle", "gate_armed must be the first gate observation.", { action_id: result.action_id });
  if (gate.status === "not_reached" && observations.length !== 1)
    add(errors, "gate.lifecycle", "A gate that was not reached must contain only gate_armed.", { action_id: result.action_id });
  if (["paused", "released", "release_failed"].includes(gate.status) && observations[1]?.phase !== "gate_paused")
    add(errors, "gate.lifecycle", "gate_paused must immediately follow gate_armed.", { action_id: result.action_id });
  if (expectedTerminal && observations.at(-1)?.phase !== expectedTerminal)
    add(errors, "gate.lifecycle", "The terminal gate observation must be last.", { action_id: result.action_id });
  if (expectedTerminal && observations.at(-1)?.phase === expectedTerminal) {
    const captureObservations = observations.slice(2, -1);
    for (let index = 0; index < captureObservations.length; index += 2) {
      const start = captureObservations[index];
      const finish = captureObservations[index + 1];
      if (
        start?.phase !== "capture_started" ||
        finish?.phase !== "capture_finished" ||
        start.capture_id !== finish.capture_id
      )
        add(errors, "gate.capture_order", "Capture observations between pause and terminal must be adjacent start/finish pairs with the same capture ID.", { action_id: result.action_id });
    }
  }
  if (gate.status === "paused") {
    const captureObservations = observations.slice(2);
    for (let index = 0; index < captureObservations.length; index += 2) {
      const start = captureObservations[index];
      const finish = captureObservations[index + 1];
      const isInterruptedStart = finish === undefined && index === captureObservations.length - 1;
      if (
        start?.phase !== "capture_started" ||
        (!isInterruptedStart && (
          finish?.phase !== "capture_finished" ||
          start.capture_id !== finish.capture_id
        ))
      )
        add(errors, "gate.capture_order", "A paused gate may contain completed start/finish pairs followed by at most one interrupted capture_started.", { action_id: result.action_id });
    }
  }

  const finishedCaptureIds = new Set(positions(observations, "capture_finished").map(({ observation }) => observation.capture_id));
  const started = new Map();
  for (const { observation, index } of positions(observations, "capture_started")) {
    if (started.has(observation.capture_id))
      add(errors, "gate.capture_duplicate", "A capture can start only once.", { capture_id: observation.capture_id });
    else started.set(observation.capture_id, index);
    if (!paused[0] || index <= paused[0].index || (terminal && index >= terminal.index))
      add(errors, "gate.capture_order", "A capture must start after gate_paused and before the terminal gate observation.", { capture_id: observation.capture_id });
    const capture = capturesById.get(observation.capture_id);
    if (finishedCaptureIds.has(observation.capture_id)) {
      if (!result.capture_ids.includes(observation.capture_id) || !capture)
        add(errors, "gate.capture_reference", "A completed gate capture must reference a persisted action capture.", { capture_id: observation.capture_id });
      else if (
        capture.mode !== "live_checkpoint" ||
        capture.trigger?.action?.action_id !== result.action_id ||
        capture.trigger?.action?.phase !== "during"
      )
        add(errors, "gate.capture_subject", "A gate capture must be the same action's during live checkpoint.", { capture_id: observation.capture_id });
    } else if (capture) {
      if (!result.capture_ids.includes(observation.capture_id))
        add(errors, "gate.capture_reference", "A persisted interrupted capture outcome must be referenced by the action result.", { capture_id: observation.capture_id });
      else if (
        capture.mode !== "live_checkpoint" ||
        capture.trigger?.action?.action_id !== result.action_id ||
        capture.trigger?.action?.phase !== "during"
      )
        add(errors, "gate.capture_subject", "A gate capture must be the same action's during live checkpoint.", { capture_id: observation.capture_id });
    }
  }
  const finished = new Map();
  for (const { observation, index } of positions(observations, "capture_finished")) {
    if (finished.has(observation.capture_id))
      add(errors, "gate.capture_duplicate", "A capture can finish only once.", { capture_id: observation.capture_id });
    else finished.set(observation.capture_id, index);
    const start = started.get(observation.capture_id);
    if (start === undefined || start >= index)
      add(errors, "gate.capture_order", "capture_started must precede capture_finished.", { capture_id: observation.capture_id });
    if (!paused[0] || index <= paused[0].index || (terminal && index >= terminal.index))
      add(errors, "gate.capture_order", "A capture must finish after gate_paused and before the terminal gate observation.", { capture_id: observation.capture_id });
  }
  for (const [captureId] of started) {
    if (!finished.has(captureId) && gate.status !== "paused")
      add(errors, "gate.capture_order", "Every capture_started must have a matching capture_finished before the gate terminates.", { capture_id: captureId });
  }
  for (const [captureId] of finished) {
    if (!started.has(captureId))
      add(errors, "gate.capture_order", "Every capture_finished must have a matching capture_started.", { capture_id: captureId });
  }
  for (const captureId of result.capture_ids) {
    const capture = capturesById.get(captureId);
    if (
      capture?.mode === "live_checkpoint" &&
      capture.trigger?.action?.action_id === result.action_id &&
      capture.trigger?.action?.phase === "during" &&
      !finished.has(captureId) &&
      !(gate.status === "paused" && started.has(captureId))
    )
      add(errors, "gate.capture_reference", "A persisted during capture must have a completed gate observation pair.", { capture_id: captureId });
  }
  if (["captured", "capture_timeout"].includes(gate.release_reason) && finished.size === 0)
    add(errors, "gate.capture_required", "This release reason requires a completed capture attempt.", { action_id: result.action_id });
  const finishedCaptures = [...finished.keys()].map((id) => capturesById.get(id)).filter(Boolean);
  if (gate.release_reason === "captured" && !finishedCaptures.some((capture) => capture.status === "ok"))
    add(errors, "gate.release_reason", "release_reason captured requires a successful capture outcome.", { action_id: result.action_id });
  if (gate.release_reason === "capture_timeout" && !finishedCaptures.some((capture) => capture.status === "timeout"))
    add(errors, "gate.release_reason", "release_reason capture_timeout requires a timeout capture outcome.", { action_id: result.action_id });
}

function validateCapture(capture, eventSeqs, maxEventSeq, errors) {
  if (capture.mode !== "live_checkpoint") return;
  const cutoff = capture.trigger.action.event_seq_at_capture;
  const cutoffAfter = capture.trigger.action.event_seq_after_capture;
  if (capture.status === "ok" && (!Number.isInteger(cutoff) || !Number.isInteger(cutoffAfter)))
    add(errors, "capture.cutoff_required", "A successful live capture requires authoritative cutoffs before and after capture.", { capture_id: capture.capture_id });
  if (
    Number.isInteger(cutoff) &&
    Number.isInteger(cutoffAfter) &&
    cutoff !== cutoffAfter &&
    capture.status !== "blocked"
  )
    add(errors, "capture.cutoff_changed", "A changing authoritative event tail requires a blocked capture outcome.", { capture_id: capture.capture_id, before: cutoff, after: cutoffAfter });
  if (Number.isInteger(cutoff) && Number.isInteger(cutoffAfter) && cutoffAfter < cutoff)
    add(errors, "capture.cutoff_regressed", "The authoritative event tail cannot move backwards during capture.", { capture_id: capture.capture_id, before: cutoff, after: cutoffAfter });
  for (const [field, value] of [
    ["event_seq_at_capture", cutoff],
    ["event_seq_after_capture", cutoffAfter],
  ]) {
    if (Number.isInteger(value) && value !== 0 && !eventSeqs.has(value))
      add(errors, "capture.cutoff_missing", "An authoritative event cutoff must identify a persisted event.", { capture_id: capture.capture_id, field, cutoff: value });
    if (Number.isInteger(value) && value > maxEventSeq)
      add(errors, "capture.cutoff_future", "A live capture cutoff cannot exceed the trajectory tail.", { capture_id: capture.capture_id, field, cutoff: value });
  }

  const rendererSeq = capture.evidence?.stability?.renderer_seq;
  if (capture.status === "ok" && Number.isInteger(rendererSeq) && Number.isInteger(cutoff) && rendererSeq > cutoff)
    add(errors, "capture.renderer_future", "Renderer seq cannot exceed the authoritative event cutoff.", { capture_id: capture.capture_id, renderer_seq: rendererSeq, cutoff });
  const modelSeq = capture.state?.events_through_seq;
  if (capture.status === "ok" && Number.isInteger(modelSeq) && Number.isInteger(rendererSeq) && modelSeq !== rendererSeq)
    add(errors, "capture.renderer_model_mismatch", "The captured model and renderer must describe the same applied event seq.", { capture_id: capture.capture_id, model_seq: modelSeq, renderer_seq: rendererSeq });
}

export function validateEvalSemantics({
  action_results = [],
  captures = [],
  events = [],
  allow_partial_bundle = false,
}) {
  const errors = [];
  const seenCaptureIds = new Set();
  for (const capture of captures) {
    if (seenCaptureIds.has(capture.capture_id))
      add(errors, "capture.id_duplicate", "capture_id must be unique within an eval bundle.", { capture_id: capture.capture_id });
    seenCaptureIds.add(capture.capture_id);
  }
  const capturesById = new Map(captures.map((capture) => [capture.capture_id, capture]));
  const actionResultsById = new Map();
  for (const result of action_results) {
    if (actionResultsById.has(result.action_id))
      add(errors, "action.id_duplicate", "action_id must be unique within action results.", { action_id: result.action_id });
    else actionResultsById.set(result.action_id, result);
  }
  const eventSeqs = new Set(events.map((event) => event.seq));
  const maxEventSeq = events.reduce((maximum, event) => Math.max(maximum, event.seq), 0);
  for (const result of action_results) {
    validateActionCaptures(result, capturesById, errors);
    validateGate(result, capturesById, errors);
  }
  validateLiveCaptureOwners(captures, actionResultsById, allow_partial_bundle, errors);
  for (const capture of captures) validateCapture(capture, eventSeqs, maxEventSeq, errors);
  return errors;
}

export function assertEvalSemantics(bundle) {
  const errors = validateEvalSemantics(bundle);
  if (errors.length) {
    const error = new Error(`Eval semantic validation failed with ${errors.length} error(s).`);
    error.errors = errors;
    throw error;
  }
}
