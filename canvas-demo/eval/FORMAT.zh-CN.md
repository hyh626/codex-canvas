# Canvas model-to-render eval artifact v1.5

状态：格式设计。v1.5 完成 gate 提前退出、失败 capture 的未知 cutoff，并加入跨文件 semantic validator。

## 1. Eval 要回答什么

一个完整 case 分别判断：

1. actions 是否产生了预期 event，失败操作是否保持预期状态；
2. trajectory 能否无损重放为每一个 event 后的 data model；
3. renderer 是否把该 model 正确投影成 DOM、iframe 和 Canvas；
4. 真实用户交互期间的 draft、loading、conflict、error、selection 是否正确；
5. 固定 Chrome、字体与 viewport 后是否存在视觉回归；
6. 页面是否满足可读性、层级、留白、溢出和交互反馈等质量要求。

逐 event replay 和真实 UI interaction 是两类证据。前者定位 event/reducer/renderer 问题，后者验证用户真正看到的中间状态。二者共用生产 `render(view)`，但分开记录 coverage 和结果。

## 2. 权威边界

| 层 | 内容 | 性质 |
| --- | --- | --- |
| Case input | `case.json`、`expectations.json`、`actions.jsonl` | 本次 eval 的独立输入和预期 |
| Execution result | `action-results.jsonl` | action 的状态、返回值及实际产生的 event IDs |
| Trajectory | `events.jsonl`、事件引用的 blobs | 本次运行的业务事实，可字节级审阅 |
| Capture outcome | `captures.jsonl` | event replay 或 live checkpoint 的成功/失败证据 |
| Artifacts | model、UI state、DOM、iframe DOM/layout、accessibility、console、PNG | 内容寻址的观测数据；只有 replay 产物可由 trajectory 精确重建 |
| Assertions | `assertions.jsonl` | actual 与独立 expectation/baseline 的比较结果 |

Replay checkpoint 不是第二个业务权威来源。它只是“该 runner 在这个 event 后重建出了什么”的证据，必须与 `expectations.json` 比较。

关键规则：

- 原始 trajectory 永远保留，不因测试确定性而重写 event ID 或 timestamp。
- trajectory 中每个 event 恰好有一个 `event_replay` capture outcome。
- outcome 可以是 `ok`、`timeout`、`render_error` 或 `blocked`。失败时允许没有截图，但必须保存错误和已经取得的部分证据。
- `live_checkpoint` 记录真实 UI 的 before/during/after/conflict/error 状态；没有 event 的拒绝操作也可以留下完整证据。
- event 没有改变 model 或画面时仍保留 outcome；内容相同的 artifact 可以复用 SHA-256 对象。
- 截图、DOM 和 assertion 不写回业务 event log，也不能进入下一次 model request。

## 3. Bundle 目录

```text
eval/runs/<run-id>/
  run.json
  cases/
    <scenario-id>/<example-id>/
      case.json
      inputs/
        expectations.json
        actions.jsonl
      execution/
        action-results.jsonl
        id-aliases.json
      trajectory/
        events.jsonl
        blobs/sha256/<hash>
      observations/
        captures.jsonl
      artifacts/
        sha256/<hash>
      results/
        assertions.jsonl
        summary.json
  index.json
  report.html
```

每个 case 可单独复制、校验和重跑。`artifacts/sha256/<hash>.<ext>` 保存原始 bytes；文件名中的 SHA-256 仍是内容地址，扩展名由 `media_type` 推导，仅用于让浏览器和 GitHub 正确识别 MIME。引用对象携带 `sha256`、`path`、`media_type` 和 `size_bytes`；validator 会同时校验路径安全性、文件大小和内容哈希。`report.html` 是可删除、可重建的浏览器报告。

## 4. `run.json`

Schema：[run.schema.json](schema/run.schema.json)。一个 run 一次性执行 6 × 3 = 18 个 case，避免把不同环境的结果混在一起。

