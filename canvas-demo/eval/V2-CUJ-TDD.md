# Canvas CUJ evals: v2 TDD corpus

The v2 corpus adds 24 deterministic examples across eight customer journeys. Each case has a spec, fixture, action sequence, independent expected model and UI checkpoints. The runner executes actions against a fresh local server and browser, records HTTP responses and events, captures the UI, and writes a reviewable evidence bundle. A red case is the next product contract to implement.

| Journey | Three examples | Product contract |
| --- | --- | --- |
| Proposal review | accept, reject, stale accept | Stage a proposal for explicit review; accept once at its base revision; reject or reject stale proposals without committing them. |
| Concurrent agent edit | same node, different component, retry after conflict | Preserve a human draft while the agent runs; detect overlap and support a reviewed retry. |
| Agent failure | invalid proposal, timeout, context over 8 KB | Fail closed without a model commit and show an actionable error. |
| Coordinated change | two cards, card and HTML, capacity boundary | Commit one valid multi-component change atomically; reject an invalid boundary change. |
| Comment lifecycle | orphan, reanchor, resolve | Preserve a historical comment when its node disappears; reanchor and resolve existing comments. |
| Export and restore | roundtrip, missing blob, interrupted import | Restore into a fresh destination with full history and blobs; reject damaged archives and preserve destination state on interruption. |
| Reconnect | draft offline, concurrent edit, reload resume | Keep a local draft through connection loss, handle a remote conflict, and recover the draft after reload. |
| Accessibility | keyboard loop, narrow large text, error announcement | Complete editing by keyboard, use the narrow enlarged view, and announce errors to assistive technology. |

## Run

From `canvas-demo` with Node 22+ and dependencies installed:

```sh
npm run eval:validate:inputs
npm run eval:run -- --corpus v2
```

The second command exits nonzero while product contracts are red. It prints the run directory, which contains `report.html`, case assertions, action results, event logs, and screenshots. Validate a produced bundle with:

```sh
npm run eval:validate -- <printed-run-directory>
```

Use `--case proposal-review/accept` to run one case. Set `CANVAS_EVAL_BROWSER_EXECUTABLE` to a local Chrome or Chromium binary when Playwright's bundled browser is unavailable.

## Baseline and implementation order

On 2026-09-26, the full v2 run produced **7 pass, 17 fail**. The seven passing cases are the three agent failure cases, the three coordinated change cases, and the orphaned comment case. The failing cases have valid evidence bundles; they are product gaps to address in TDD order:

1. Proposal staging and decision, then concurrent agent editing. These six cases define the review and conflict boundary.
2. Comment reanchor and resolve. The driver creates an actual comment before invoking the missing lifecycle API.
3. Fresh-store import, archive validation, and interrupted-import rollback. The driver compares destination state and history before and after import.
4. Connection state and draft persistence. The driver goes offline, performs a remote edit where relevant, and reloads the page.
5. Keyboard, narrow-viewport, and assistive error behavior.

The v1 corpus remains available with `--corpus v1`. Fix one product contract at a time, rerun the focused case, validate its evidence bundle, and rerun both corpora before considering the journey complete. Update each case expectation only when the intended product contract changes, not to make an observed failure pass.
