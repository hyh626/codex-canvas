// Real runtime + deterministic local provider. No paid model and no credentials.
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { runEngine } from "../engine.mjs";
import { Store, initial } from "../store.mjs";
import { createGateway } from "../gateway.mjs";

const engine = process.argv[2];
const command = process.argv[3];
if (!["codex", "dsh"].includes(engine) || !command)
  throw Error(
    "Usage: node validation/runtime-smoke.mjs codex|dsh /absolute/runtime",
  );
const requests = [];
const proposal = structuredClone(initial);
proposal.components[0].title = "Real runtime protocol verified";
let receivedInput;
const provider = http.createServer(async (req, res) => {
  let raw = "";
  for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw);
  requests.push(body);
  const texts = (body.input ?? body.messages ?? []).flatMap((m) =>
    typeof m.content === "string"
      ? [m.content]
      : (m.content ?? []).map((b) => b.text).filter(Boolean),
  );
  receivedInput = texts
    .map((text) => {
      try {
        return JSON.parse(text);
      } catch {
        return null;
      }
    })
    .find((x) => x?.snapshot);
  if (!receivedInput) {
    res.writeHead(400);
    res.end("Missing Canvas input");
    return;
  }
  const output = structuredClone(receivedInput.snapshot);
  output.components[0].title = "Real runtime protocol verified";
  const answer = JSON.stringify(output);
  res.writeHead(200, { "content-type": "text/event-stream" });
  const emit = (type, data) =>
    res.write(
      `${engine === "codex" ? `event: ${type}\n` : ""}data: ${JSON.stringify(data)}\n\n`,
    );
  if (engine === "dsh") {
    const base = {
      id: "chat-smoke",
      object: "chat.completion.chunk",
      created: 1,
      model: body.model,
    };
    emit("", {
      ...base,
      choices: [
        {
          index: 0,
          delta: { role: "assistant", content: answer },
          finish_reason: null,
        },
      ],
    });
    emit("", {
      ...base,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    });
    res.end("data: [DONE]\n\n");
  } else {
    const item = {
      id: "msg-smoke",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: answer, annotations: [] }],
    };
    const response = {
      id: "resp-smoke",
      object: "response",
      created_at: 1,
      status: "completed",
      model: body.model,
      output: [item],
      usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
    };
    emit("response.created", {
      type: "response.created",
      response: { ...response, status: "in_progress", output: [] },
    });
    emit("response.output_item.added", {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...item, status: "in_progress", content: [] },
    });
    emit("response.content_part.added", {
      type: "response.content_part.added",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    });
    emit("response.output_text.delta", {
      type: "response.output_text.delta",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      delta: answer,
    });
    emit("response.output_text.done", {
      type: "response.output_text.done",
      item_id: item.id,
      output_index: 0,
      content_index: 0,
      text: answer,
    });
    emit("response.output_item.done", {
      type: "response.output_item.done",
      output_index: 0,
      item,
    });
    emit("response.completed", { type: "response.completed", response });
    res.end();
  }
});
await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-runtime-smoke-"));
const store = new Store(dir);
let gateway = await createGateway(store, {
  protocol: engine === "codex" ? "responses" : "chat-completions",
  endpoint: `http://127.0.0.1:${provider.address().port}/${engine === "codex" ? "responses" : "chat/completions"}`,
  apiKey: "local-smoke-only",
});
try {
  const result = await runEngine(
    engine,
    {
      snapshot: initial,
      baseRevision: 0,
      selectedComponent: "welcome",
      instruction: "Change the title to Real runtime protocol verified",
      recentChanges: [],
      recentComments: [],
    },
    (type, payload) => store.append(type, { ref: store.put(payload) }),
    {
      command,
      model: engine === "codex" ? "gpt-5" : "deepseek-v4-flash",
      gateway,
      timeout: 60000,
    },
  );
  assert.deepEqual(result.proposal, proposal);
  assert.ok(requests.length);
  const prepared = store.events.filter(
    (e) => e.type === "model.request_prepared",
  );
  assert.equal(prepared.length, requests.length);
  prepared.forEach((e, i) => {
    assert.deepEqual(store.rebuild(e.payload.plan).body, requests[i]);
    assert.equal(e.payload.verification.assert, true);
    assert.equal(e.payload.body, undefined);
  });
  store.commit({
    state: result.proposal,
    baseRevision: store.revision,
    commandId: "runtime-smoke",
    actor: "agent",
  });
  assert.deepEqual(store.state, proposal);
  store.history("undo", store.revision, "runtime-undo");
  assert.deepEqual(store.state, initial);
  store.history("redo", store.revision, "runtime-redo");
  assert.deepEqual(store.state, proposal);
  const human = structuredClone(store.state);
  human.components[0].body = "Keep my human edit";
  store.commit({
    state: human,
    baseRevision: store.revision,
    commandId: "human-edit",
  });
  gateway.close();
  gateway = await createGateway(store, {
    protocol: engine === "codex" ? "responses" : "chat-completions",
    endpoint: `http://127.0.0.1:${provider.address().port}/${engine === "codex" ? "responses" : "chat/completions"}`,
    apiKey: "local-smoke-only",
    capture: true,
  });
  const baseRevision = store.revision;
  const second = await runEngine(
    engine,
    {
      snapshot: human,
      baseRevision,
      selectedComponent: "welcome",
      instruction: "Keep the body; adjust title",
      recentChanges: [
        {
          revision: baseRevision,
          changes: [
            {
              component_id: "welcome",
              node_id: "body",
              after: human.components[0].body,
            },
          ],
        },
      ],
      recentComments: [
        { component_id: "welcome", node_id: "title", text: "Shorter please" },
      ],
    },
    (type, payload) => store.append(type, { ref: store.put(payload) }),
    {
      command,
      model: engine === "codex" ? "gpt-5" : "deepseek-v4-flash",
      gateway,
      timeout: 60000,
    },
  );
  assert.equal(second.proposal.components[0].body, "Keep my human edit");
  assert.equal(receivedInput.recentComments[0].text, "Shorter please");
  assert.equal(receivedInput.recentChanges[0].revision, baseRevision);
  const captured = store.events
    .filter((e) => e.type === "model.request_prepared")
    .at(-1);
  assert.deepEqual(
    store.get(captured.payload.body),
    store.rebuild(captured.payload.plan),
  );
  assert.deepEqual(store.rebuild(captured.payload.plan).body, requests.at(-1));
  const newer = structuredClone(human);
  newer.components[0].title = "Newer human title";
  store.commit({ state: newer, baseRevision, commandId: "newer-human-edit" });
  assert.throws(
    () =>
      store.commit({
        state: second.proposal,
        baseRevision: second.baseRevision,
        commandId: "stale-runtime",
      }),
    /Revision conflict/,
  );
  assert.deepEqual(store.state, newer);
  console.log(
    JSON.stringify({
      engine,
      status: "passed",
      realRuntime: true,
      realModel: false,
      requests: requests.length,
      assert: true,
      captureModes: [false, true],
      checks: [
        "proposal",
        "undo",
        "redo",
        "human-context",
        "comment-context",
        "stale-commit-rejected",
      ],
    }),
  );
} catch (error) {
  console.error(
    JSON.stringify({
      engine,
      status: "failed",
      error: error.message,
      events: store.events
        .slice(-5)
        .map((e) => ({
          type: e.type,
          payload: e.payload.ref ? store.get(e.payload.ref) : e.payload,
        })),
    }),
  );
  process.exitCode = 1;
} finally {
  gateway.close();
  provider.closeAllConnections();
  provider.close();
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
