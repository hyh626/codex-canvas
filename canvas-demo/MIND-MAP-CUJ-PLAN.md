# Mind map CUJs: proposed v3 TDD corpus

Status: **planned; no mind map product support or v3 eval cases are implemented yet.**

The first release treats a mind map (思维导图) as a rooted, ordered tree inside one canvas component. Users can create branches, edit ideas, reorganize subtrees, collapse branches, comment on nodes, and review agent changes. The canvas derives node positions and connectors from the committed tree. Cross-links between branches, arbitrary graph edges, and free positioning can be separate future journeys.

## Product contract to establish before the UI

- Add a typed `mind_map` component alongside card and HTML components. Keep the existing eight-component workspace limit; define a separate, explicit node limit for each mind map before implementation.
- Store one root and nodes with stable IDs, `parentId`, sibling order, and plain-text labels. A subtree move preserves every descendant ID. Reject missing parents, duplicate IDs, cycles, moving the root, and invalid sibling positions at the command boundary.
- Derive layout from tree order with deterministic placement. Do not store rendered coordinates as the source of truth. Connectors must join the rendered parent and child even after a move or resize.
- Commit one user operation as one workspace revision with an undoable diff. An optimistic revision conflict leaves the draft and committed tree intact. Undo/Redo and archive restore preserve node IDs and ordering.
- Anchor comments to component and node IDs. Deleting a node leaves its historical comment orphaned; restoring the same ID makes that anchor valid again. Agent edits use the existing proposal review boundary and may only commit after acceptance.
- Decide whether collapsed branches are shared document state or local view state before writing persistence evals. Proposed default: collapse is local view state, because it changes navigation without changing the document tree. Reload restores the last local view; export/restore carries the semantic tree.

## New customer journeys and eval cases

Each row is one journey with three independently runnable cases, following the v2 corpus structure. **P0** cases define the editing model; **P1** cases complete review, durability, and usable rendering. Every case should assert the committed model and the visible result.

| Priority | Journey | Case IDs and user actions | Acceptance contract |
| --- | --- | --- | --- |
| P0 | Start a map | `create/root`: create a map and rename its root; `create/child`: add the first child; `create/sibling`: add and order two siblings | One root, stable IDs, expected parent/order, visible nodes and connectors; each accepted action commits once. |
| P0 | Edit ideas | `text/inline`: rename a node in place; `text/cancel`: cancel an unfinished label; `text/conflict`: submit a stale label after another editor commits | Plain text renders literally; cancel creates no revision; conflict preserves the draft and does not overwrite the newer label. |
| P0 | Grow a branch | `branch/subtree`: add child and grandchild; `branch/duplicate`: duplicate a subtree; `branch/delete-undo`: delete a branch and undo | Descendants and edges appear in the right hierarchy; duplicate gets fresh IDs; undo restores the original IDs and sibling positions. |
| P0 | Reorganize | `move/reparent`: move a subtree to another parent; `move/reorder`: change sibling order; `move/cycle`: attempt to move a parent under its descendant | Valid moves are atomic and preserve descendant IDs; rejected cycles make no commit; layout and connectors follow the new tree. |
| P1 | Explore a large map | `view/collapse`: collapse and expand a branch; `view/keyboard`: navigate, expand, and create by keyboard; `view/narrow`: use a deep map at narrow width and enlarged text | Hidden descendants remain in the model, focus stays predictable, no visible node/connector clipping or overlap blocks editing, and controls have usable accessible names. |
| P1 | Review agent edits | `agent/add`: review a proposed branch addition; `agent/restructure`: review a multi-node move and rename; `agent/stale`: try accepting a proposal after a human edit | Proposal preview identifies affected nodes; accept commits one revision; reject or stale accept leaves the tree unchanged and preserves the human edit. |
| P1 | Discuss an idea | `comment/anchor`: comment on a node; `comment/move`: move its subtree; `comment/orphan`: delete and undo the node | The anchor stays on the same node ID through a move; deletion retains historical comment data; undo makes the comment visible on the restored node. |
| P1 | Keep the map | `history/undo-redo`: undo and redo a restructure; `history/restart`: restart and replay; `history/export-restore`: restore an exported map in a fresh store | The exact tree, IDs, sibling order, revision history, and rendered hierarchy survive each path; no partial import changes the destination. |

## Eval development plan

1. **Write the v3 corpus first.** Use `eval/cases/v3/<journey>/<case>/` with the existing spec, fixture, actions, and independent expected model conventions. Add mind map action drivers for create, rename, add, duplicate, move, delete, collapse, keyboard, comment, proposal, and restore. The initial run should record red cases against the current product.
2. **Assert structure independently.** Parse the committed snapshot and check one root, unique IDs, valid parent references, no cycles, sibling order, exact affected subtree, and unchanged unrelated nodes. Check revision count and events per operation. Expected trees must come from case fixtures, not from the product's layout or command implementation.
3. **Assert rendering and interaction.** At standard and narrow viewports, compare visible node IDs, labels, parent-child connector endpoints, and DOM geometry. Capture screenshots for review; use structural and geometry checks as pass/fail oracles. Check keyboard focus, accessible names, expanded state, and whether inline drafts survive conflicts.
4. **Assert collaboration and recovery.** Run proposals through the deterministic mock engine; verify pending, accepted, rejected, and stale states. Use the existing restart and fresh-store import drivers to prove replay and restore. Keep a separate optional live-engine lane for provider behavior after the deterministic contract passes.
5. **Implement in dependency order.** Land typed schema and validation, then tree commands and history, then layout and editing UI, then comment/agent integration, then collapse and keyboard/narrow-view behavior. Rerun each focused red case as it becomes green; finish with v1, v2, and v3 corpora and evidence-bundle validation.

The release gate is all 24 v3 cases passing with a valid evidence bundle, plus no v1/v2 regression. Record any remaining visual or browser-specific limitation in the run report rather than weakening a model assertion.
