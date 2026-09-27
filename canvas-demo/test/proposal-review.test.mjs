import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Store, initial } from "../store.mjs";
import { decideProposal, latestProposal, proposalRecord, stageProposal } from "../proposal-review.mjs";

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canvas-proposal-"));
  const store = new Store(dir);
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return store;
}
const edit = (title = "Proposed") => ({ components: [{ ...initial.components[0], title }] });

test("staging retries are idempotent and reject changed input for the same request", (t) => {
  const store = fixture(t);
  const first = stageProposal(store, { proposal: edit(), baseRevision: 0, requestEventId: "request-1" });
  const retry = stageProposal(store, { proposal: edit(), baseRevision: 0, requestEventId: "request-1" });
  assert.equal(retry.proposalId, first.proposalId);
  assert.equal(store.events.filter((e) => e.type === "workspace.proposal_staged").length, 1);
  assert.throws(() => stageProposal(store, { proposal: edit("Changed"), baseRevision: 0, requestEventId: "request-1" }), { status: 409 });
  assert.throws(() => stageProposal(store, { proposal: edit(), baseRevision: 9 }), { status: 409 });
});

test("decision acceptance is repeatable and a post-commit crash is repaired", (t) => {
  const store = fixture(t);
  const staged = stageProposal(store, { proposal: edit(), baseRevision: 0, requestEventId: "request-2" });
  const stagedEvent = store.events.find((e) => e.type === "workspace.proposal_staged");
  // Simulate process interruption after the durable edit event, before the terminal event.
  store.commit({ state: edit(), baseRevision: 0, commandId: "proposal-command", actor: "agent", causedBy: [stagedEvent.event_id] });
  assert.deepEqual(decideProposal(store, { proposalId: staged.proposalId, decision: "accept", baseRevision: 0, commandId: "proposal-command" }), { proposalId: staged.proposalId, status: "accepted" });
  assert.deepEqual(decideProposal(store, { proposalId: staged.proposalId, decision: "accept", baseRevision: 0, commandId: "proposal-command" }), { proposalId: staged.proposalId, status: "accepted" });
  assert.equal(proposalRecord(store, staged.proposalId).status, "accepted");
  assert.deepEqual(latestProposal(store), { status: "none" });
  assert.equal(store.events.filter((e) => e.type === "workspace.proposal_accepted").length, 1);
});

test("stale proposals become terminal conflicts; reject does not change canvas", (t) => {
  const store = fixture(t);
  const staged = stageProposal(store, { proposal: edit(), baseRevision: 0, requestEventId: "request-3" });
  const changed = edit("Human edit");
  store.commit({ state: changed, baseRevision: 0, commandId: "human" });
  assert.throws(() => decideProposal(store, { proposalId: staged.proposalId, decision: "accept", baseRevision: 0, commandId: "agent" }), { status: 409 });
  assert.equal(proposalRecord(store, staged.proposalId).status, "conflicted");
  assert.deepEqual(store.state, changed);

  const rejected = stageProposal(store, { proposal: edit("Other"), baseRevision: 1, requestEventId: "request-4" });
  assert.deepEqual(decideProposal(store, { proposalId: rejected.proposalId, decision: "reject", baseRevision: 1 }), { proposalId: rejected.proposalId, status: "rejected" });
  assert.deepEqual(store.state, changed);
});

test("invalid proposal and mismatched decision metadata fail without events", (t) => {
  const store = fixture(t);
  const before = store.events.length;
  assert.throws(() => stageProposal(store, { proposal: { components: [] }, baseRevision: 0 }));
  assert.equal(store.events.length, before);
  const staged = stageProposal(store, { proposal: edit(), baseRevision: 0 });
  assert.throws(() => decideProposal(store, { proposalId: staged.proposalId, decision: "accept", baseRevision: 1, commandId: "x" }), { status: 409 });
  assert.throws(() => decideProposal(store, { proposalId: staged.proposalId, decision: "maybe", baseRevision: 0 }), { status: 400 });
  assert.equal(proposalRecord(store, staged.proposalId).status, "pending");
});
