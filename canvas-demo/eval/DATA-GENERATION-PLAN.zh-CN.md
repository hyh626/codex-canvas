# Canvas E2E Eval 数据构造计划

状态：输入语料（G0–G8）和 G9 headless runner 已实现；G10 corpus promotion 仍待人工批准 baseline。目标读者是负责逐批生成 fixture 的小模型，以及实现 runner、审核结果的人。

当前仓库已经落地：

- `cases/v1/` 下 18 个产品 case（每个 scenario 3 个 example），含 `spec.json`、`fixture.json`、`expectations.json`、`actions.jsonl` 和可校验的 `case.json`。
- `fault-corpus/v1/` 下 9 个 schema-valid fault profile 和 3 个必须被 semantic validator 拒绝的 mutation fixture。
- `generate-cases.mjs` 是确定性 compiler；重复执行会生成相同字节，Node 测试会校验数量、schema、模型合法性、checkpoint/action 对齐和 fault manifest。
- `run.mjs` 使用容器 Chromium 执行真实 HTTP/UI action、response gate、逐 event replay 和 live checkpoint，生成完整 bundle 与 `report.html`。
- `validate-run.mjs` 离线校验所有 schema、跨文件语义、artifact 引用、SHA-256 和 size；`test/eval-runner.test.mjs` 每次运行一个真实 Chromium vertical slice。

输入文件不伪造 action result、trajectory、DOM、PNG、blob 或 summary；这些产物只由 G9 runner 实际执行后写入 `runs/`。本地运行：

```bash
npm run eval:generate
npm run eval:run -- --run-id local-full
npm run eval:validate -- eval/runs/local-full
```

## 1. 目标与边界

首轮建立两套可以长期积累的数据：

1. **18 个产品 CUJ case**：6 个现有 Playground scenario，每个 3 个 example；用真实 HTTP/UI 操作产生 trajectory，并用 headless Chromium 逐 event 和逐 live checkpoint 渲染。
2. **12 个 eval 基础设施 fault case**：覆盖 gate、capture、browser、iframe 和持久化中断；其中既有合法失败 bundle，也有必须被 validator 拒绝的 mutation fixture。

小模型只能编写确定性输入：fixture、actions、expectations、fault profile 和 manifest。以下内容禁止由模型伪造，必须由 runner 执行后生成：

- `action-results.jsonl`；
- `events.jsonl` 与 trajectory blobs；
- capture outcome、DOM、accessibility tree、console 和 iframe evidence；
- PNG、SHA-256、size、duration 和最终 summary；
- model request 的 `assert:true` 结果。

所有标准 bundle 遵循 [FORMAT.zh-CN.md](FORMAT.zh-CN.md)。Schema 校验和 `validate-semantics.mjs` 都通过后，才能生成报告。

## 2. 数据目录

源数据与执行结果分开：

```text
eval/
  schema/case-spec.schema.json          # 生成输入的 schema
  cases/v1/
    manifest.json
    <scenario>/<example>/
      spec.json                         # seed、viewport、fault profile
      fixture.json                      # initial model
      expectations.json
      actions.jsonl
  fault-corpus/v1/
    manifest.json
    <fault-id>/
      source.json                       # 从哪个 case 派生
      mutation.json                     # 确定性 fault/mutation 描述
      expected.json                     # valid/invalid 与错误码
  runs/                                 # runner 生成，不作为输入编辑
    <run-id>/...
  corpus/                               # 人工挑选并冻结的可复现结果
    <corpus-version>/...
```

`runs/` 保存每次完整执行；CI 原始 run archive 作为 workflow artifact 保存。只有满足以下条件的 run 才能提升到 `corpus/`：环境固定、所有引用闭合、能离线校验、失败可重复。内容寻址 artifact 去重；不要复制同一 PNG。

## 3. `spec.json` 最小字段

先实现 `case-spec.schema.json`，然后生成 case。字段固定如下：

```json
{
  "schema_version": 1,
  "case_id": "human-edit/nominal",
  "scenario_id": "human-edit",
  "example_id": "nominal",
  "title": "Edit one short title",
  "seed": 1101,
  "fixture": "fixture.json",
  "expectations": "expectations.json",
  "actions": "actions.jsonl",
  "viewport": { "width": 1440, "height": 1000, "device_scale_factor": 1 },
  "view_policy": {
    "selected_component_id": "welcome",
    "open_panel": "none",
    "focus": null,
    "scroll": { "app_x": 0, "app_y": 0, "canvas_x": 0, "canvas_y": 0 }
  },
  "fault_profile": null,
  "tags": ["p0", "text", "human"]
}
```

