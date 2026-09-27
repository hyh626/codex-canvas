import fs from "node:fs";
import path from "node:path";
import { Store, hash } from "./store.mjs";

function invalid(message) {
  throw Object.assign(Error(message), { status: 422 });
}

function syncDirectory(dir) {
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeDurable(file, bytes) {
  const fd = fs.openSync(file, "wx");
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function syncTree(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) syncTree(child);
  }
  syncDirectory(dir);
}

const backupPath = (dir) => path.join(path.dirname(dir), `.canvas-backup-${hash(path.resolve(dir)).slice(0, 32)}`);

export function recoverInterruptedImport(dir) {
  const target = path.resolve(dir);
  if (fs.existsSync(target)) return false;
  const backup = backupPath(target);
  if (!fs.existsSync(backup)) return false;
  fs.renameSync(backup, target);
  syncDirectory(path.dirname(target));
  return true;
}

function verifyReferences(value, blobs) {
  if (!value || typeof value !== "object") return;
  if (typeof value.sha256 === "string" && Number.isInteger(value.size_bytes)) {
    const bytes = blobs.get(value.sha256);
    if (!bytes || bytes.length !== value.size_bytes) invalid(`Archive is missing blob ${value.sha256}`);
  }
  for (const child of Object.values(value)) verifyReferences(child, blobs);
}

function validateArchive(archive) {
  if (archive?.format !== "canvas-demo-archive-v1" || typeof archive.events_jsonl !== "string" || !archive.events_jsonl.endsWith("\n") || !archive.blobs || typeof archive.blobs !== "object" || Array.isArray(archive.blobs))
    invalid("Invalid canvas archive");
  const blobs = new Map();
  for (const [name, encoded] of Object.entries(archive.blobs)) {
    if (!/^[a-f0-9]{64}$/.test(name) || typeof encoded !== "string") invalid("Invalid archive blob entry");
    const bytes = Buffer.from(encoded, "base64");
    if (bytes.toString("base64") !== encoded || hash(bytes) !== name) invalid(`Archive blob ${name} failed integrity check`);
    blobs.set(name, bytes);
  }
  let events;
  try {
    events = archive.events_jsonl.trimEnd().split("\n").map(JSON.parse);
  } catch {
    invalid("Invalid archive event log");
  }
  if (!events.length) invalid("Archive event log is empty");
  for (const event of events) verifyReferences(event, blobs);
  return blobs;
}

export function restoreArchive(store, archive, { fault } = {}) {
  const blobs = validateArchive(archive);
  const parent = path.dirname(store.dir);
  const staging = fs.mkdtempSync(path.join(parent, ".canvas-import-"));
  const backup = backupPath(store.dir);
  let closedCurrent = false;
  let movedCurrent = false;
  let movedStaging = false;
  try {
    const blobDir = path.join(staging, "blobs", "sha256");
    fs.mkdirSync(blobDir, { recursive: true });
    writeDurable(path.join(staging, "events.jsonl"), archive.events_jsonl);
    for (const [name, bytes] of blobs) writeDurable(path.join(blobDir, name), bytes);
    let candidate;
    try {
      candidate = new Store(staging);
      if (candidate.export().events_jsonl !== archive.events_jsonl) invalid("Archive replay changed event bytes");
    } finally {
      candidate?.close();
    }
    // Persist the complete replacement before making it visible at store.dir.
    syncTree(staging);
    if (fault === "interrupt_after_validation")
      throw Object.assign(Error("Import interrupted after validation"), { status: 500 });
    // An open, validated current store is authoritative over a backup left
    // behind after a previous completed swap.
    if (fs.existsSync(backup)) {
      fs.rmSync(backup, { recursive: true });
      syncDirectory(parent);
    }
    store.close();
    closedCurrent = true;
    fs.renameSync(store.dir, backup);
    movedCurrent = true;
    syncDirectory(parent);
    fs.renameSync(staging, store.dir);
    movedStaging = true;
    syncDirectory(parent);
    const replacement = new Store(store.dir);
    try { fs.rmSync(backup, { recursive: true, force: true }); } catch { /* Preserve a recoverable backup if cleanup fails. */ }
    return replacement;
  } catch (error) {
    if (movedStaging) fs.renameSync(store.dir, staging);
    if (movedCurrent) fs.renameSync(backup, store.dir);
    if (closedCurrent) {
      // The caller reopens the original store after rollback.
      error.restoreStore = new Store(store.dir);
    }
    throw error;
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
