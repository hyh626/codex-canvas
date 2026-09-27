import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store, hash, initial } from "../store.mjs";
import { recoverInterruptedImport, restoreArchive } from "../archive-import.mjs";

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), "canvas-import-test-"));

function makeArchive(t) {
  const root = temp();
  const source = new Store(path.join(root, "source"));
  t.after(() => {
    source.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  const changed = structuredClone(initial);
  changed.components[0].title = "Archived state";
  source.commit({ state: changed, baseRevision: 0, commandId: "archive-edit" });
  return source.export();
}

function targetStore(t) {
  const root = temp();
  const dir = path.join(root, "target");
  let store = new Store(dir);
  t.after(() => {
    store?.close();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { dir, get store() { return store; }, replace(next) { store = next; } };
}

test("rejects corrupt archives without changing or closing the current store", (t) => {
  const archive = makeArchive(t);
  const target = targetStore(t);
  const before = target.store.export();
  const corrupt = structuredClone(archive);
  const firstBlob = Object.keys(corrupt.blobs)[0];
  corrupt.blobs[firstBlob] = Buffer.from("tampered").toString("base64");

  assert.throws(() => restoreArchive(target.store, corrupt), { status: 422 });
  assert.deepEqual(target.store.export(), before);
  assert.equal(target.store.revision, 0);
  assert.equal(fs.existsSync(path.join(target.dir, "writer.lock")), true);
});

test("an interruption after validation leaves the original store usable", (t) => {
  const archive = makeArchive(t);
  const target = targetStore(t);
  const before = target.store.export();

  assert.throws(
    () => restoreArchive(target.store, archive, { fault: "interrupt_after_validation" }),
    { status: 500 },
  );
  assert.deepEqual(target.store.export(), before);
  const next = structuredClone(initial);
  next.components[0].title = "Still writable";
  target.store.commit({ state: next, baseRevision: 0, commandId: "still-open" });
  assert.equal(target.store.revision, 1);
});

test("restores the same archive repeatedly with identical event and blob bytes", (t) => {
  const archive = makeArchive(t);
  const target = targetStore(t);
  target.replace(restoreArchive(target.store, archive));
  assert.deepEqual(target.store.export(), archive);
  target.replace(restoreArchive(target.store, archive));
  assert.deepEqual(target.store.export(), archive);
  assert.equal(target.store.revision, 1);
});

test("startup recovers the prior store when a swap stopped after its first rename", (t) => {
  const root = temp();
  const dir = path.join(root, "target");
  const store = new Store(dir);
  const before = store.export();
  store.close();
  const backup = path.join(root, `.canvas-backup-${hash(path.resolve(dir)).slice(0, 32)}`);
  fs.renameSync(dir, backup);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.equal(recoverInterruptedImport(dir), true);
  const recovered = new Store(dir);
  try {
    assert.deepEqual(recovered.export(), before);
    assert.equal(recoverInterruptedImport(dir), false);
  } finally {
    recovered.close();
  }
});
