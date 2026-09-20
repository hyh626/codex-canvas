import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runEngine } from "../engine.mjs";
import { createGateway } from "../gateway.mjs";
import { Store, hash, stable } from "../store.mjs";

// Exact expectations: model quality must never be inferred from schema validity alone.
export function expectedEdit(snapshot, title) {
  const expected = structuredClone(snapshot);
  expected.components.find((c) => c.id === "welcome").title = title;
  return expected;
}
export function checkAudit(store, from) {
  const events = store.events.slice(from);
  const requests = events.filter((e) => e.type === "model.request_prepared");
  assert.ok(requests.length > 0, "No audited model request");
  for (const event of requests) {
    const rebuilt = store.rebuild(event.payload.plan);
    assert.equal(event.payload.verification.assert, true);
    assert.equal(
      hash(stable(rebuilt)),
      event.payload.verification.request_hash,
    );
    assert.equal(
      event.payload.body,
      undefined,
      "Live CUJ capture must remain off",
    );
    assert.ok(
      events.some(
        (e) =>
          e.type === "model.response_received" &&
          e.payload.request_id === event.event_id,
      ),
      "Request lacks complete response",
    );
  }
  assert.equal(
    events.some(
      (e) =>
        e.type === "model.request_failed" ||
        e.type === "model.request_rejected",
    ),
    false,
    "Run contains failed/rejected model attempts",
  );
  return requests.length;
}

export async function liveCUJ({
  engine,
  command,
  model,
  endpoint,
  apiKey,
  directory,
}) {
  fs.mkdirSync(directory, { recursive: false });
  const report = {
    format: "canvas-live-cuj/v1",
    engine,
    model,
    runtime: command,
    node: process.version,
    platform: process.platform,
    startedAt: new Date().toISOString(),
    realRuntime: true,
    providerMode: "configured-endpoint",
    status: "running",
    cases: [],
  };
  const store = new Store(path.join(directory, "session"));
  let gateway;
  try {
    gateway = await createGateway(store, {
      endpoint,
      apiKey,
      protocol: engine === "codex" ? "responses" : "chat-completions",
      capture: false,
    });
    // Two separate turns, identical for both engines. Provider/runtime retries may add HTTP requests.
    for (const [index, title] of [
      "Start your project",
      "Build together",
    ].entries()) {
      const item = {
        id: index === 0 ? "human-edit-preservation" : "comment-driven-edit",
        status: "running",
      };
      report.cases.push(item);
      const human = structuredClone(store.state);
      human.components[0].body =
        "Human-authored body: keep this exact text. 中文。";
      store.commit({
        state: human,
        baseRevision: store.revision,
        commandId: `human-${index}`,
      });
      const comment = store.append(
        "comment.created",
        {
          component_id: "welcome",
          node_id: "title",
          revision: store.revision,
          text: `Set the title to exactly: ${title}`,
        },
        "human",
      );
      const baseRevision = store.revision;
      const snapshot = structuredClone(store.state);
      const lastChange = store.events
        .filter((e) => e.type === "workspace.edit_committed")
        .at(-1);
      const start = store.events.length;
      const result = await runEngine(
        engine,
        {
          snapshot,
          baseRevision,
          selectedComponent: "welcome",
          instruction:
            index === 0
              ? `Change only welcome.title to exactly "${title}". Preserve all other fields and IDs.`
              : "Apply the latest comment on welcome.title. Preserve every other field, component and ID exactly.",
          recentComments: [comment.payload],
          recentChanges: [
            {
              revision: baseRevision,
              changes: store.get(lastChange.payload.delta),
            },
          ],
        },
        (type, payload) => store.append(type, { ref: store.put(payload) }),
        { command, model, gateway, timeout: 120000 },
      );
      item.requests = checkAudit(store, start);
      assert.deepEqual(
        result.proposal,
        expectedEdit(snapshot, title),
        "Model changed the wrong content or failed to apply instruction",
      );
      store.commit({
        state: result.proposal,
        baseRevision: result.baseRevision,
        commandId: `agent-${index}`,
        actor: "agent",
      });
      store.history("undo", store.revision, `undo-${index}`);
      assert.deepEqual(store.state, snapshot);
      store.history("redo", store.revision, `redo-${index}`);
      assert.deepEqual(store.state, result.proposal);
      // Reusing this model result after newer commits must never overwrite current state.
      const current = structuredClone(store.state);
      assert.throws(
        () =>
          store.commit({
            state: result.proposal,
            baseRevision: result.baseRevision,
            commandId: `stale-${index}`,
            actor: "agent",
          }),
        /Revision conflict/,
      );
      assert.deepEqual(store.state, current);
      item.status = "passed";
    }
    const archive = store.export();
    store.close();
    const recovered = new Store(path.join(directory, "session"));
    try {
      assert.deepEqual(recovered.export(), archive);
    } finally {
      recovered.close();
    }
    report.replay = "passed";
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    const active = report.cases.find((c) => c.status === "running");
    if (active) active.status = "failed";
    // Detailed request/response evidence is local in the session. Don't copy raw provider errors into the summary.
    report.failure = {
      code:
        error.code === "ERR_ASSERTION"
          ? "ACCEPTANCE_FAILED"
          : ["TIMEOUT", "CANCELLED"].includes(error.code)
            ? error.code
            : "RUNTIME_OR_PROVIDER_FAILED",
      detail: "Inspect the local session events for diagnostic evidence.",
    };
  } finally {
    gateway?.close();
    store.close();
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(
      path.join(directory, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
    );
  }
  return report;
}