约束：

- `case_id` 必须等于 `<scenario_id>/<example_id>`；
- seed 固定，首位数字按 scenario 编号：11xx、12xx……16xx；
- fixture 必须通过 `model.schema.json`；
- actions 和 expectation 使用现有 eval schema；
- 所有生成 ID 使用 runner 的 deterministic provider，输入文件不写随机 UUID；
- 输入不得包含 token、cookie、API key、绝对路径和当前时间。

## 4. 18 个产品 CUJ case

### 4.1 总表

| # | Case ID | 核心动作 | 必须验证的风险 |
| --- | --- | --- | --- |
| 01 | `human-edit/nominal` | load → edit title | 单节点修改、ID 稳定、canvas/model/DOM 一致 |
| 02 | `human-edit/unicode-escape` | edit body 为中英文字、emoji、`<b>` | Unicode、HTML 转义、无脚本执行 |
| 03 | `human-edit/stale-conflict` | A 保留 draft，B commit，A submit | 409、draft/focus 保留、model unchanged |
| 04 | `comment-agent/nominal` | comment title → mock agent | anchor 保留、agent 只改 title |
| 05 | `comment-agent/body-anchor` | comment body，切换选择后再执行 | comment revision/anchor 不漂移，执行目标明确 |
| 06 | `comment-agent/invalid-proposal` | comment → provider 返回非法 proposal | 无 commit、错误 UI、评论仍存在 |
| 07 | `shared-undo/nominal` | human edit → agent edit → undo ×2 → redo | 人机共享同一历史、event append-only |
| 08 | `shared-undo/branch-invalidation` | undo → 新 human edit → redo | 新分支后 redo 禁用且请求被拒绝 |
| 09 | `shared-undo/restart` | mixed edits → restart → undo/redo | 重启后历史、revision、ID 和内容一致 |
| 10 | `component-lifecycle/nominal` | duplicate → move → delete → undo | 新 ID、顺序、删除恢复、原对象不变 |
| 11 | `component-lifecycle/capacity` | 创建至 8 个 → 再创建 | UI disabled、服务端拒绝、第 9 个不出现 |
| 12 | `component-lifecycle/idempotent-retry` | 同 command 重试、重启后再重试 | 只 commit 一次；不同输入复用 ID 被拒绝 |
| 13 | `html-component/nominal` | edit text node → agent horizontal layout | 原文局部保持、稳定 node ID、iframe 正确 |
| 14 | `html-component/nested-unicode` | 编辑嵌套叶子为 Unicode 长文本 | anchor 唯一、无裁切/overflow、周围 bytes 稳定 |
| 15 | `html-component/security-error` | active content / ambiguous anchor edit | 后端拒绝、无脚本/外部请求、HTML unchanged |
| 16 | `audited-request/capture-off` | agent request，capture=false | request 可重建、`assert:true`、无 full body blob |
| 17 | `audited-request/capture-on` | 同输入，capture=true | 多 full body blob；proposal 与 off 模式一致 |
| 18 | `audited-request/corrupt-reconstruction` | 定向破坏一个 request fragment | 转发前 fail closed、provider 收到 0 请求 |

### 4.2 每类 example 的输入规则

#### Human edit

- `nominal`：只允许 `/components/0/title` 改为 `Start your project`。
- `unicode-escape`：正文固定为 `你好 👋 <b>literal</b> & goodbye`；DOM 必须显示文字，不产生 `b` 节点。
- `stale-conflict`：A 的 draft 固定为 `Draft from A`；B 将 title 改为 `Committed by B`；A 提交后 revision、event tail 和 model hash不变。

#### Comment → agent

- 所有 comment 保存 `component_id`、`node_id`、comment revision 和完整文字。
- `body-anchor` 必须显式记录运行 agent 前后的 selected component，避免用隐式 UI 状态决定目标。
- `invalid-proposal` 使用确定性 fake provider，不调用真实模型。

#### Shared Undo

- human 和 agent 每次成功 edit 都产生独立 revision。
- Undo/Redo 必须检查 model、renderer、按钮 enabled 状态和 append-only events。
- `restart` 在进程边界前后保存 checkpoint，不允许通过内存对象继续测试。

#### Component lifecycle

- deterministic provider 依次生成 `card-01`…`card-08`。
- capacity 和最后一个组件删除边界同时从 UI 与 API 验证。
- retry 使用固定 `command_id`；相同输入返回原结果，不新增 event。

#### HTML component

- HTML 只能来自 repo 内 fixture，不加载外部 URL。
- 成功 capture 必须保存主文档和 iframe 的 DOM/layout；`iframes_expected === iframes_ready`。
- security case 分别尝试 `<script>`、`onclick`、外部图片 URL、重复 `data-node-id`；每次都要求 model hash unchanged。

