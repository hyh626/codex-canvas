# Canvas × Codex — runnable demo

A deliberately small, local-first Canvas implementation inside an unmodified Codex checkout.
Upstream baseline: `78245b47af2a7aafcabe025828ceecca69db4df1`.

## Run

Node.js 22+; the browser demo uses parse5 for HTML validation and requires no API key.

```sh
cd canvas-demo
npm ci --omit=dev
npm start
# Open http://127.0.0.1:4317
npm test
```

1. Edit a card's title/body/color in the inspector and click **Commit edit**.
2. Ask the mock agent `标题：一起把想法变成作品`, `change color`, or `add card`.
3. Click Undo/Redo. Ctrl/Cmd-Z works outside text fields; text fields retain native typing undo.
4. Add a comment anchored to a component and node. The next mock request includes it.
5. Click an event to inspect its raw payload. Export the trajectory; it includes all blobs.
6. Restart the server or open a second browser tab: both render the committed model.

More journeys: create/duplicate cards, direct canvas text editing, reorder, delete/restore, comment-to-agent handoff, and stale-draft conflict handling. Follow the [nine-step CUJ guide (中文)](CUJ.zh-CN.md).

## CUJ Playground

The browser now exposes six repeatable product scenarios: human node editing, comment-to-agent, shared human/agent Undo, component lifecycle, HTML node/layout editing, and audited model requests. **Load / restart** commits a deterministic fixture through the server and appends `scenario.started`; it never erases the trajectory. Step progress is derived from the committed model and subsequent events. `scenarios.mjs` is the shared source for fixtures, instructions and acceptance predicates, and a new scenario also scopes model context so earlier comments cannot leak into the run.

The proposed model-to-render evaluation bundle is specified in [eval/FORMAT.zh-CN.md](eval/FORMAT.zh-CN.md). It combines per-event replay outcomes with real UI checkpoints, independent expected models, iframe evidence, content-addressed screenshots and reviewable assertions. Render failures remain valid evidence and fail the case instead of making the bundle unwritable.

## What is authoritative in this MVP?

The **committed event chain and immutable snapshot blobs** are authoritative. Each snapshot
contains cards `{id, title, body, color}` or static HTML components `{id, kind: "html", html}`.
The HTML source in a committed snapshot is authoritative and editable through the API. The server is the only writer.
HTML and `canvas.json` under `.data/workspace/` are rebuildable projections. **Do not edit
those projected files directly**: restart intentionally reconstructs them from committed events.
This is a narrower implementation than the general HTML-file-first design discussed earlier.
Static HTML supports stable node IDs, leaf text edits, source edits, and inline layouts.
See [HTML CUJ and acceptance](HTML-CUJ.zh-CN.md); arbitrary HTML import is unsupported.

| Concern          | Implemented behavior                                                           |
| ---------------- | ------------------------------------------------------------------------------ |
| Identity         | Stable component ID and `title` / `body` node IDs                              |
| Manual edits     | One form submission = one validated transaction                                |
| Agent edits      | Proposal → validation → revision check → commit → UI event                     |
| Concurrency      | Optimistic revision check; stale writes fail with HTTP 409                     |
| Undo             | Append inverse snapshot as a new revision; redo keeps original target          |
| Durability       | Blob and event fsync before acknowledgment; replay on startup                  |
| Crash recovery   | Incomplete trailing JSONL preserved separately, committed prefix replayed      |
| Writer ownership | Exclusive lock file; a second process refuses to open the same store           |
| Export           | Exact JSONL bytes plus base64-encoded blobs; tested restore into a fresh store |
| Request audit    | Independent mock-request reconstruction from disk, deep equality + hash        |
| Request capture  | Full request snapshot OFF by default; explicit checkbox enables it             |
| HTML safety      | Supported text fields are escaped; UI inserts text with `textContent`          |

A stale `writer.lock` after a hard crash is deliberately not auto-stolen. Stop/verify the old
process is gone, then remove only `.data/writer.lock` before restarting. This is a local demo,
not a distributed lock or power-loss-safe database. Projection files can be briefly mixed during
materialization; API readers use committed memory, and startup repairs projections. Production
file readers need revision directories plus an atomic pointer, or a transactional database.

## Codex engine adapter

`codex.mjs` uses actual app-server JSONL protocol: initialize → thread/start → turn/start,
with a JSON output schema and an ephemeral read-only thread in a temporary directory. It
collects the final agent message as a proposal; it never grants the model a commit method.
The adapter uses the installed Codex binary by default. To use this fork's build, set
`CODEX_BIN` to its absolute executable path. It creates an isolated Codex home, disables
shell and web search, and configures a single audited HTTP provider. No user Codex config
or saved session is reused. A model proposes JSON; the application alone commits changes.