```json
{
  "format": "canvas-render-eval-run-v1",
  "run_id": "2026-09-20T18-30-00Z_7e1a112_chrome-154",
  "created_at": "2026-09-20T18:30:00.000Z",
  "source": {
    "repository": "https://github.com/hyh626/codex-canvas",
    "commit": "7e1a112f11f8389b5e6046b499943fa982cfaf4e",
    "dirty": false,
    "model_schema": "urn:canvas-demo:model:v1",
    "event_schema_version": 1
  },
  "runtime": {
    "runner": "canvas-render-eval/0.1.0",
    "node": "22.20.0",
    "browser": { "name": "chromium", "version": "154.0.0", "headless": true },
    "os_image": "canvas-eval-linux-amd64@sha256:<digest>",
    "locale": "en-US",
    "timezone": "UTC",
    "color_scheme": "light",
    "reduced_motion": "reduce",
    "fonts": ["Inter@<sha256>", "Noto Sans SC@<sha256>"]
  },
  "defaults": {
    "viewport": { "width": 1440, "height": 1000, "device_scale_factor": 1 },
    "surfaces": ["app", "canvas"],
    "capture_modes": ["event_replay", "live_checkpoint"],
    "event_capture_phase": "after_event",
    "comparison": {
      "raw_trajectory": "byte-exact-within-run",
      "cross_run": "semantic-fingerprint-plus-render-artifacts"
    }
  }
}
```

Runner 关闭 animation/caret，等待主文档与 iframe 字体，固定 locale/timezone/viewport。业务 event timestamp 原样保存。跨运行不要求原始 trajectory bytes 相同，因为 UUID、timestamp 和 duration 合法变化。

## 5. `case.json`

Schema：[case.schema.json](schema/case.schema.json)。case 只描述执行环境和文件关系，不内联实际输出。

```json
{
  "format": "canvas-render-eval-case-v1",
  "case_id": "human-edit/nominal",
  "scenario_id": "human-edit",
  "example_id": "nominal",
  "title": "Edit a short title",
  "seed": 1101,
  "generation": { "mode": "execute_actions", "parameterized_scenario": true },
  "viewport": { "width": 1440, "height": 1000, "device_scale_factor": 1 },
  "view_policy": {
    "selected_component_id": "welcome",
    "selected_scenario_id": "human-edit",
    "open_panel": "none",
    "focus": null,
    "scroll": { "app_x": 0, "app_y": 0, "canvas_x": 0, "canvas_y": 0 }
  },
  "paths": {
    "expectations": "inputs/expectations.json",
    "actions": "inputs/actions.jsonl",
    "action_results": "execution/action-results.jsonl",
    "events": "trajectory/events.jsonl",
    "trajectory_blobs": "trajectory/blobs/sha256",
    "id_aliases": "execution/id-aliases.json",
    "captures": "observations/captures.jsonl",
    "artifacts": "artifacts/sha256",
    "assertions": "results/assertions.jsonl",
    "summary": "results/summary.json"
  },
  "oracles": {
    "structural": true,
    "visual_regression": { "enabled": false, "baseline_manifest": null },
    "visual_quality": { "enabled": true, "rubric_version": "canvas-quality-v1", "blocking": false }
  },
  "reproducibility": {
    "semantic_fingerprint": "<64 lowercase hex>",
    "generated_id_strategy": "deterministic-provider",
    "volatile_event_fields": ["/event_id", "/session_id", "/timestamp"]
  }
}
```

`view_policy` 固定 selection、panel、focus 与 scroll；action checkpoint 可以显式覆盖。Baseline 不用 `main/...` 之类的可变名字，而是引用一个不可变、内容寻址的 manifest。首轮尚无人工批准 baseline 时必须设为 `enabled:false`。

## 6. 独立的 `expectations.json`

Schema：[expectations.schema.json](schema/expectations.schema.json)。这是避免“renderer 忠实显示错误 model 也通过”的核心。

