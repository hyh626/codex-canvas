import test from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { codexProposal } from "../codex.mjs";
import { initial } from "../store.mjs";
test("app-server adapter handshake, output schema, final message and child cleanup", async () => {
  const messages = [];
  const actual = await codexProposal(
    { snapshot: initial },
    (type, data) => messages.push({ type, data }),
    {
      command: process.execPath,
      args: [fileURLToPath(new URL("./fake-app-server.mjs", import.meta.url))],
      timeout: 5000,
    },
  );
  assert.equal(actual.components[0].title, "Protocol verified");
  assert.deepEqual(
    messages
      .filter((e) => e.type === "engine.request_sent")
      .map((e) => e.data.method),
    ["initialize", "thread/start", "turn/start"],
  );
  assert.equal(
    messages.find((e) => e.data.method === "thread/start").data.params.sandbox,
    "read-only",
  );
});
test("missing Codex executable fails without hanging", async () => {
  await assert.rejects(
    codexProposal({ snapshot: initial }, () => {}, {
      command: "/missing-codex-demo-binary",
      timeout: 1000,
    }),
    /ENOENT/,
  );
});
