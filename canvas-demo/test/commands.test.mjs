import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../store.mjs";
import { componentCommand } from "../commands.mjs";
import { createApp } from "../server.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-cuj-"));
  const store = new Store(dir);
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const run = (data) =>
    componentCommand(store, {
      baseRevision: store.revision,
      commandId: randomUUID(),
      ...data,
    });
  return { dir, store, run };
}

test("CUJ: create, duplicate, directly edit, reorder, delete, undo and redo over HTTP", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-cuj-http-"));
  const app = createApp({ dir, allowCodex: false });
  await new Promise((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${app.server.address().port}`;
  let view = await (await fetch(url + "/api/state")).json();
  const token = view.token;
  const post = async (route, data) => {
    const response = await fetch(url + "/api/" + route, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Canvas-Token": token },
      body: JSON.stringify({
        baseRevision: view.revision,
        commandId: randomUUID(),
        ...data,
      }),
    });
    const next = await response.json();
    assert.equal(response.status, 200, JSON.stringify(next));
    view = next;
    return next;
  };
  await post("component", { operation: "create" });
  const original = view.selectedComponentId;
  await post("component", { operation: "duplicate", componentId: original });
  const copy = view.selectedComponentId;
  assert.notEqual(copy, original);
  assert.equal(view.state.components.length, 3);
  await post("component", {
    operation: "set_text",
    componentId: copy,
    nodeId: "body",
    text: "Review <b>literally</b> & 中文",
  });
  assert.equal(
    view.state.components.find((c) => c.id === original).body,
    "Add your next thought here.",
  );
  assert.equal(
    view.state.components.find((c) => c.id === copy).body,
    "Review <b>literally</b> & 中文",
  );
  await post("component", {
    operation: "move",
    componentId: copy,
    direction: -1,
  });
  assert.deepEqual(
    view.state.components.map((c) => c.id),
    ["welcome", copy, original],
  );
  const moved = structuredClone(view.state);
  await post("component", { operation: "delete", componentId: copy });
  assert.equal(view.state.components.length, 2);
  await post("undo", {});
  assert.deepEqual(view.state, moved);
  await post("redo", {});
  assert.equal(
    view.state.components.some((c) => c.id === copy),
    false,
  );
  const html = fs.readFileSync(
    path.join(dir, "workspace", "components", original + ".html"),
    "utf8",
  );
  assert.match(html, /data-node-id="body"/);
  const events = view.events.filter(
    (e) => e.type === "workspace.edit_committed",
  );
  assert.deepEqual(
    events.slice(0, 5).map((e) => e.payload.intent.operation),
    ["create", "duplicate", "set_text", "move", "delete"],
  );
  const exported = await (await fetch(url + "/api/export")).json();
  assert.equal(
    exported.events_jsonl.split("\n").filter(Boolean).length,
    view.events.length,
  );
});

test("CUJ: duplicate retries are exactly once even after restart", (t) => {
  const { dir, store, run } = fixture(t);
  const data = {
    operation: "duplicate",
    componentId: "welcome",
    baseRevision: 0,
    commandId: "retry-copy",
  };
  const event = run(data);
  assert.deepEqual(run(data), event);
  assert.equal(store.state.components.length, 2);
  store.close();
  const reopened = new Store(dir);
  try {
    assert.deepEqual(componentCommand(reopened, data), event);
    assert.equal(reopened.revision, 1);
    assert.throws(
      () => componentCommand(reopened, { ...data, operation: "delete" }),
      /reused/,
    );
  } finally {
    reopened.close();
  }
});

test("CUJ: stale inline draft, invalid nodes and oversized text never overwrite committed content", (t) => {
  const { store, run } = fixture(t);
  const oldRevision = store.revision;
  run({
    operation: "set_text",
    componentId: "welcome",
    nodeId: "title",
    text: "Newer title",
  });
  const committed = structuredClone(store.state);
  assert.throws(
    () =>
      run({
        operation: "set_text",
        componentId: "welcome",
        nodeId: "title",
        text: "Stale title",
        baseRevision: oldRevision,
      }),
    { status: 409 },
  );
  assert.throws(
    () =>
      run({
        operation: "set_text",
        componentId: "welcome",
        nodeId: "html",
        text: "<script>",
      }),
    /Unsupported/,
  );
  assert.throws(
    () =>
      run({
        operation: "set_text",
        componentId: "welcome",
        nodeId: "title",
        text: "x".repeat(121),
      }),
    /Invalid component/,
  );
  assert.deepEqual(store.state, committed);
  assert.equal(store.revision, 1);
});

test("CUJ: component capacity, last-card deletion and ordering boundaries preserve a valid canvas", (t) => {
  const { store, run } = fixture(t);
  assert.throws(
    () => run({ operation: "delete", componentId: "welcome" }),
    /at least one/,
  );
  assert.throws(
    () => run({ operation: "move", componentId: "welcome", direction: -1 }),
    /edge/,
  );
  assert.throws(
    () => run({ operation: "move", componentId: "welcome", direction: 2 }),
    /Direction/,
  );
  for (let i = 0; i < 7; i++) run({ operation: "create" });
  assert.throws(
    () => run({ operation: "duplicate", componentId: "welcome" }),
    /1–8/,
  );
  assert.equal(store.state.components.length, 8);
  assert.equal(store.revision, 7);
});