```json
{
  "format": "canvas-render-eval-expectations-v1",
  "case_id": "human-edit/nominal",
  "initial_model": {
    "components": [{
      "id": "welcome",
      "title": "Build something together.",
      "body": "Double-click this title to begin.",
      "color": "#6366f1"
    }]
  },
  "checkpoints": [{
    "checkpoint_id": "scenario-loaded",
    "after_action_id": "load-scenario",
    "expected_action_status": "succeeded",
    "expected_events": {
      "sequence": ["scenario.started", "workspace.edit_committed"],
      "allow_additional": false
    },
    "expected_model": {
      "components": [{
        "id": "welcome",
        "title": "Build something together.",
        "body": "Double-click this title to begin.",
        "color": "#6366f1"
      }]
    },
    "invariants": [],
    "live_checkpoints": [{
      "phase": "after",
      "expected_ui": { "running": false, "status": { "tone": "success" } },
      "invariants": [
        { "scope": "ui", "operator": "equals", "path": "/running", "value": false }
      ]
    }]
  }, {
    "checkpoint_id": "title-edited",
    "after_action_id": "edit-title",
    "expected_action_status": "succeeded",
    "expected_events": {
      "sequence": ["workspace.edit_committed"],
      "allow_additional": false
    },
    "expected_model": {
      "components": [{
        "id": "welcome",
        "title": "Start your project",
        "body": "Double-click this title to begin.",
        "color": "#6366f1"
      }]
    },
    "invariants": [
      { "scope": "model", "operator": "unchanged", "path": "/components/0/id", "compare_to": "model_pre_action" },
      { "scope": "model", "operator": "unchanged", "path": "/components/0/body", "compare_to": "model_pre_action" }
    ],
    "live_checkpoints": [{
      "phase": "before",
      "expected_ui": { "focus": "component:welcome/title" },
      "invariants": []
    }, {
      "phase": "after",
      "expected_ui": { "focus": null, "dirty": false },
      "invariants": [
        { "scope": "ui", "operator": "equals", "path": "/dirty", "value": false }
      ]
    }]
  }],
  "final_checkpoint_id": "title-edited"
}
```

每个 `expected_model` 都由 fixture 作者写入并接受 `model.schema.json` 校验，不能从本次实际 trajectory 生成。`live_checkpoints[].expected_ui` 是允许的 UI state 子集，实际完整对象由 [ui-state.schema.json](schema/ui-state.schema.json) 校验。

Invariant 的操作数是强类型语义：`equals`、`contains`、`count-equals` 必须带 `value`；`count-equals.value` 是非负整数；`unchanged` 不带 `value`。model 的 `unchanged` 必须使用 `model_pre_action`、`previous_model_checkpoint` 或 `initial_model`；UI 的 `unchanged` 必须使用 `pre_action_ui` 或 `previous_live_checkpoint`。`scope:event` 或 `scope:request` 还必须用 `event_match.type`、`event_match.occurrence` 以及 `event_scope` 指定匹配事件类型、`first`/`last`/`all`/`exact_one` 和搜索范围。成功的 live capture 保存非空 `trigger.action.event_seq_at_capture` 和 `event_seq_after_capture`：runner 分别在 `capture_started` 与 `capture_finished` 从 authoritative store 读取 trajectory tail，两者必须相同。若后者更大，capture 必须记为 `blocked` 并原样保存两个 cutoff；authoritative tail 不允许倒退。失败 outcome 在无法读取 store 时允许省略这两个 cutoff 或写 `null`。`current_action` 搜索 action result 所引用且 `seq <= event_seq_at_capture` 的实际 event IDs，`case_through_checkpoint` 搜索 case 起点至该上界。这样 `during` capture 不能意外匹配 gate release 后才产生的 commit。`first`/`last` 按该范围的 event seq 取一条，`all` 要求至少一条且逐条成立，`exact_one` 先断言恰好一条再求值。例如 request audit 对唯一一条 `model.request_prepared` 的 `/payload/verification/assert` 要求 `equals:true`，写成：

```json
{"scope":"request","operator":"equals","path":"/payload/verification/assert","value":true,"event_match":{"type":"model.request_prepared","occurrence":"exact_one"},"event_scope":"current_action"}
```

Playground 里当前写死的 `scenarioProgress()` 只用于产品演示。Eval 不复用这些具体字符串判断。18 个 example 的 fixture、actions、expected models 与 invariants 全部参数化；CUJ 只共享高层 invariant。

## 7. `actions.jsonl` 与 `action-results.jsonl`

Schemas：[action.schema.json](schema/action.schema.json)、[action-result.schema.json](schema/action-result.schema.json)。

```jsonl
{"schema_version":1,"action_id":"load-scenario","step":1,"kind":"load_scenario","driver":"ui","input":{"scenario_id":"human-edit","fixture_source":"expectations.initial_model"},"expectation_checkpoint_id":"scenario-loaded","live_capture_points":[{"phase":"after","ready_when":{"signal":"render_idle"}}]}
{"schema_version":1,"action_id":"edit-title","step":2,"kind":"set_text","driver":"ui","input":{"component_id":"welcome","node_id":"title","text":"Start your project"},"expectation_checkpoint_id":"title-edited","live_capture_points":[{"phase":"before","ready_when":{"signal":"selector_visible","selector":"[data-node-id=title]"}},{"phase":"after","ready_when":{"signal":"render_idle"}}]}
{"schema_version":1,"action_id":"generate-copy","step":3,"kind":"generate_copy","driver":"ui","input":{"component_id":"welcome"},"expectation_checkpoint_id":"copy-generated","live_capture_points":[{"phase":"during","ready_when":{"signal":"loading_visible"},"response_gate":{"name":"generate-copy-response","pause_at":"before_model_commit","release":"after_capture"}},{"phase":"after","ready_when":{"signal":"render_idle"}}]}
```

