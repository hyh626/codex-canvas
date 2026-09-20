import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../store.mjs";
import { checkAudit } from "../validation/live-cuj.mjs";

test("live runner blocks before network/process use when configuration is absent", () => {
  const script = fileURLToPath(
    new URL("../validation/live-model.mjs", import.meta.url),
  );
  for (const engine of ["codex", "dsh"]) {
    const result = spawnSync(process.execPath, [script, engine, "--live"], {
      env: {},
      encoding: "utf8",
    });
    assert.equal(result.status, 2);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "blocked");
    assert.equal(report.modelRequests, 0);
    assert.equal(report.missing.length, 4);
  }
});
test("live acceptance rejects incomplete, failed or unaudited responses", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-live-check-"));
  const store = new Store(dir);
  t.after(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  assert.throws(() => checkAudit(store, 0), /No audited/);
  const { event } = store.prepare([{ role: "user", content: "hello" }]);
  assert.throws(() => checkAudit(store, 0), /complete response/);
  store.append("model.response_received", { request_id: event.event_id });
  assert.equal(checkAudit(store, 0), 1);
  store.append("model.request_failed", { request_id: event.event_id });
  assert.throws(() => checkAudit(store, 0), /failed\/rejected/);
});
