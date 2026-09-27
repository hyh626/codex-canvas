# Mind map CUJs: proposed v3 TDD corpus

Status: **P0 implemented and evaluated; P1 remains planned.** The 15 P0 cases across creation, text, branching, moving, and selected-data requests pass in the v3 corpus. The remaining 12 cases in the table are future work.

The first release treats a mind map (思维导图) as a rooted, ordered tree inside one canvas component. Users can create branches, edit ideas, reorganize subtrees, collapse branches, comment on nodes, and review agent changes. The canvas derives node positions and connectors from the committed tree. A user can select a node, branch, or several nodes and ask the agent to work with that selection as structured data. Cross-links between branches, arbitrary graph edges, and free positioning can be separate future journeys.

## Product contract to establish before the UI

- Add a typed `mind_map` component alongside card and HTML components. Keep the existing eight-component workspace limit; define a separate, explicit node limit for each mind map before implementation.
- Store one root and nodes with stable IDs, `parentId`, sibling order, and plain-text labels. A subtree move preserves every descendant ID. Reject missing parents, duplicate IDs, cycles, moving the root, and invalid sibling positions at the command boundary.
- Derive layout from tree order with deterministic placement. Do not store rendered coordinates as the source of truth. Connectors must join the rendered parent and child even after a move or resize.
- Commit one user operation as one workspace revision with an undoable diff. An optimistic revision conflict leaves the draft and committed tree intact. Undo/Redo and archive restore preserve node IDs and ordering.
- Anchor comments to component and node IDs. Deleting a node leaves its historical comment orphaned; restoring the same ID makes that anchor valid again. Agent edits use the existing proposal review boundary and may only commit after acceptance.
- Decide whether collapsed branches are shared document state or local view state before writing persistence evals. Proposed default: collapse is local view state, because it changes navigation without changing the document tree. Reload restores the last local view; export/restore carries the semantic tree.

## Selection-to-agent data contract

The committed tree is the source for both rendering and agent context. When the user selects map content and chooses **Ask agent about selection**, the UI shows the selected node IDs and edit scope. The server rebuilds the context from the committed snapshot at `baseRevision`; it does not trust labels or hierarchy supplied by the browser. An example payload is:

```json
{
  "schemaVersion": 1,
  "baseRevision": 12,
  "componentId": "map-1",
  "selection": { "mode": "subtree", "nodeIds": ["topic-2"] },
  "context": {
    "ancestors": [{ "id": "root", "label": "Launch plan" }],
    "nodes": [
      { "id": "topic-2", "parentId": "root", "order": 1, "label": "Research" },
      { "id": "task-5", "parentId": "topic-2", "order": 0, "label": "Interview users" }
    ],
    "comments": []
  },
  "instruction": "Break this branch into three concrete tasks"
}
```

`node` includes one node, `subtree` includes its descendants even when collapsed, and `multi` includes the explicitly selected nodes in tree order. Include ancestor breadcrumbs and relevant comments so the model can interpret each label. Deduplicate descendants when both a parent and its child are selected. Validate selected IDs and revision before preparing the request. Keep context within the existing request size limit; return an actionable size error instead of silently dropping selected nodes.

The target protocol has the agent return typed operations against stable node IDs, such as add child, rename, or move subtree. The server would validate and stage the operations with a preview of affected nodes. The selection defines the permitted edit scope: a proposal touching other nodes or using stale IDs is rejected. Accepting a valid proposal applies all operations atomically at its base revision; rejecting it leaves the map unchanged. The request record retains the selection and exact context sent to the model so the edit can be audited and replayed.

The current implementation builds and records the structured selection context, then sends it **alongside the full canvas snapshot** through the existing proposal protocol. It checks the resulting full-snapshot proposal against the selected scope before staging or committing. Large maps can still hit the current 8 KB request limit; switching to typed, selection-only operations is the next protocol step.

## New customer journeys and eval cases

Each row is one journey with three independently runnable cases, following the v2 corpus structure. **P0** cases define the editing model and selection data; **P1** cases complete review, durability, and usable rendering. Every case should assert the committed model and the visible result.

