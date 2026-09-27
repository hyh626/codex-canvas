import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server.mjs";

test("import waits for a running agent and invalid review mode stops before model request", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-server-hardening-"));
  let entered;
  let release;
  const paused = new Promise((resolve) => { entered = resolve; });
  const hold = new Promise((resolve) => { release = resolve; });
  const app = createApp({
    dir,
    evalHooks: { async beforeAgentCommit() { entered(); await hold; } },
  });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => { release(); app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const { token } = await (await fetch(`${url}/api/state`)).json();
  const post = (route, data) => fetch(`${url}/api/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Canvas-Token": token },
    body: JSON.stringify(data),
  });
  const invalid = await post("agent", { engine: "mock", prompt: "change color", componentId: "welcome", baseRevision: 0, commandId: "invalid-mode", reviewMode: "unknown" });
  assert.equal(invalid.status, 400);
  assert.equal(app.store.events.some((event) => event.type === "model.request_prepared"), false);

  const running = post("agent", { engine: "mock", prompt: "change color", componentId: "welcome", baseRevision: 0, commandId: "running-agent" });
  await paused;
  const archive = app.store.export();
  const importing = await post("import", { archive });
  assert.equal(importing.status, 409);
  assert.equal(app.store.revision, 0);
  release();
  assert.equal((await running).status, 200);
  assert.equal(app.store.revision, 1);
});

test("staged agent request retries return one durable proposal", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-stage-retry-"));
  const app = createApp({ dir });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => { app.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const { token } = await (await fetch(`${url}/api/state`)).json();
  const post = async (body) => {
    const response = await fetch(`${url}/api/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Canvas-Token": token },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const request = { engine: "mock", prompt: "change color", componentId: "welcome", baseRevision: 0, commandId: "stage-once", reviewMode: "stage" };
  const first = await post(request);
  const retry = await post(request);
  assert.equal(first.status, 200);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.proposalId, first.body.proposalId);
  assert.equal(app.store.events.filter((event) => event.type === "workspace.proposal_staged").length, 1);
  assert.equal(app.store.events.filter((event) => event.type === "model.request_prepared").length, 1);
  assert.equal((await post({ ...request, prompt: "different" })).status, 409);
  assert.equal((await post({ ...request, commandId: "another-stage" })).status, 409);
});