#### Audited request

- off/on 两个 case 复用相同 initial model、prompt、engine fixture 和 deterministic proposal。
- 对 reconstructed request 计算 hash；`assert` 必须由实际比较得到。
- corrupt case 在 provider 调用前 mutation；provider spy 必须记录 0 请求。

## 5. 每个产品 case 必须产生的 checkpoint

所有 action 后都执行 event replay。Live checkpoint 根据动作类型选择：

| 动作 | Live checkpoint |
| --- | --- |
| 打开编辑器并输入 | `before`：draft、focus、selection |
| Agent 正在等待 proposal | `during`：loading + response gate |
| 成功提交 | `after`：最终 model、UI、DOM、截图 |
| stale revision | `conflict`：409、draft 和 rebase affordance |
| validation/provider 错误 | `error`：错误文案、controls、model unchanged |
| Undo/Redo/排序/删除 | `after`：顺序、selection、controls |

每个成功 capture 至少保存 app 和 canvas 两张 PNG。HTML case 额外保存 component surface 与 iframe evidence。每次 event replay 都保存截图，即使该 event 不改变画面；相同内容通过 hash 去重。

## 6. 12 个 fault case

Fault case 不计入 6 × 3 产品矩阵。前 9 个应生成 **schema-valid 的失败或 incomplete bundle**；后 3 个是 validator 必须拒绝的 mutation fixture。

| Fault ID | 注入点 | 期望状态 |
| --- | --- | --- |
| `gate-provider-before-pause` | proposal 前 provider error | gate `not_reached`，只有 `gate_armed` |
| `gate-cancel-after-pause` | pause 后、capture 前取消 | released/cancelled，无 capture pair |
| `gate-capture-timeout` | screenshot 超时 | timeout outcome，完整 pair，released |
| `gate-release-failed` | capture 后 release 抛错 | `release_failed`，terminal 为 `gate_release_failed` |
| `gate-crash-before-outcome` | `capture_started` 后崩溃 | paused + dangling start，无 capture outcome |
| `gate-crash-after-outcome` | outcome 写入后、finish 前崩溃 | paused + dangling start，owner 引用 outcome |
| `capture-tail-moved` | capture 期间 append event | blocked，保存 before/after cutoff |
| `capture-render-error` | DOM 成功后截图失败 | render_error，保留已取得 evidence |
| `browser-startup-failure` | Chromium launch 失败 | incomplete、`final:null`、setup error |
| `invalid-capture-owner` | 删除 owner result 的 capture ID | semantic error `capture.action_reference` |
| `invalid-gate-order` | release 后插入 capture start | semantic error `gate.lifecycle`/`gate.capture_order` |
| `invalid-cutoff-regression` | after cutoff 小于 before | semantic error `capture.cutoff_regressed` |

Mutation fixture 必须保存：原始合法 case ID、单一 mutation、预期 error code 集合。一次 fixture 只测试一个主要错误，避免无法判断失败原因。

## 7. 小模型的工作拆分

每个任务只生成一小批文件，完成后立即校验。不要一次生成全部 30 个 case。

1. **G0 — Schema 与 compiler skeleton**：实现 `case-spec.schema.json`、manifest schema 和 spec→标准输入的 compiler；不生成执行结果。
2. **G1 — Human edit**：生成 case 01–03。
3. **G2 — Comment agent**：生成 case 04–06。
4. **G3 — Shared Undo**：生成 case 07–09。
5. **G4 — Component lifecycle**：生成 case 10–12。
6. **G5 — HTML component**：生成 case 13–15。
7. **G6 — Audited request**：生成 case 16–18。
8. **G7 — Valid fault profiles**：生成前 9 个 fault case。
9. **G8 — Invalid mutations**：生成最后 3 个 mutation fixture。
10. **G9 — E2E runner**：真实执行 inputs，写标准 bundle，用 headless Chromium capture。
11. **G10 — Corpus promotion/report**：冻结通过的 run，生成 index 和 HTML report。

每个 G1–G8 任务的输出必须包含：新增文件列表、schema 校验结果、case 数量、action 数量、预期 checkpoint 数量。不要修改产品代码；若输入无法表达需求，记录 blocker，由主模型修改 schema/runner。

## 8. 生成时的机械检查

每完成一个 case，依次执行：

