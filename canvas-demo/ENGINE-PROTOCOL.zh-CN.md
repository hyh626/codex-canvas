# Canvas Engine Protocol v1：Codex 与 DSH

状态：两个 adapter 与共用 CUJ 的协议 fixture 已实现；真实引擎加真实模型尚未验收。默认仍是 mock，没有将 DSH 宣称为生产可用后端。

## 1. 仓库与职责

首版在 `canvas-demo/` 集中维护 UI、Canvas 事务、engine adapter、gateway 与契约测试。上游 Codex/DSH 是外部运行时，分别通过 `CODEX_BIN` / `DSH_BIN` 指定。不要把两个上游源码树复制进产品目录。现有 Codex fork 是暂时的容器；以后可整体抽出该目录成为产品 monorepo。DSH fork 只承载必要的 runtime/plugin 补丁；当前 adapter 不要求修改上游。

| 边界                    | 协议                                    | 谁掌握状态                |
| ----------------------- | --------------------------------------- | ------------------------- |
| UI → Canvas API         | 现有 HTTP JSON + SSE                    | Canvas Store              |
| Canvas → EngineAdapter  | `canvas-engine/v1`，进程内异步调用      | Canvas 拥有任务与正式作品 |
| Codex adapter → runtime | app-server JSONL RPC                    | 临时 Codex thread         |
| DSH adapter → runtime   | SDK JSON-RPC 2.0 over stdio             | 临时 DSH session          |
| Runtime → model gateway | Codex: Responses；DSH: Chat Completions | gateway 记录实际请求      |
| Gateway → provider      | 同一种 wire protocol 转发               | provider 推理             |

Gateway **不做 Responses ↔ Chat Completions 翻译**。两种 wire 分别由各自 runtime 构造；gateway 用不同 builder 重建。UI 不依赖任一 runtime 的原生 event schema。

## 2. 调用契约

```js
const result = await runEngine(engine, input, record, options);
```

- `engine`：`codex | dsh`。mock 仍是原有确定性测试路径，不假装一个真实 engine。
- `input`：下表定义的业务输入。入口复制 snapshot，adapter 不能修改调用者对象。
- `record(type, payload)`：同步持久化回调；服务端将 payload 存入 CAS blob，再追加引用事件。
- `options`：仅可信服务端提供，包括 command/args、model、gateway、timeout、AbortSignal。HTTP 用户不能选择可执行路径、环境或 provider key。
- `timeout`：整个子进程交互的毫秒期限，默认 120000；不是每个 RPC 重新计时。

| 输入字段          | 类型／含义                              |
| ----------------- | --------------------------------------- |
| snapshot          | 当前 Canvas 模型；仍执行 Store.validate |
| baseRevision      | 非负安全整数；该次运行看到的基线        |
| selectedComponent | snapshot 中存在的组件 ID                |
| instruction       | 用户原文；HTTP 入口限制 2000 字符       |
| recentChanges     | 服务端确定性产生的最近三次变更          |
| recentComments    | 最近六条带节点和 revision 的评论        |

整个 input JSON UTF-8 限制 8000 bytes。不会偷偷截断。此版本输出为完整模型 proposal，不是任意文件 patch，也不是一次工具调用。

结果形状：

```json
{
  "protocol": "canvas-engine/v1",
  "runId": "runtime-generated-uuid",
  "engine": "dsh",
  "baseRevision": 12,
  "proposal": { "components": [] }
}
```

上例仅展示 envelope；有效 proposal 必须有 1–8 个合法卡片，空数组会被拒绝。结果通过 schema 校验后才能返回。服务端随后用原 baseRevision 提交；期间发生人工提交则返回 409，不覆盖新版本。

## 3. 事件、失败与生命周期

每条 adapter 事件都有 `protocol`、`runId`、`engine`。日志 seq 由 Store 统一分配，adapter 不另造全局序列。

| 类型                     | payload 附加字段           | 意义                                                 |
| ------------------------ | -------------------------- | ---------------------------------------------------- |
| engine.started           | baseRevision, capabilities | 开始一个独立 proposal 运行                           |
| engine.native            | nativeType, payload        | 原生协议原文，仅供诊断；不得直接作为 Canvas mutation |
| engine.completed         | baseRevision               | proposal 校验通过；**不等于已提交**                  |
| engine.failed            | code, message              | adapter 失败，无有效 proposal                        |
| workspace.edit_committed | 原事务字段                 | 唯一代表作品已正式变更的事实                         |

`TIMEOUT` 表示运行期限到期；`CANCELLED` 表示调用者 AbortSignal 取消；其余协议、进程、解析或 proposal 校验失败统一为 `ENGINE_FAILED`。详细原因保留 message；目前没有更细的稳定错误枚举。

合法调用产生 started → native* → completed 或 failed。输入校验失败发生在 started 之前。completed 之后仍可能因为审计材料缺失或 revision 冲突产生 `agent.failed`，因此 UI 不能在 completed 时显示“作品已保存”。

取消当前只在 adapter 的 AbortSignal 接口提供。**HTTP/UI 尚无取消按钮、task handle、steer 或 resume API。** 取消通过终止专属子进程，必要时升级 SIGKILL，并等待退出；不承诺 provider 已取消推理或不计费。不要将此行为描述为原生 DSH prompt-cancel。

## 4. 原生协议映射