对应 result：

```jsonl
{"schema_version":1,"action_id":"edit-title","step":2,"status":"succeeded","http_status":200,"emitted_events":[{"seq":4,"event_id":"<uuid>","type":"workspace.edit_committed"}],"capture_ids":["human-edit/nominal@edit-title-before","human-edit/nominal@edit-title-after"],"duration_ms":42}
```

Result 允许 `emitted_events:[]`。例如 stale edit 得到 409 且不产生 commit，仍可通过 conflict screenshot、error text 与 model unchanged 断言完成验证。每个 `capture_ids` 项必须指向 `captures.jsonl` 中属于同一 action 的 live checkpoint outcome；event replay 不写入 action result。

带 `during` point 的 action result 必须保存 append-only gate lifecycle observation。每项有单调递增的 `ordinal`。正常 capture 或 capture timeout 依次包含 `gate_armed`、`gate_paused`、成对且同 ID 的 `capture_started`/`capture_finished`、最后一个 observation `gate_released`。所有 capture observation 必须位于 pause 和 terminal 之间。只有 `released` 状态保存 `release_reason`；暂停后取消或 runner error 可以直接从 `gate_paused` 到 `gate_released`。Provider 在 gate 前失败时只能记录 `gate_armed`，result 使用 `not_reached` 并保存 gate error。若 runner 在尝试 release 前中断，`paused` 保存实际 lifecycle 前缀：`gate_armed`、`gate_paused`，其后可以有完整 capture 对，并允许最后留下一个 `capture_started`。如果 outcome 尚未落盘，该 ID 不出现在 `capture_ids`；如果 outcome 已先写入 `captures.jsonl`，action result 必须在 `capture_ids` 中引用它，即使 `capture_finished` observation 尚未来得及 append。两种情况都表示 incomplete run，不能补写虚假的 observation。暂停后释放失败以最后一个 observation `gate_release_failed` 结束并使用 `release_failed`，不能伪装成正常 released。

Gate ordinal 只表示 runner observation 的因果顺序，不与业务 event seq 比较。`event_seq_at_capture` 来自 authoritative store；`evidence.stability.renderer_seq` 是浏览器最后完整应用的 event seq；live `state.events_through_seq` 必须等于 renderer seq，并且 renderer seq 不得超过 authoritative cutoff。Bundle validator 验证 ordinal、capture ID、event cutoff 和 renderer/model seq 这两组独立关系。例如：

```jsonl
{"schema_version":1,"action_id":"generate-copy","step":3,"status":"succeeded","emitted_events":[{"seq":5,"event_id":"<uuid>","type":"workspace.edit_committed"}],"capture_ids":["human-edit/nominal@generate-copy-during"],"duration_ms":42,"gate":{"name":"generate-copy-response","pause_at":"before_model_commit","status":"released","release_reason":"captured","observations":[{"ordinal":1,"phase":"gate_armed"},{"ordinal":2,"phase":"gate_paused"},{"ordinal":3,"phase":"capture_started","capture_id":"human-edit/nominal@generate-copy-during"},{"ordinal":4,"phase":"capture_finished","capture_id":"human-edit/nominal@generate-copy-during"},{"ordinal":5,"phase":"gate_released"}]}}
```

输入禁止保存 token、cookie、API key 或环境变量。模型可见输入仍遵守现有 event/blob request audit 约束。

## 8. 原始 trajectory

`events.jsonl` 直接使用现有 event envelope，不创建第二套 event schema。Bundle writer 遍历所有 event payload，复制 blob 引用的完整闭包，包括 snapshot、delta、request config/items/body 与 response chunks。

Action result 保存 action→event IDs 的实际对应关系；event 的 `caused_by` 继续表达业务因果关系。两者用途不同，不能互相替代。

