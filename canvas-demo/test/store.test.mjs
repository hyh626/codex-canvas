import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store, initial, stable, hash, componentHTML } from "../store.mjs";
const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "canvas-test-"));
function fixture(t) {
  const dir = temp();
  const store = new Store(dir);
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, store };
}
test("human and agent commit, undo twice, redo, restart and replay", (t) => {
  const { dir, store } = fixture(t);
  const human = structuredClone(initial);
  human.components[0].title = "Human edit";
  store.commit({ state: human, baseRevision: 0, commandId: "h" });
  const agent = structuredClone(human);
  agent.components[0].color = "#0d9488";
  store.commit({
    state: agent,
    baseRevision: 1,
    commandId: "a",
    actor: "agent",
  });
  store.history("undo", 2, "u1");
  assert.deepEqual(store.state, human);
  store.history("undo", 3, "u2");
  assert.deepEqual(store.state, initial);
  store.history("redo", 4, "r1");
  assert.deepEqual(store.state, human);
  const archive = store.export();
  store.close();
  const resumed = new Store(dir);
  assert.deepEqual(resumed.view().state, human);
  assert.equal(resumed.revision, 5);
  assert.equal(resumed.redo.length, 1);
  assert.deepEqual(resumed.export(), archive);
  resumed.close();
});
test("stale revision and conflicting command retry cannot overwrite state", (t) => {
  const { store } = fixture(t);
  const state = structuredClone(initial);
  state.components[0].title = "New";
  const args = { state, baseRevision: 0, commandId: "same" };
  const event = store.commit(args);
  assert.deepEqual(store.commit(args), event);
  assert.equal(store.revision, 1);
  assert.throws(() => store.commit({ ...args, state: initial }), /reused/);
  assert.throws(
    () => store.commit({ state: initial, baseRevision: 0, commandId: "stale" }),
    /Revision conflict/,
  );
  assert.deepEqual(store.state, state);
});
test("new edit after undo invalidates redo; invalid schema never commits", (t) => {
  const { store } = fixture(t);
  store.commit({ state: initial, baseRevision: 0, commandId: "one" });
  store.history("undo", 1, "undo");
  store.commit({ state: initial, baseRevision: 2, commandId: "two" });
  assert.equal(store.redo.length, 0);
  const bad = structuredClone(initial);
  bad.components[0].id = "../escape";
  assert.throws(() =>
    store.commit({ state: bad, baseRevision: 3, commandId: "bad" }),
  );
  assert.equal(store.revision, 3);
});
test("request rebuild is exact, capture off by default, corruption fails closed", (t) => {
  const { store } = fixture(t);
  const items = [
    { role: "user", content: { text: "你好 <html>", missing: null } },
  ];
  const { request, event } = store.prepare(items);
  assert.deepEqual(store.rebuild(event.payload.plan), request);
  assert.equal(event.payload.verification.assert, true);
  assert.equal("body" in event.payload, false);
  assert.deepEqual(
    store.get(store.prepare(items, true).event.payload.body),
    request,
  );
  const ref = event.payload.plan.items[0];
  fs.writeFileSync(path.join(store.blobs, ref.sha256), "{}");
  assert.throws(() => store.rebuild(event.payload.plan), /integrity/);
  assert.throws(() => store.prepare(items), /integrity/);
});
test("archive restores full event bytes, every blob and state in a fresh directory", (t) => {
  const { store } = fixture(t);
  store.prepare([{ role: "user", content: "review" }]);
  const archive = store.export();
  const dir = temp();
  fs.mkdirSync(path.join(dir, "blobs", "sha256"), { recursive: true });
  fs.writeFileSync(path.join(dir, "events.jsonl"), archive.events_jsonl);
  for (const [key, value] of Object.entries(archive.blobs)) {
    const bytes = Buffer.from(value, "base64");
    assert.equal(hash(bytes), key);
    fs.writeFileSync(path.join(dir, "blobs", "sha256", key), bytes);
  }
  const restored = new Store(dir);
  assert.deepEqual(restored.export(), archive);
  assert.deepEqual(restored.state, store.state);
  restored.close();
  fs.rmSync(dir, { recursive: true });
});
test("partial trailing append recovers committed prefix and writer lock rejects a second writer", (t) => {
  const { store, dir } = fixture(t);
  assert.throws(() => new Store(dir), /EEXIST/);
  store.close();
  fs.appendFileSync(path.join(dir, "events.jsonl"), '{"broken":');
  const restored = new Store(dir);
  assert.deepEqual(restored.state, initial);
  assert.equal(restored.events.length, 1);
  restored.close();
});
test("HTML projection escapes content and keeps stable node identity (snapshot)", () => {
  assert.equal(
    componentHTML({
      id: "welcome",
      title: '<script>&"',
      body: "'safe'",
      color: "#123456",
    }),
    '<article data-component-id="welcome" style="--accent:#123456"><h2 data-node-id="title">&lt;script&gt;&amp;&quot;</h2><p data-node-id="body">&#39;safe&#39;</p></article>\n',
  );
});