| 阶段       | Codex                                 | DSH                                                               |
| ---------- | ------------------------------------- | ----------------------------------------------------------------- |
| 握手       | initialize + initialized              | initialize；验证 serverInfo.name                                  |
| 创建上下文 | thread/start，ephemeral/read-only     | session/prompt 中使用新 UUID，惰性创建                            |
| 发送输入   | turn/start，input 文本与 outputSchema | session/prompt，contentBlocks 文本；schema 写入专属 system prompt |
| 输入已接收 | turn RPC response                     | messageId + agent/inbox/spliced durable receipt                   |
| 取结果     | item/completed agentMessage           | 根 session 的 assistant/message.data.message.content              |
| 完成       | turn/completed status=completed       | receipt 之后根 session.status=idle                                |
| 退出       | 收集完成后销毁专属进程                | 收集完成后销毁专属进程                                            |

DSH 会先发通知再返回 RPC response。adapter 暂存握手/排队阶段的通知，拿到 messageId 后再按顺序消费。receipt 之前的 idle 不算完成；其他 session 的文本不能混入结果。最终文本必须直接 JSON.parse，不能自动移除 Markdown 或“修复”模型输出后伪装成原结果。

Codex outputSchema 是原生输出约束；DSH 这里使用 prompt 约束再做本地校验，**两者约束强度不同**，真实任务通过率需要分别测量。新进程/新 session 的限制避免多 prompt、steer、子 agent 造成结果归属歧义。

## 5. DSH 运行配置

根据上游 `ddefc45fbc7f8e46dd73185e68295696d1297887` 的 SDK 协议与 sdk-minimal profile 编写。

启动：`DSH_BIN --profile sdk-minimal --patch <generated-patch>`。创建独立临时 DSH_HOME 和 cwd；显式禁用 persistent-bash、persistent-pwsh、terminal-bash、terminal-pwsh、mcp-resources。它是无工具 proposal 模式，不是任意代码执行沙箱。

llm-deepseek 配置为 `chat-completions`、网关 baseURL、临时网关 token、thinking disabled、maxTokens 4096。模型由 initialize 选择，provider 为 deepseek-official。真实 provider key 仅在 Canvas gateway 中使用，DSH 子进程不继承它；临时环境仅保留必要的路径/系统变量。

这是源码固定点，不是自动 runtime 版本校验。部署必须从该提交或经过同样验收的 fork 构建 DSH；仅收到正确 serverInfo.name 不证明 profile/plugin 的版本相同。未来应增加构建摘要握手。

```sh
export DSH_BIN=/absolute/path/to/your/pinned/dsh
export CANVAS_DSH_MODEL=your-validated-model-id
export CANVAS_DSH_URL=https://your-provider.example/v1/chat/completions
# 在本机安全设置 CANVAS_DSH_API_KEY，不写入代码。
npm start
```

endpoint/model 是占位值，需替换。配置完整时 UI 才启用 DSH。没有安装 runtime 或没有 credentials 时，mock 仍可运行，fixture tests 不调用付费模型。

## 6. 请求审计与存储

两条路径都必须经 gateway：

- Responses builder：`responses-http-v1`，拆出有序 input。
- Chat builder：`chat-completions-http-v1`，拆出有序 messages。
- 其他 body 字段保存在 config，endpoint 与非认证应用 headers 在 descriptor。
- 从磁盘读取 CAS 引用重建 descriptor/body，deep equality 成功才能写 `assert:true` 和转发。
- full capture 默认关闭；开启后额外保存完整解析对象，当前不承诺原始 HTTP JSON 字节格式。
- 响应字节先存后转发。每次实际 HTTP 请求单独记录 prepared/response，runtime 重试也会产生新记录；尚无语义 retry_of 关联。
- DSH 仅允许 text messages 且无 tools；图像、文件上传、工具、远端上下文、WS 不在本版范围内。
- 服务端不接受“adapter 直接返回但没有任何 audited request”的结果。

本版不以 DSH 原生日志里的 assert 替代应用层的最终请求 gate。DSH 临时 session 文件运行后删除；Canvas 保留收到的 native notifications 和 gateway 材料，但不宣称是 DSH session 的完整可恢复备份。

## 7. 同一批 CUJ 与验收证据

`test/engine.test.mjs` 对 codex、dsh 参数化执行同一套场景：组件新增/复制/排序/删除、人工改字、评论、agent 改标题、保留正文、Undo/Redo、非法 proposal、运行中人工提交导致冲突、持久化重启。另验证超时、取消、错误 session 过滤、早到 idle、通知先于 RPC response，以及 Chat 请求验证失败禁止转发。

fixture 是真实子进程与真实本地 HTTP 网关，但 **不是上游 runtime，也不是模型**。它证明协议处理和事务契约，不证明 DSH profile 能在目标系统启动，也不证明模型理解评论或编辑质量。

截至本次验证，20 项 Node 测试通过。上线前还需：两个固定 runtime 的真实启动、各一个真实 provider、capture 开关、模型异常、真实多轮审计、macOS/Windows 进程退出、浏览器交互。默认后端暂不改变。

源码依据：

- [DSH SDK wire types](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/sdk/protocol/src/types.ts)
- [DSH receipt-to-idle 结果规则](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/sdk/client/src/api.ts)
- [DSH minimal profile](https://github.com/deepseek-ai/deepseek-harness/blob/ddefc45fbc7f8e46dd73185e68295696d1297887/packages/bundle/sdk-minimal/cordis.patch.yml)

## Runtime validation update · 2026-09-20

[真实 runtime 验收记录](validation/RESULTS.zh-CN.md)：DSH 0.1.5-rc.2 已通过真实进程 + 本地模拟 provider 的请求重建、capture、proposal 与事务检查。Codex 0.155.1 握手通过，但 thread/start 被当前环境的 Bubblewrap 权限限制阻挡。真实模型仍未测试；此记录更新上文关于 runtime 尚未验证的状态。
