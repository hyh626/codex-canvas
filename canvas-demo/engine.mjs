import { randomUUID } from "node:crypto";
import { codexProposal } from "./codex.mjs";
import { dshProposal } from "./dsh.mjs";
import { validate } from "./store.mjs";

export const engineCapabilities = Object.freeze({
  codex: {
    protocol: "canvas-engine/v1",
    mode: "proposal",
    wire: "responses",
    tools: false,
    resume: false,
    steer: false,
  },
  dsh: {
    protocol: "canvas-engine/v1",
    mode: "proposal",
    wire: "chat-completions",
    tools: false,
    resume: false,
    steer: false,
  },
});

// Product contract. Native messages remain opaque evidence, never UI state mutations.
export async function runEngine(engine, input, record, options = {}) {
  if (!engineCapabilities[engine]) throw Error("Unsupported engine");
  if (
    !Number.isSafeInteger(input.baseRevision) ||
    input.baseRevision < 0 ||
    typeof input.instruction !== "string"
  )
    throw Error("Invalid engine input");
  validate(input.snapshot);
  if (!input.snapshot.components.some((c) => c.id === input.selectedComponent))
    throw Error("Select a component");
  if (Buffer.byteLength(JSON.stringify(input)) > 8000)
    throw Error("Engine input exceeds 8 KB");
  const runId = randomUUID();
  const emit = (type, payload) =>
    record(type, { protocol: "canvas-engine/v1", runId, engine, ...payload });
  emit("engine.started", {
    baseRevision: input.baseRevision,
    capabilities: engineCapabilities[engine],
  });
  try {
    const proposal = await { codex: codexProposal, dsh: dshProposal }[engine](
      structuredClone(input),
      (type, payload) => emit("engine.native", { nativeType: type, payload }),
      options,
    );
    options.signal?.throwIfAborted();
    const state = validate(proposal);
    const result = {
      protocol: "canvas-engine/v1",
      runId,
      engine,
      baseRevision: input.baseRevision,
      proposal: state,
    };
    emit("engine.completed", { baseRevision: input.baseRevision });
    return result;
  } catch (error) {
    const code =
      error.code === "CANCELLED" || options.signal?.aborted
        ? "CANCELLED"
        : error.code === "TIMEOUT"
          ? "TIMEOUT"
          : "ENGINE_FAILED";
    emit("engine.failed", { code, message: error.message });
    throw Object.assign(error, { code, runId });
  }
}
