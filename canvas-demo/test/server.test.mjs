import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server.mjs";
test("HTTP editing/comment/agent loop, strict Codex gate and CSRF checks", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-http-"));
  const app = createApp({ dir, allowCodex: false });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const initial = await (await fetch(url + "/api/state")).json();
  const post = (route, body, token = initial.token) =>
    fetch(url + "/api/" + route, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Canvas-Token": token },
      body: JSON.stringify(body),
    });
  assert.equal((await post("undo", {}, "wrong")).status, 403);
  assert.equal(
    (
      await fetch(url + "/api/state", {
        headers: { Origin: "https://evil.example" },
      })
    ).status,
    403,
  );
  const state = structuredClone(initial.state);
  state.components[0].title = "From UI";
  assert.equal(
    (await post("edit", { state, baseRevision: 0, commandId: "human" })).status,
    200,
  );
  assert.equal(
    (
      await post("comment", {
        text: "Make it green",
        componentId: "welcome",
        nodeId: "title",
        baseRevision: 1,
      })
    ).status,
    200,
  );
  const response = await post("agent", {
    prompt: "change color",
    engine: "mock",
    componentId: "welcome",
    baseRevision: 1,
    commandId: "agent",
  });
  assert.equal(response.status, 200);
  const next = await response.json();
  assert.equal(next.revision, 2);
  assert.equal(next.state.components[0].title, "From UI");
  assert.equal(next.state.components[0].color, "#0d9488");
  const commitEvent = next.events.find(
    (e) => e.type === "workspace.edit_committed",
  );
  const detail = await (
    await fetch(url + "/api/event/" + commitEvent.event_id)
  ).json();
  assert.deepEqual(detail.changes, [
    {
      component_id: "welcome",
      node_id: "title",
      before: "Build something together.",
      after: "From UI",
    },
  ]);
  const request = next.events.find((e) => e.type === "model.request_prepared");
  assert.deepEqual(
    app.store.rebuild(request.payload.plan).input[0].content.recentChanges[0]
      .changes,
    detail.changes,
  );
  assert.equal(
    app.store.rebuild(request.payload.plan).input[0].content.recentComments[0]
      .text,
    "Make it green",
  );
  assert.equal(
    (await post("agent", { prompt: "color", engine: "codex", baseRevision: 2 }))
      .status,
    422,
  );
  assert.equal(
    (await post("edit", { state, baseRevision: 0, commandId: "stale" })).status,
    409,
  );
  const undo = await (
    await post("undo", { baseRevision: 2, commandId: "undo" })
  ).json();
  assert.deepEqual(undo.state, state);
  const exported = await (await fetch(url + "/api/export")).json();
  assert.deepEqual(exported, app.store.export());
});
