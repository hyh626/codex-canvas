import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { createApp } from "../server.mjs";
import { runEngine } from "../engine.mjs";
import { initial, Store } from "../store.mjs";
import { createGateway } from "../gateway.mjs";
const fixture = fileURLToPath(new URL("./fake-engine.mjs", import.meta.url));
const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
for (const engine of ["codex", "dsh"]) {
  test(`${engine}: shared HTTP CUJs, audit, undo, conflict and invalid proposal (wire fixture)`, async (t) => {
    const requests = [];
    let hold, entered;
    const provider = http.createServer(async (req, res) => {
      let body = "";
      for await (const chunk of req) body += chunk;
      requests.push(JSON.parse(body));
      if (hold) {
        entered();
        await hold;
      }
      res.end("{}");
    });
    await listen(provider);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-engine-"));
    const app = createApp({
      dir,
      allowCodex: true,
      allowDsh: true,
      engineOptions: {
        [engine]: {
          command: process.execPath,
          args: [fixture, engine],
          model: "fixture",
          timeout: 5000,
          endpoint: `http://127.0.0.1:${provider.address().port}/${engine === "codex" ? "responses" : "chat/completions"}`,
          apiKey: "test-only",
        },
      },
    });
    await listen(app.server);
    t.after(() => {
      app.close();
      provider.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const url = `http://127.0.0.1:${app.server.address().port}`;
    const { token } = await (await fetch(url + "/api/state")).json();
    const post = async (route, data = {}) => {
      const res = await fetch(url + "/api/" + route, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-canvas-token": token,
        },
        body: JSON.stringify({
          commandId: randomUUID(),
          baseRevision: app.store.revision,
          ...data,
        }),
      });
      return { status: res.status, body: await res.json() };
    };
    for (const operation of ["create", "duplicate", "move", "delete"]) {
      assert.equal(
        (
          await post("component", {
            operation,
            componentId: app.store.state.components.at(-1).id,
            direction: -1,
          })
        ).status,
        200,
      );
    }
    await post("component", {
      operation: "set_text",
      componentId: "welcome",
      nodeId: "body",
      text: "Human draft",
    });
    await post("comment", {
      componentId: "welcome",
      nodeId: "title",
      text: "Make this concise",
    });
    const before = structuredClone(app.store.state);
    const agent = (prompt) =>
      post("agent", { engine, componentId: "welcome", prompt });
    assert.equal((await agent("标题：After review")).status, 200);
    assert.equal(app.store.state.components[0].title, "After review");
    assert.equal(app.store.state.components[0].body, "Human draft");
    const sent = requests[0];
    const input = JSON.parse((sent.input ?? sent.messages)[0].content);
    assert.equal(input.recentComments.at(-1).text, "Make this concise");
    assert.ok(input.recentChanges.length);
    const prepared = app.store.events.find(
      (e) => e.type === "model.request_prepared",
    );
    assert.deepEqual(app.store.rebuild(prepared.payload.plan).body, sent);
    assert.equal(prepared.payload.verification.assert, true);
    assert.equal(prepared.payload.body, undefined);
    await post("undo");
    assert.deepEqual(app.store.state, before);
    await post("redo");
    assert.equal(app.store.state.components[0].title, "After review");
    const revision = app.store.revision;
    assert.equal((await agent("invalid")).status, 400);
    assert.equal(app.store.revision, revision);
    let release;
    hold = new Promise((resolve) => {
      release = resolve;
    });
    const arrival = new Promise((resolve) => {
      entered = resolve;
    });
    const pending = agent("stale result");
    await arrival;
    await post("component", {
      operation: "set_text",
      componentId: "welcome",
      nodeId: "title",
      text: "Human wins",
    });
    release();
    hold = null;
    assert.equal((await pending).status, 409);
    assert.equal(app.store.state.components[0].title, "Human wins");
    const archive = app.store.export();
    app.store.close();
    const restored = new Store(dir);
    assert.deepEqual(restored.export(), archive);
    restored.close();
  });
  test(`${engine}: deadline and cancellation reject without a proposal`, async () => {
    const input = {
      snapshot: initial,
      selectedComponent: "welcome",
      baseRevision: 0,
      instruction: "hang",
    };
    const options = {
      command: process.execPath,
      args: [fixture, engine],
      model: "fixture",
      gateway: { baseURL: "http://127.0.0.1:1", token: "fixture" },
      timeout: 150,
    };
    const events = [];
    await assert.rejects(
      runEngine(engine, input, (t, p) => events.push([t, p]), options),
      (e) => e.code === "TIMEOUT",
    );
    assert.equal(events.at(-1)[0], "engine.failed");
    const controller = new AbortController();
    const run = runEngine(engine, input, () => {}, {
      ...options,
      timeout: 5000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 100);
    await assert.rejects(run, (e) => e.code === "CANCELLED");
  });
}
test("Chat gateway rejects tools and verification mismatch before provider receives anything", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-chat-audit-"));
  const store = new Store(dir);
  let received = 0;
  const provider = http.createServer((req, res) => {
    received++;
    res.end("{}");
  });
  await listen(provider);
  const gateway = await createGateway(store, {
    endpoint: `http://127.0.0.1:${provider.address().port}/chat/completions`,
    apiKey: "fixture",
    protocol: "chat-completions",
  });
  t.after(() => {
    gateway.close();
    provider.close();
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const send = (body) =>
    fetch(gateway.baseURL + "/chat/completions", {
      method: "POST",
      headers: { authorization: `Bearer ${gateway.token}` },
      body: JSON.stringify(body),
    });
  assert.equal(
    (
      await send({
        messages: [{ role: "user", content: "hello" }],
        tools: [{}],
      })
    ).status,
    400,
  );
  store.rebuild = () => ({ wrong: true });
  assert.equal(
    (await send({ messages: [{ role: "user", content: "hello" }] })).status,
    400,
  );
  assert.equal(received, 0);
});