1. JSON/JSONL 可解析，JSONL 每行一个对象；
2. fixture 通过 `model.schema.json`；
3. spec、case、expectations、action 通过对应 schema；
4. action `step` 从 1 连续递增，`action_id` 唯一；
5. checkpoint ID 唯一，每个 `after_action_id` 存在；
6. expected model 不从 actual output 回填；
7. fault profile 只包含允许的枚举值；
8. 路径均为相对路径，不含 secret 或机器信息；
9. seed、输入文字、command ID 和生成 ID 策略确定；
10. 同一输入重新 compile，输出 bytes 完全一致。

## 9. E2E runner 执行顺序

每个 case 在新的临时 data directory 中运行：

1. 校验并 compile inputs；
2. 启动 server，等待 health check；
3. 启动固定版本 headless Chromium；
4. 加载 scenario fixture，应用 `view_policy`；
5. 逐条执行 action，并实时写 action result 和 live checkpoint；
6. 导出原始 trajectory，校验所有 blob 引用；
7. 在独立只读 renderer 中逐 event replay；
8. 对每个 event 保存 capture outcome 与 screenshot；
9. 执行 structural、DOM、iframe、accessibility、console、layout oracle；
10. 运行 JSON Schema 和严格 semantic validator；
11. 写 summary；最后生成 report，不能先写 pass 再补验证。

Server、browser 或 runner 崩溃时也要在新的恢复进程中完成 failure/incomplete bundle。禁止删除已 append 的 observation 来让 validator 通过。

## 10. 第一轮执行与停止条件

按以下顺序运行，发现格式问题立即停止扩量：

1. `human-edit/nominal` vertical slice；
2. gate crash window 2 个 fault case；
3. 每个 scenario 的 nominal，共 6 个；
4. 其余 12 个产品 case；
5. 其余 fault case；
6. 全部 case 用同一 seed 再跑一次，比较 semantic fingerprint；
7. 选择 3 个 case 换 seed，确认只有声明的生成值变化；
8. 重跑任意失败 case，确认离线 bundle 足以复现。

遇到以下任一条件停止生成新数据，先修 runner/format：

- schema-valid bundle 无法通过 semantic validator，且输入符合本文规则；
- 失败后必须删除真实 observation 才能通过；
- 同 seed 重跑 expected inputs 或 semantic fingerprint 漂移；
- event replay 与 live checkpoint 使用了不同 renderer；
- screenshot 成功但 DOM/model artifact 缺失；
- report 中的计数无法从磁盘重新计算。

## 11. 首轮验收标准

- 18/18 产品 case 都产生完整 bundle；
- 9/9 合法 fault case 产生预期的 fail/incomplete bundle；
- 3/3 invalid mutation 被拒绝，错误码与 manifest 一致；
- 每个业务 event 恰好一个 replay capture outcome；
- expectation 声明的 live checkpoint 全部有 outcome；
- 100% artifact 引用通过 size 和 SHA-256 校验；
- 同 seed 两次运行 semantic fingerprint 一致；
- 所有截图可从 report 打开，失败 capture 显示部分 evidence；
- 任一 case 可复制到空目录独立验证，不依赖原运行目录；
- CI 上传完整 run archive；人工审核后至少提升 6 个 nominal case 和全部 fault case 到首版 corpus。

完成首轮后再增加随机或组合 case。首轮不使用无约束 fuzz，也不让模型自由编写期望结果；先建立稳定、可解释、能复现的基线。

## 12. 交给小模型的任务模板

每次只替换 `<TASK>` 和 `<CASE RANGE>`：

```text
你在 canvas-demo 仓库中执行 DATA-GENERATION-PLAN.zh-CN.md 的 <TASK>，只处理 <CASE RANGE>。

必须先阅读：
1. eval/DATA-GENERATION-PLAN.zh-CN.md
2. eval/FORMAT.zh-CN.md
3. eval/schema/*.schema.json
4. scenarios.mjs 中对应 scenario

你只能新增或修改本任务对应的 spec.json、fixture.json、expectations.json、actions.jsonl 和 manifest 条目。
不要生成 action-results、events、capture、hash、截图、assertion 或 summary；这些必须由 runner 实际执行产生。
不要修改产品代码或放宽 schema。遇到现有格式无法表达的内容时停止该 case，写出 blocker 和最小复现。

每完成一个 case：
- 执行全部输入 schema 校验；
- 检查 action step 连续、ID/checkpoint 唯一、引用存在；
- compile 两次并比较 bytes；
- 报告新增文件、case/action/checkpoint 数和验证结果。

只在本批所有 case 通过后提交，commit message 使用：
Add eval data <CASE RANGE>
```

主模型 review 每一批时至少抽查一个 expected model、一个拒绝路径和一个 live checkpoint，不要只看 schema 是否通过。