| Priority | Journey | Case IDs and user actions | Acceptance contract |
| --- | --- | --- | --- |
| P0 | Start a map | `create/root`: create a map and rename its root; `create/child`: add the first child; `create/sibling`: add and order two siblings | One root, stable IDs, expected parent/order, visible nodes and connectors; each accepted action commits once. |
| P0 | Edit ideas | `text/inline`: rename a node in place; `text/cancel`: cancel an unfinished label; `text/conflict`: submit a stale label after another editor commits | Plain text renders literally; cancel creates no revision; conflict preserves the draft and does not overwrite the newer label. |
| P0 | Grow a branch | `branch/subtree`: add child and grandchild; `branch/duplicate`: duplicate a subtree; `branch/delete-undo`: delete a branch and undo | Descendants and edges appear in the right hierarchy; duplicate gets fresh IDs; undo restores the original IDs and sibling positions. |
| P0 | Reorganize | `move/reparent`: move a subtree to another parent; `move/reorder`: change sibling order; `move/cycle`: attempt to move a parent under its descendant | Valid moves are atomic and preserve descendant IDs; rejected cycles make no commit; layout and connectors follow the new tree. |
| P0 | Select data for the agent | `selection/node`: ask about one selected idea; `selection/subtree`: ask about a collapsed branch; `selection/multi`: ask about two nonadjacent ideas | The recorded request has the exact selected IDs, committed labels, hierarchy, ancestor path, relevant comments, and revision in deterministic order; no unselected subtree is silently included. |
| P1 | Explore a large map | `view/collapse`: collapse and expand a branch; `view/keyboard`: navigate, expand, and create by keyboard; `view/narrow`: use a deep map at narrow width and enlarged text | Hidden descendants remain in the model, focus stays predictable, no visible node/connector clipping or overlap blocks editing, and controls have usable accessible names. |
| P1 | Review agent edits | `agent/add`: review an addition inside the selected branch; `agent/scope`: propose an edit outside the selection; `agent/stale`: try accepting a proposal after a human edit | Preview identifies affected nodes; a valid scoped edit commits once; an out-of-scope or stale proposal makes no model commit and preserves the human edit. |
| P1 | Discuss an idea | `comment/anchor`: comment on a node; `comment/move`: move its subtree; `comment/orphan`: delete and undo the node | The anchor stays on the same node ID through a move; deletion retains historical comment data; undo makes the comment visible on the restored node. |
| P1 | Keep the map | `history/undo-redo`: undo and redo a restructure; `history/restart`: restart and replay; `history/export-restore`: restore an exported map in a fresh store | The exact tree, IDs, sibling order, revision history, and rendered hierarchy survive each path; no partial import changes the destination. |

## Eval development plan

Current P0 run: `npm run eval:validate:inputs -- --corpus v3`, then `npm run eval:run -- --corpus v3`. The 15 P0 cases pass with model, selection-context, DOM-node, and SVG connector oracles. The steps below cover the remaining P1 cases and protocol improvement.

1. **Write the v3 corpus first.** Use `eval/cases/v3/<journey>/<case>/` with the existing spec, fixture, actions, and independent expected model conventions. Add mind map action drivers for create, rename, add, duplicate, move, delete, select, request agent, review, collapse, keyboard, comment, and restore. The initial run should record red cases against the current product.
2. **Assert structure independently.** Parse the committed snapshot and check one root, unique IDs, valid parent references, no cycles, sibling order, exact affected subtree, and unchanged unrelated nodes. Check revision count and events per operation. Expected trees must come from case fixtures, not from the product's layout or command implementation.
3. **Assert rendering and interaction.** At standard and narrow viewports, compare visible node IDs, labels, parent-child connector endpoints, and DOM geometry. Capture screenshots for review; use structural and geometry checks as pass/fail oracles. Check keyboard focus, accessible names, expanded state, and whether inline drafts survive conflicts.
4. **Assert selection and collaboration.** Compare the recorded model request to an independently built, exact context payload for node, subtree, and multi-selection. Check deterministic order, collapsed descendants, stale-ID rejection, context-size failure, and the absence of unintended branches. Run proposals through the deterministic mock engine; verify scope enforcement, pending, accepted, rejected, and stale states.
5. **Assert recovery.** Use the existing restart and fresh-store import drivers to prove replay and restore. Keep a separate optional live-engine lane for provider behavior after the deterministic contract passes.
6. **Implement in dependency order.** Land typed schema and validation, then tree commands and history, then selection serialization and scope validation, then layout and editing UI, then comment/agent integration, then collapse and keyboard/narrow-view behavior. Rerun each focused red case as it becomes green; finish with v1, v2, and v3 corpora and evidence-bundle validation.

The release gate is all 27 v3 cases passing with a valid evidence bundle, plus no v1/v2 regression. Record any remaining visual or browser-specific limitation in the run report rather than weakening a model assertion.
