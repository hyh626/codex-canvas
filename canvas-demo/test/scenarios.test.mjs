import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createApp } from "../server.mjs";
import {
  scenarioById,
  scenarioProgress,
  scenarios,
} from "../scenarios.mjs";

test("CUJ playground loads audited fixtures and scopes agent context", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-scenarios-"));
  const app = createApp({ dir });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  const initial = await (await fetch(url + "/api/state")).json();
  const post = (route, body) =>
    fetch(url + "/api/" + route, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Canvas-Token": initial.token,
      },
      body: JSON.stringify(body),
    });

  assert.equal(
    (
      await post("comment", {
        componentId: "welcome",
        nodeId: "title",
        text: "Old scenario feedback",
        baseRevision: 0,
      })
    ).status,
    200,
  );
  const loadRequest = {
    scenarioId: "comment-agent",
    baseRevision: 0,
    commandId: "load-comment-agent",
  };
  const loadedResponse = await post("scenario", loadRequest);
  assert.equal(loadedResponse.status, 200);
  const loaded = await loadedResponse.json();
  assert.deepEqual(loaded.state, scenarioById.get("comment-agent").fixture);
  assert.equal(loaded.selectedComponentId, "welcome");
  const started = loaded.events.find((event) => event.type === "scenario.started");
  const fixtureCommit = loaded.events.find(
    (event) => event.payload.intent?.operation === "load_scenario",
  );
  assert.deepEqual(fixtureCommit.caused_by, [started.event_id]);

  assert.equal(
    (
      await post("comment", {
        componentId: "welcome",
        nodeId: "title",
        text: "标题：Build together",
        baseRevision: 1,
      })
    ).status,
    200,
  );
  const agentResponse = await post("agent", {
    prompt: "标题：Build together",
    engine: "mock",
    componentId: "welcome",
    baseRevision: 1,
    commandId: "scenario-agent",
  });
  assert.equal(agentResponse.status, 200);
  const completed = await agentResponse.json();
  assert.equal(completed.state.components[0].title, "Build together");
  assert.deepEqual(
    scenarioProgress(scenarioById.get("comment-agent"), completed).steps.map(
      (step) => step.done,
    ),
    [true, true],
  );

  const request = completed.events.find(
    (event) =>
      event.type === "model.request_prepared" && event.seq > started.seq,
  );
  const context = app.store.rebuild(request.payload.plan).input[0].content;
  assert.deepEqual(
    context.recentComments.map((comment) => comment.text),
    ["标题：Build together"],
  );
  assert.deepEqual(context.recentChanges, []);

  assert.equal((await post("scenario", loadRequest)).status, 200);
  assert.equal(
    app.store.events.filter((event) => event.type === "scenario.started").length,
    1,
  );
  assert.equal(
    (await fetch(url + "/scenarios.js")).headers.get("content-type"),
    "text/javascript",
  );
});

test(
  "all built-in CUJ fixtures are unique and valid through the public API",
  async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-scenario-list-"));
    const app = createApp({ dir });
    await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    t.after(() => {
      app.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const url = `http://127.0.0.1:${app.server.address().port}`;
    const initial = await (await fetch(url + "/api/state")).json();
    let revision = initial.revision;
    for (const scenario of scenarios) {
      const response = await fetch(url + "/api/scenario", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Canvas-Token": initial.token,
        },
        body: JSON.stringify({
          scenarioId: scenario.id,
          baseRevision: revision,
          commandId: `load-${scenario.id}`,
        }),
      });
      assert.equal(response.status, 200, scenario.id);
      const loaded = await response.json();
      assert.deepEqual(loaded.state, scenario.fixture, scenario.id);
      revision = loaded.revision;
    }
    assert.equal(
      new Set(scenarios.map((scenario) => scenario.id)).size,
      scenarios.length,
    );
  },
);
