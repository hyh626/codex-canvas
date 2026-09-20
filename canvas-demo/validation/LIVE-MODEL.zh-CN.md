# 同一套 CUJ 的真实模型验收

`live-model.mjs` 对 Codex 和 DSH 使用相同任务与逐字段预期值。它直接调用产品的 EngineAdapter、gateway 和 Store，不涉及浏览器或 Electron UI 自动化。

## 配置与运行

先阅读 `RESULTS.zh-CN.md` 的 runtime 版本和限制。测试会对配置的 provider 发出两轮 agent 调用，runtime 自身的重试可能增加实际 HTTP 请求与费用。脚本不会自动下载 runtime，也不自动寻找或复用其他应用的登录凭据。

在本机安全配置以下环境变量，不把 key 放进代码或 GitHub：

| 引擎  | 可执行文件绝对路径 | 模型 ID          | API endpoint                              | 凭据变量           |
| ----- | ------------------ | ---------------- | ----------------------------------------- | ------------------ |
| Codex | CODEX_BIN          | CANVAS_MODEL     | CANVAS_RESPONSES_URL，以 /responses 结尾  | CANVAS_API_KEY     |
| DSH   | DSH_BIN            | CANVAS_DSH_MODEL | CANVAS_DSH_URL，以 /chat/completions 结尾 | CANVAS_DSH_API_KEY |

```sh
cd canvas-demo
node validation/live-model.mjs dsh --live
node validation/live-model.mjs codex --live
```

每个命令独立运行。缺失变量会返回 JSON `status=blocked`、缺少的变量名称和 `modelRequests=0`，退出码 2；不启动 runtime，不访问 provider。缺少 `--live` 也不会运行。成功退出码 0，验收失败为 1。可执行路径不合法等启动配置错误也会非零退出。

不要为了在受限容器中跑通 Codex 而关闭 sandbox。在正常支持该 runtime 沙箱的开发主机重跑；当前验证环境的 Bubblewrap 阻挡见 RESULTS 文档。

## 两条共用任务

1. 人工编辑正文后，要求模型只把 `welcome.title` 改成 `Start your project`。逐字段比较整个结果模型，任何额外改动都失败。
2. 新增评论，要求标题为 `Build together`。指令不复述目标标题，模型需使用 recentComments；其他字段必须保持原样。

每轮都验证最终请求从磁盘重建后的 hash、真实 assert、完整响应、capture 默认关闭、proposal 的业务正确性、事务提交与 Undo/Redo。旧 proposal 再提交必须被 revision gate 拒绝。最后重新打开 Store，逐字节比较归档与恢复结果。

这两条是受控卡片模型的最低验收门槛，不代表任意 HTML、图片、工具循环或长期 session 已验收。它们使用精确标题以便确定性判定，不是开放式设计质量评分。

## 结果与诊断

每次使用独立目录：`.data/live-validation/<engine>-<uuid>/`。

- `report.json`：引擎、模型、runtime 路径、时间、逐 CUJ 结果与 HTTP 请求数。
- `session/events.jsonl` 和 `session/blobs/`：可重建请求、provider 响应、原生 engine 事件和模型提交历史。
- stdout 返回摘要及报告路径，便于 CI 收集；详细 provider 错误不复制到摘要。

默认不保存额外完整 request body；重建材料和收到的响应仍然必须落盘。`.data` 已被 gitignore 排除。诊断日志可能包含模型输入输出，分享之前应审查。

`providerMode=configured-endpoint` 只说明使用了配置的地址，脚本不会靠 URL 名字断言后面一定是真模型。若指向模拟服务，必须在验收记录明确标注；不能把模拟成功记为真实模型质量通过。

## 本次实际执行状态

2026-09-20：

- CLI 的无配置阻挡路径已测试，Codex 和 DSH 均返回 blocked，零请求。
- 验收逻辑已用真实 DSH 0.1.5-rc.2 + 本地确定性 provider 自检，两个 CUJ、审计和重启恢复通过。这仅证明脚本与 runtime 链路可执行。
- 新增测试覆盖没有审计请求、响应不完整、存在失败 attempt 时拒绝通过。
- 当前环境没有真实 provider 凭据，真实模型验收未执行。Codex 当前容器沙箱限制仍未解除。

请求曾失败后即使 runtime 重试成功，本版严格验收仍判失败，以便暴露协议或可靠性问题。错误分类 `ACCEPTANCE_FAILED` 表示断言不成立；`TIMEOUT`/`CANCELLED` 表示生命周期失败；其他归为 `RUNTIME_OR_PROVIDER_FAILED`，通过本地事件进一步定位。
