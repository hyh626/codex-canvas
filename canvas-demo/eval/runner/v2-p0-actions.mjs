/**
 * HTTP contract used by the v2 P0 proposal review evaluations.
 *
 * Stage: POST /api/agent with reviewMode="stage". A successful response has
 * { proposalId, baseRevision, proposal, status:"pending" }; it emits audited
 * model request/response events and workspace.proposal_staged, without an
 * edit commit.
 *
 * Decide: POST /api/proposal with { proposalId, decision, baseRevision,
 * commandId }. Accept commits the staged proposal once. Reject records
 * workspace.proposal_rejected without changing the model. A stale accept
 * returns 409, retains the proposal as conflicted, and records
 * workspace.proposal_conflicted without committing.
 */
export const V2_P0_PROPOSAL_API = Object.freeze({
  stage: { method: "POST", path: "/api/agent", modeField: "reviewMode", mode: "stage" },
  decide: { method: "POST", path: "/api/proposal" },
});

async function showOutcome(page, outcome) {
  if (!outcome.ok && page) {
    await page.evaluate((message) => globalThis.__canvasEval.showError(message), outcome.body?.error ?? "Proposal action failed");
  }
}

/** Execute a v2 P0 action through the real Canvas HTTP routes. */
export async function executeV2P0Action({
  actionItem,
  post,
  page,
  app,
  selectedActual,
  actualComponentId = (id) => id,
  scenarioId = "human-edit",
  renderCurrent,
  context = new Map(),
}) {
  const input = actionItem.input;
  let outcome;
  if (actionItem.kind === "proposal_stage") {
    const componentId = selectedActual ?? actualComponentId(input.component_id ?? "welcome");
    const baseRevision = app.store.revision;
    outcome = await post("agent", {
      engine: input.engine,
      prompt: input.prompt,
      componentId,
      baseRevision,
      commandId: input.command_id ?? `eval-proposal-${actionItem.step}`,
      capture: input.capture === true,
      reviewMode: input.review_mode,
    });
    if (outcome.ok) {
      if (
        typeof outcome.body?.proposalId !== "string" ||
        outcome.body.baseRevision !== baseRevision ||
        outcome.body.status !== "pending" ||
        !outcome.body.proposal
      ) {
        outcome = { ok: false, status: 502, body: { error: "Agent response did not stage a reviewable proposal" } };
      } else {
        context.set(`proposal:${input.proposal_key ?? "last"}`, {
          proposalId: outcome.body.proposalId,
          baseRevision: outcome.body.baseRevision,
        });
      }
    }
  } else if (actionItem.kind === "proposal_decision") {
    const staged = context.get(`proposal:${input.proposal_key ?? "last"}`);
    if (!staged)
      outcome = { ok: false, status: 424, body: { error: "No staged proposal is available for review" } };
    else outcome = await post("proposal", {
      proposalId: staged.proposalId,
      decision: input.decision,
      baseRevision: input.base_revision ?? staged?.baseRevision ?? app.store.revision,
      commandId: input.command_id ?? `eval-proposal-decision-${actionItem.step}`,
    });
    if (outcome.ok) context.delete(`proposal:${input.proposal_key ?? "last"}`);
  } else if (actionItem.kind === "human_edit_commit") {
    outcome = await post("component", {
      operation: "set_text",
      componentId: actualComponentId(input.component_id),
      nodeId: input.node_id,
      text: input.value,
      baseRevision: input.base_revision ?? app.store.revision,
      commandId: input.command_id ?? `eval-human-edit-${actionItem.step}`,
    });
  } else {
    return null;
  }

  if (outcome.ok && renderCurrent) await renderCurrent(scenarioId);
  else await showOutcome(page, outcome);
  return outcome;
}