随机生成的 ID 仍保存在原始 trajectory。用于跨运行语义比较时，runner 生成通过 [id-aliases.schema.json](schema/id-aliases.schema.json) 校验的双射：先把每个 `event_id` 和 `payload.command_id` 映射成稳定 alias，再用同一张表改写 `caused_by`、`payload.target`、`payload.request_event_id` 和 `payload.command_id`。同一个 command ID 的 retry 必须映射为同一个 command alias；不同命令不能合并。runner 再验证每条引用边指向存在且更早的 event。`caused_by` 不是 volatile field，不能删除或忽略；规范化后的因果图必须与预期完全一致。

`payload.fingerprint` 包含 event reference 时不能直接比较原始 hash。语义比较在 canonical projection 上重算 fingerprint，再与同样规则下的 expected projection 比较；原始 bytes 和原始 fingerprint 仍保留作审计。新增引用路径或依赖引用的派生值时，必须把路径列入 alias manifest，不能靠人工约定遗漏它。

Alias 只用于语义 fingerprint 和结构比较，不能改写输入 renderer 的 model/event，也不能改写截图。启用 pixel baseline 的 case 必须注入 deterministic ID provider；无法注入时只允许做语义比较和非 baseline 的视觉质量检查。

## 9. `captures.jsonl`

Schema：[capture.schema.json](schema/capture.schema.json)。每一行是 capture outcome。

成功的 event replay：

```json
{
  "schema_version": 1,
  "capture_id": "human-edit/nominal@event-000004",
  "case_id": "human-edit/nominal",
  "mode": "event_replay",
  "status": "ok",
  "trigger": {
    "event": {
      "seq": 4,
      "event_id": "<uuid>",
      "type": "workspace.edit_committed",
      "phase": "after_event"
    }
  },
  "state": {
    "events_through_seq": 4,
    "revision": 2,
    "model": { "sha256": "<hash>", "size_bytes": 144, "media_type": "application/json" },
    "model_hash": "<hash>",
    "ui_state": { "sha256": "<hash>", "size_bytes": 177, "media_type": "application/json" }
  },
  "evidence": {
    "stability": {
      "renderer_seq": 4,
      "fonts_ready": true,
      "pending_requests": 0,
      "animation_frames_waited": 2,
      "iframes_expected": 0,
      "iframes_ready": 0
    },
    "captures": [
      { "surface": "app", "artifact": { "sha256": "<hash>", "size_bytes": 183214, "media_type": "image/png" }, "width": 1440, "height": 1000 },
      { "surface": "canvas", "selector": "#canvas", "artifact": { "sha256": "<hash>", "size_bytes": 68201, "media_type": "image/png" }, "width": 780, "height": 520 }
    ],
    "dom": { "sha256": "<hash>", "size_bytes": 9321, "media_type": "text/html" },
    "accessibility": { "sha256": "<hash>", "size_bytes": 4711, "media_type": "application/json" },
    "console": { "sha256": "<hash>", "size_bytes": 2, "media_type": "application/json" },
    "iframes": []
  }
}
```

失败 outcome：

```json
{
  "schema_version": 1,
  "capture_id": "html-component/boundary@event-000006",
  "case_id": "html-component/boundary",
  "mode": "event_replay",
  "status": "timeout",
  "trigger": {
    "event": {
      "seq": 6,
      "event_id": "<uuid>",
      "type": "workspace.edit_committed",
      "phase": "after_event"
    }
  },
  "error": {
    "stage": "stability",
    "name": "IframeReadyTimeout",
    "message": "Expected 1 iframe; 0 reached ready state in 5000 ms"
  },
  "evidence": {
    "console": { "sha256": "<hash>", "size_bytes": 318, "media_type": "application/json" },
    "iframes": [{
      "component_id": "html-preview",
      "selector": "iframe[data-component-id=html-preview]",
      "status": "timeout",
      "error": { "name": "IframeReadyTimeout", "message": "load did not fire" }
    }]
  }
}
```

合法记录与通过结果分开：这个失败 outcome 满足 schema 和 event coverage，但 required assertion 必须失败，case status 仍是 fail。失败 outcome 只要求顶层 `error`；`state`、`stability` 与 `evidence` 的每个字段都可独立保存，writer 不得因为后续步骤失败而丢弃已经取得的 model、console、DOM 或截图。成功 outcome 才要求完整的 state、stability、app/canvas screenshots、DOM、accessibility、console 和 iframe 列表；ready iframe 必须有 DOM/layout，timeout/error iframe 必须有自己的 error，并可附带部分 DOM/layout。