To enable the real provider path, configure these environment variables before `npm start`:

```sh
export CODEX_BIN=/absolute/path/to/codex
export CANVAS_MODEL=your-provider-model-id
export CANVAS_RESPONSES_URL=https://your-provider.example/v1/responses
# Set CANVAS_API_KEY securely in your local environment; do not put it in source control.
npm start
```

The URL above is a placeholder, not a configured service. Provider credentials never go to
the UI or event log. The gateway forwards credentials from the server environment, splits
actual Codex HTTP requests into content-addressed config/input fragments, independently
rebuilds them from disk, asserts equality with the outgoing descriptor/body, then forwards.
There is no audit bypass switch. Full request capture remains OFF by default. Response
stream chunks are persisted before forwarding so partial failures remain reviewable.

This demo supports **full-context, stateless Responses over HTTP only**. WebSocket,
remote conversation references, and unimplemented endpoints such as remote compaction are
rejected. Config sets `supports_websockets=false`; attempting an unsupported path fails
closed. This is not comprehensive support for every Codex feature or provider protocol.
Other providers must speak the same Responses protocol; native protocol conversion is a
separate adapter, with its own request verification boundary.

The app-server adapter is tested against a fake subprocess; the HTTP gateway against a local
mock provider, including a reconstruction mismatch that must not reach the provider. A live
Codex binary plus paid model has not been tested here. The default deterministic mock remains
immediately runnable without credentials. Real provider usage can incur normal API charges.

## Electron

The same browser UI and backend have an optional Electron entry point. Install the pinned dependencies with `npm ci` and run `npm run desktop`.
It stores its workspace in Electron `userData`, starts the backend on an ephemeral loopback
port, and disables renderer Node integration. macOS/Windows packaging, signing and installers
are not implemented or tested; backend HTTP behavior is verified. Browser cloud hosting also
requires real authentication, tenant isolation and a database before exposing the server.

## Implementation map and acceptance

- `store.mjs`: schema checks, single writer, snapshots, events, replay, undo, request assertions.
- `commands.mjs`: persistent, idempotent create/duplicate/delete/move/text commands.
- `server.mjs`: loopback HTTP API, session token, origin checks and live SSE updates.
- `public/`: dependency-free canvas, inspector, comments, trajectory and engine selection.
- `codex.mjs`: replaceable app-server adapter.
- `gateway.mjs`: Responses HTTP request verification and response-byte persistence.
- `test/`: restart/replay, stale write rejection, retries, undo/redo, blob tampering,
  exact archive roundtrip, HTTP loop, and fake app-server protocol coverage.

49 Node integration/unit tests pass, including eval schema and semantic-validation fixtures, CUJ fixture/context isolation, HTML HTTP editing, layout, conflict, restart,
and shared Codex/DSH protocol fixtures. The Electron CUJ script is provided with Linux/macOS/Windows CI.
Local Electron crashed with SIGSEGV before opening its first window; desktop UI and real-model
acceptance remain unverified. No upstream Rust files changed. Repository `just fmt` was attempted
but requires Cargo and DotSlash, unavailable here. Node tests use snapshot assertions, not Rust `insta`.
See the HTML CUJ document for commands and limitations.

## Next coherent stages

1. Extend the current static HTML subset to broader markup, assets and schema migrations.
2. Broader Codex coverage: live provider fixtures, WS and compaction verification;
   keep unsupported paths fail-closed.
3. Desktop release: package/sign on macOS and Windows, then test lifecycle and upgrades.

## Engine protocol / DSH adapter

See [Canvas Engine Protocol v1](ENGINE-PROTOCOL.zh-CN.md) for the Codex/DSH boundary, configuration, request audit, lifecycle, and shared CUJ fixtures. DSH is experimental. The default is still mock; see the runtime validation record below for the verified scope.

## Runtime validation update · 2026-09-20

[真实 runtime 验收记录](validation/RESULTS.zh-CN.md)：DSH 0.1.5-rc.2 已通过真实进程 + 本地模拟 provider 的请求重建、capture、proposal 与事务检查。Codex 0.155.1 握手通过，但 thread/start 被当前环境的 Bubblewrap 权限限制阻挡。真实模型仍未测试；此记录更新上文关于 runtime 尚未验证的状态。
