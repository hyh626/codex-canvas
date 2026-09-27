import { randomUUID } from "node:crypto";
import { validate } from "./store.mjs";

const terminalTypes = {
  "workspace.proposal_accepted": "accepted",
  "workspace.proposal_rejected": "rejected",
  "workspace.proposal_conflicted": "conflicted",
};

export function proposalRecord(store, proposalId) {
  const staged = store.events.find((event) => event.type === "workspace.proposal_staged" && event.payload.proposal_id === proposalId);
  if (!staged) return null;
  const terminal = store.events.find((event) => terminalTypes[event.type] && event.payload.proposal_id === proposalId);
  return {
    proposalId,
    baseRevision: staged.payload.base_revision,
    proposal: store.get(staged.payload.proposal),
    status: terminal ? terminalTypes[terminal.type] : "pending",
    stagedEventId: staged.event_id,
  };
}

export function latestProposal(store) {
  const staged = [...store.events].reverse().find((event) => event.type === "workspace.proposal_staged");
  if (!staged) return { status: "none" };
  const record = proposalRecord(store, staged.payload.proposal_id);
  return record.status === "accepted" || record.status === "rejected"
    ? { status: "none" }
    : { status: record.status, proposalId: record.proposalId, baseRevision: record.baseRevision, proposal: record.proposal };
}

export function stageProposal(store, { proposal, baseRevision, requestEventId }) {
  validate(proposal);
  if (baseRevision !== store.revision)
    throw Object.assign(Error("The proposal is based on an older revision. Your edit is preserved; retry against the latest version."), { status: 409 });
  const proposalId = randomUUID();
  store.append("workspace.proposal_staged", {
    proposal_id: proposalId,
    base_revision: baseRevision,
    proposal: store.put(proposal),
  }, "agent", requestEventId ? [requestEventId] : []);
  return { proposalId, baseRevision, proposal, status: "pending" };
}

export function decideProposal(store, { proposalId, decision, baseRevision, commandId }) {
  if (typeof proposalId !== "string" || !["accept", "reject"].includes(decision))
    throw Object.assign(Error("Invalid proposal decision"), { status: 400 });
  const record = proposalRecord(store, proposalId);
  if (!record) throw Object.assign(Error("Proposal not found"), { status: 404 });
  if (record.status !== "pending")
    throw Object.assign(Error("Proposal has already been decided"), { status: 409 });
  if (baseRevision !== record.baseRevision)
    throw Object.assign(Error("Proposal base revision does not match"), { status: 409 });
  if (decision === "reject") {
    store.append("workspace.proposal_rejected", { proposal_id: proposalId, base_revision: record.baseRevision }, "human", [record.stagedEventId]);
    return { proposalId, status: "rejected" };
  }
  if (store.revision !== record.baseRevision) {
    store.append("workspace.proposal_conflicted", { proposal_id: proposalId, base_revision: record.baseRevision, current_revision: store.revision }, "runtime", [record.stagedEventId]);
    throw Object.assign(Error("Proposal is stale; review the latest canvas before retrying."), { status: 409 });
  }
  store.commit({
    state: record.proposal,
    baseRevision: record.baseRevision,
    commandId,
    actor: "agent",
    causedBy: [record.stagedEventId],
  });
  store.append("workspace.proposal_accepted", { proposal_id: proposalId, revision: store.revision }, "human", [record.stagedEventId]);
  return { proposalId, status: "accepted" };
}