## 10. 两类 capture

### 10.1 `event_replay`

Runner 使用专用只读数据源，一次只向生产 reducer 提交一个 event，等待 `renderedSeq`，然后采证。它用于检查 event→model→renderer，不声称模拟用户真实操作时间线。

### 10.2 `live_checkpoint`

Playwright 通过真实 UI 操作，在 action 声明的 phase 截图：

- `before`：输入已填写、尚未提交；
- `during`：Agent loading 或 async pending；
- `after`：服务端响应后稳定状态；
- `conflict`：409、草稿保留与 rebase affordance；
- `error`：请求失败后的页面反馈。

用户编辑、Agent loading、Undo、stale draft 和错误提示必须由 live checkpoint 覆盖。只用 API 生成 trajectory 的 case 不能宣称 UI interaction coverage。

每个 capture point 都必须声明 `ready_when`，runner 在该信号成立后采证。`during` 还必须声明结构化 `response_gate`：`pause_at` 固定为 `before_model_commit`，`release` 固定为 `after_capture`。执行顺序固定为：runner arm gate 并等待 gate-ready acknowledgement，触发 UI action；gateway/engine 已取得 proposal 但在 `store.commit` 前停住；runner 等待 loading 或指定 selector 可见，采集 UI state/DOM/screenshot；无论采集成功、超时还是取消，都在 `finally` 中 release gate，之后才允许 commit 和 `after` capture。`during` 不允许 `render_idle`，避免待处理请求与 idle 条件互相等待。

当前 mock adapter 的 gate 放在 proposal 已生成、`workspace.edit_committed` 尚未 append 的位置；Codex 与 DSH adapter 也必须暴露同一阶段。action result 记录 gate name、lifecycle observations 和 release reason；bundle validator 校验 `during` capture 位于 pause 与 terminal observation 之间。用于事件推送的长连接（包括 `/api/stream` EventSource）从 `pending_requests` 和 network-idle 计算中排除；业务请求和 iframe 请求仍计入。

UI state 是运行时观测，而不是从 model 猜出的字段。内容寻址对象必须通过 [ui-state.schema.json](schema/ui-state.schema.json)，至少记录 selection、scenario、panel、focus、双层 scroll、dirty/running、connection、dialogs、status 和 undo/redo/run controls。它还必须记录 `editor`：mode、draft 的 component/node/base revision/value、inline error 与 rebase affordance。这样 stale-edit CUJ 可以断言“Revision conflict”出现时，用户输入的草稿仍等于预期值。Expectation 可以匹配其子集，完整观测保留在 artifact 中。

Live checkpoint 不能从 trajectory 精确重建：draft、focus、loading、瞬时 conflict 可能从未成为业务 event。重新执行相同 actions 会产生一次新的 observation，可用于复验，但不能冒充原 capture。只有 event replay 的 model/DOM/render artifact 才可由保存的 trajectory 和固定 renderer 重算并逐 hash 验证。

## 11. HTML iframe 证据

主页面 `document.fonts.ready` 和两个 animation frame 不足以证明 `srcdoc` iframe 已完成渲染。每个成功 capture 必须：

1. 统计当前 model 预期的 iframe 数；
2. 等待每个 iframe 的 `load`、`contentDocument.readyState`、iframe 内字体和至少两个 animation frame；
3. 保存 iframe DOM 与 layout artifact；
4. 检查 `data-node-id` 唯一性、文本、scrollWidth/clientWidth、scrollHeight/clientHeight、零尺寸与裁切；
5. 在 stability 中记录 `iframes_expected` 和 `iframes_ready`。

HTML boundary example 专门覆盖长列表、窄 viewport 与当前固定 350px iframe 高度。父页面 DOM 与 Canvas PNG 之外，iframe 内证据是 required oracle。

## 12. Assertions 与视觉判断

Schema：[assertion.schema.json](schema/assertion.schema.json)。Assertion 可以指向 capture、action 或整个 case，并显式声明是否阻断。

```jsonl
{"schema_version":1,"assertion_id":"model-title-after-edit","case_id":"human-edit/nominal","subject":{"action_id":"edit-title"},"oracle":"model","name":"expected-model","required":true,"status":"pass","actual":{"title":"Start your project"},"expected":{"title":"Start your project"}}
{"schema_version":1,"assertion_id":"event-6-capture","case_id":"html-component/boundary","subject":{"capture_id":"html-component/boundary@event-000006"},"oracle":"iframe","name":"iframe-ready","required":true,"status":"fail","actual":{"ready":0},"expected":{"ready":1},"message":"Iframe did not stabilize"}
```

