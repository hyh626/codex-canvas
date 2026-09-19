# Canvas × Codex：可运行 Demo

这份代码是 [hyh626/codex-canvas](https://github.com/hyh626/codex-canvas) 中的独立 `canvas-demo/` 应用，已完成本地实现和测试。

## 三条命令启动

需要 Node.js 22 或更新版本。默认 mock 模式不需要 API key，也不需要安装 npm 依赖。

```sh
cd canvas-demo
npm start
# 浏览器打开 http://127.0.0.1:4317
```

验证：`npm test`。可选 Electron 壳见英文 README；macOS/Windows 安装包尚未制作。

## 更多可体验流程

见 [九条 CUJ 操作与验收指南](CUJ.zh-CN.md)：直接编辑、新建与复制、排序、删除与恢复、评论交给 agent、跨窗口冲突、人机共同撤销、重启恢复、请求审计与导出。每条都说明操作步骤、模型变化与边界。

## Data model 如何真正落地

**只有一个权威来源：已提交的事件链 + 不可变 snapshot blobs。**

```json
{
  "components": [
    {
      "id": "welcome",
      "title": "一起把想法变成作品",
      "body": "人和 agent 编辑同一份模型。",
      "color": "#6366f1"
    }
  ]
}
```

`model.schema.json` 给出可审查的结构规范；服务端 `validate()` 实际执行约束：1–8 个组件、唯一 ID、标题/正文长度上限、颜色格式、拒绝未知字段。外部客户端和模型都不能跳过校验。

| 操作         | 实际执行                                                                         |
| ------------ | -------------------------------------------------------------------------------- |
| 用户编辑标题 | 表单携带打开时的 revision → 校验 → 写 blob → 追加 event → 更新投影 → SSE 通知 UI |
| Agent 修改   | 读取 snapshot、最近的结构化修改和锚点 comment → 提出模型 → 同一个 commit 入口    |
| 并发写入     | baseRevision 过期返回 409，旧 agent 结果不得覆盖新的人工作品                     |
| 撤销         | 读取目标提交的 before snapshot，追加新的 revision，不删除历史                    |
| 重做         | 读取原始目标的 after snapshot，再追加提交；undo 后的新编辑清空 redo 分支         |
| 重启         | 校验事件序列、校验 blob hash、重放提交链、重新生成作品投影                       |
| 评论         | 保存 componentId、nodeId、评论时 revision；后续请求明确包含该锚点                |

例如人工把标题 A 改为 B，后端确定性生成下面的 diff，而不是让 LLM 猜测用户改了什么：

```json
{ "component_id": "welcome", "node_id": "title", "before": "A", "after": "B" }
```

修改保存为 blob 引用，下一次 agent 输入同时包含当前 snapshot 与最近三次提交的 diff。界面点击提交事件可以直接查看 diff；点击请求事件可以查看重建的请求。单次应用注入的上下文上限为 8 KB，超限直接报错，不静默丢字段。

## 落盘文件

```text
.data/
  events.jsonl                 # 持久、追加的事实记录
  blobs/sha256/<hash>          # snapshot、diff、请求片段、响应片段
  workspace/
    canvas.json               # 当前 revision 与组件文件索引（生成投影）
    components/welcome.html    # 有稳定 data-node-id 的组件 HTML（生成投影）
  writer.lock                 # 单进程写入锁
```

**本版暂不实现任意 HTML 文件作为可编辑权威模型。** 与之前通用方案的区别是：本版使用受控卡片模型验证事务闭环，HTML 是生成投影；直接编辑这些投影文件会在恢复时被覆盖。后续切换到 HTML-first 时，需要实现解析器、节点补丁、未知 markup 保留和资产管理，明确切换权威来源，不能留下两套可独立写入的状态。

事件与 blob 在提交确认前 fsync。文件投影不是多文件原子事务，外部程序不能把其写入过程作为原子版本读取；当前 UI 读取后端已提交状态。进程硬崩溃留下的锁不自动抢占，确认旧进程已经退出后才能删除锁。生产版本应采用事务数据库或 revision 目录 + 原子指针。

## Codex 和请求验证

- 默认 mock 可直接演示标题、颜色和新增卡片，不会调用付费模型。
- `codex.mjs` 实现真实 app-server 协议接口，使用独立临时 CODEX_HOME、临时工作目录和只读 sandbox，输出结构化 proposal。
- 实际模型请求经过 `gateway.mjs` 的 Responses HTTP 网关。网关保存输入 item/config/descriptor 引用，从磁盘重建、比较和哈希校验成功后才转发。
- `assert=true` 来自执行结果，没有绕过开关。完整 request body blob 默认不写；勾选 capture 时才保存额外快照。
- 对 provider 返回的 SSE 字节分片，先保存再转发；失败时也保留已收到的片段。
- 仅支持完整上下文、无状态的 Responses HTTP。WS、远程会话引用、尚未实现的 compaction endpoint 都拒绝执行。
- 凭据只由服务端环境提供，不进入 UI 和事件日志。

启用 Codex 需要在本机设置 `CODEX_BIN`、`CANVAS_MODEL`、`CANVAS_RESPONSES_URL`、`CANVAS_API_KEY`，具体见英文 README。支持别的模型首先取决于 Responses 协议兼容性；原生 Claude/Gemini 协议尚无适配器。

## 已验证与未验证

15 项 Node 测试全部通过：编辑/撤销/重做/重启、版本冲突、幂等重试、非法模型、blob 篡改、导出完整恢复、HTTP 交互、Codex 协议 fixture、网关请求重建与拒绝转发。

**尚未验证**：付费真实模型 + Codex binary 的端到端调用、Electron/macOS/Windows 包、浏览器截图测试。当前云浏览器拒绝访问本地地址，因此没有声称 UI 已做浏览器自动化验收。上游 Rust 格式化命令尝试过，但环境缺 Cargo/DotSlash；本次没有修改上游 Rust 文件。

## 在你的 fork 中更新

所有应用代码位于 `canvas-demo/`，未修改 Codex 主程序。已有 clone 可运行 `git pull` 更新，然后进入该目录执行 `npm start`。