Gate 分三层：

1. **结构正确性，required**：独立 expected model、event sequence、revision chain、DOM/iframe 投影、console、accessibility、overflow/clipping。
2. **视觉回归，baseline 建立后 required**：固定环境下 app/canvas crop 对 immutable baseline manifest 做 pixel diff + SSIM；更新 baseline 必须人工 review。
3. **视觉质量，v1 非阻塞**：hierarchy、spacing、typography、color、composition、长文本与多组件韧性。先使用确定性 layout/contrast 检查和人工批准 golden；VLM reviewer 必须保存 model/version、audited request、response 与 rubric。

Screenshot 相同只能证明没有视觉回归，不能证明设计美观。Expected model 相同只能证明业务结果正确，不能证明 renderer 正确。两类 oracle都需要。

## 13. 18 个参数化 examples

| CUJ | nominal | content-variant | boundary |
| --- | --- | --- | --- |
| `human-edit` | 短英文标题 | 中英混排标题 | 接近 120 字符的多行标题 |
| `comment-agent` | title comment → agent | agent 按 comment 修改预期字段 | 长 comment、anchor 保持稳定 |
| `shared-undo` | human edit → agent edit → undo ×2 | color + title 两种改动 | 多行内容下 undo/redo UI |
| `component-lifecycle` | duplicate → move → delete | 三组件不同颜色和文本 | 接近 8 个组件上限 |
| `html-component` | leaf text → horizontal layout | 中英 HTML 文本 | 长列表、窄 viewport、iframe 裁切 |
| `audited-request` | capture on + color change | capture off + title change | request event 不改 model、timeline 更新 |

每个 example 保存独立 fixture 和 checkpoint models。`human-edit` 不再绑定固定字符串；`audited-request` 的 capture-off 通过 `body absent` expectation；需要修改 body 的 case 必须使用真实存在的 operation，不能假设 mock agent 已支持。

## 14. 确定性与跨运行比较

同一次 run 内：

- 原始 event/blobs 必须保持字节不变；
- artifact ref 必须通过 hash 与 size 校验。

跨运行：

- 用 initial model + normalized actions + expectations + renderer config 计算 `semantic_fingerprint`；
- 只忽略声明过的 `/event_id`、`/session_id`、`/timestamp`；
- 比较 checkpoint expected/actual、规范化 event semantics 与固定环境下的 render artifacts；
- duration 只用于性能趋势，不参与相等判断。

生成 ID 优先采用测试专用 deterministic UUID provider。若无法注入，bundle 保存 alias map，语义比较时对定义、全部引用和依赖引用的派生 fingerprint 做一致的 canonical projection。原始 event、renderer 输入和截图不改写。Semantic alias fallback 不具备 pixel baseline 资格。

## 15. Run 级 invariants

Runner 结束前验证：

跨文件和时序约束由 [validate-semantics.mjs](validate-semantics.mjs) 执行；JSON Schema 只负责单个 JSON/JSONL record 的结构。报告生成前必须同时通过两层验证。完整 bundle 校验默认要求每个 live capture 都能反向找到 owner action result；单元测试若只传入一个 record，必须显式设置 `allow_partial_bundle:true`，该选项不能用于报告生成或 acceptance gate。

1. 恰好 6 个 scenario，每个恰好 3 个 example；
2. action step 连续、ID 唯一，并且每个 action 恰好一个 result；
3. 每个 expectation checkpoint 恰好被一个 action 引用；
4. event seq 连续，action result 引用的 event 存在且顺序正确；
5. alias map 是一对一映射，`event_id`、`caused_by`、undo/redo `payload.target`、request `payload.request_event_id` 和 `payload.command_id` 都可解析；retry 保持同一 command alias，且规范化前后的因果图同构；依赖这些引用的 fingerprint 在 canonical projection 上重算；
6. 每个 event 恰好一个 `event_replay` outcome，无论 outcome 成功或失败；
7. expectation 要求的 live checkpoint 全部存在，实际 UI artifact 通过 UI state schema；
8. 所有 blob/artifact ref 的文件、size 和 SHA-256 匹配；
9. 成功 capture 的 model hash 与 canonical model bytes 匹配；
10. expected/actual model 都通过 `model.schema.json`；
11. HTML capture 的 iframe 计数、ready 状态和内部证据完整；
12. `status:pass` 时 event/live coverage 都 complete、failed capture 与 required failure 都为零、failures 为空；bundle validator 从磁盘重算这些计数；
13. 所有 required assertion 均 pass，case 才能 pass；
14. `index.json` 汇总数与磁盘内容一致。

Coverage complete 与 test pass 是两个字段。一个 event 对应一个合法 timeout outcome 时 coverage complete，但 test fail。

## 16. Summary 与 report

```json
{
  "format": "canvas-render-eval-summary-v1",
  "case_id": "human-edit/nominal",
  "status": "pass",
  "coverage": {
    "events": { "expected": 4, "captured": 4, "complete": true },
    "live_checkpoints": { "expected": 3, "captured": 3, "complete": true }
  },
  "counts": {
    "actions": 2,
    "captures_ok": 7,
    "captures_failed": 0,
    "assertions": 31,
    "required_failed": 0
  },
  "final": { "event_seq": 4, "revision": 2, "model_hash": "<hash>" },
  "timing_ms": { "execute": 83, "replay_render": 1124, "oracles": 217 },
  "failures": []
}
```

HTML report 默认显示 18 个 case 的 coverage 与 pass/fail。Case 页面把 action、实际 events、event replay、live checkpoints 和 assertions 按时间对齐；失败 capture 显示错误与最后取得的部分证据；图片按 hash 懒加载。

Browser、server 或 fixture 在第一个 model/event 产生前失败时仍要写合法 summary：`status` 为 `fail` 或 `incomplete`，`final:null`，并保存 `failure_stage` 与 `run_error`。`status:pass` 必须有非空 `final`。业务或 assertion 失败如果已经得到最终 model，则继续保存正常的 `final`，不要把它清空。

```json
{
  "format": "canvas-render-eval-summary-v1",
  "case_id": "human-edit/startup-failure",
  "status": "incomplete",
  "coverage": {
    "events": { "expected": 0, "captured": 0, "complete": false },
    "live_checkpoints": { "expected": 0, "captured": 0, "complete": false }
  },
  "counts": { "actions": 0, "captures_ok": 0, "captures_failed": 0, "assertions": 0, "required_failed": 0 },
  "final": null,
  "failure_stage": "setup",
  "run_error": { "name": "BrowserLaunchError", "message": "Chromium did not start" },
  "timing_ms": { "execute": 0, "replay_render": 0, "oracles": 0 },
  "failures": []
}
```

## 17. 与现有 export 的关系

当前 `/api/export` 的 `canvas-demo-archive-v1` 足够保存业务 trajectory。转换流程是：

```text
parameterized fixture + expectations + actions
  -> 真实 UI/API execution + action-results + live checkpoints
  -> canvas-demo-archive-v1
  -> 展开原始 events/blobs 并校验闭包
  -> 逐 event replay + capture outcomes
  -> assertions + summary + report
```

Replay 使用与生产 SSE 相同的 reducer/renderer，只替换输入节奏。SSE 页面一次收到最终 `store.view()` 时可能跳过中间 event，所以不能用连续 SSE 截图冒充逐 event replay。

## 18. 实现顺序与首个 vertical slice

1. 参数化 scenario fixture 与 expectation，保留 Playground 的产品文案层。
2. 把 `render(view)` 抽成生产 SSE 与 eval replay 共用入口。
3. 增加只读 replay driver，以及 iframe/main document readiness handshake。
4. 实现 action/result writer、capture outcome writer 和内容寻址 artifact store。
5. 先跑一条 `human edit → agent edit → undo → stale conflict` vertical slice，同时生成 event replay 和 live checkpoints。
6. 加入 expected model/event/UI、DOM/iframe/layout/console assertions。
7. 扩展到 18 条 trajectory，再人工批准第一套 immutable visual baseline。
8. 最后生成静态 HTML report；VLM aesthetics reviewer 后置。

首个实现 PR 的验收标准：vertical slice 能在成功、启动失败和故意 iframe timeout 三种情况下产生 schema-valid bundle；失败 capture 保留已经取得的部分证据；timeout bundle coverage 完整但 status 为 fail。删除 replay-derived artifacts 后，可以从 inputs + trajectory 重建并逐 hash 验证 event replay；live checkpoints 作为不可重建的历史观测必须随 bundle 保留，重跑 actions 只能生成一组新的 observation。
