# 真实 runtime 验收记录

日期：2026-09-20。环境：Linux x64、Node.js 24.19.0。应用位于 `canvas-engine-adapters` 分支。**这次使用真正发布的 agent runtime，但模型服务仍是本地确定性 SSE 模拟服务。没有调用付费模型。**

## 结果

| 项目                                  | DSH 0.1.5-rc.2 | Codex 0.155.1 |
| ------------------------------------- | -------------- | ------------- |
| 安装发布包、启动真实进程              | 通过           | 通过          |
| initialize 握手                       | 通过           | 通过          |
| 创建 session/thread                   | 通过           | 环境阻挡      |
| 模型请求到达审计 gateway              | 2 次请求通过   | 未到达        |
| 最终请求从持久材料重建、assert=true   | 通过           | 未执行        |
| full capture=false / true             | 都通过         | 未执行        |
| 真实 runtime 解析模拟 provider 的 SSE | 通过           | 未执行        |
| proposal 校验、提交、Undo/Redo        | 通过           | 未执行        |
| 人工变更和评论出现在实际发送上下文    | 通过           | 未执行        |
| 过期 proposal 不能覆盖人工新提交      | 通过           | 未执行        |
| 真实模型理解与编辑质量                | 未测试         | 未测试        |
| macOS / Windows / Electron            | 未测试         | 未测试        |

DSH 结果原文：

```json
{
  "engine": "dsh",
  "status": "passed",
  "realRuntime": true,
  "realModel": false,
  "requests": 2,
  "assert": true,
  "captureModes": [false, true],
  "checks": [
    "proposal",
    "undo",
    "redo",
    "human-context",
    "comment-context",
    "stale-commit-rejected"
  ]
}
```

Codex 握手返回 `canvas_demo/0.155.1`，随后 `thread/start` 返回：

```text
failed to load AGENTS.md instructions for environment `local`:
fs sandbox helper failed ...
bwrap: loopback: Failed to create NETLINK_ROUTE socket: Operation not permitted
```

因此此次 Codex 失败属于当前容器无法满足其只读 sandbox 的系统权限要求。没有关闭沙箱，也没有改成 danger-full-access。该结果不证明 Codex adapter 的后续模型调用成功或失败；需要在允许其 sandbox 正常启动的主机重跑。

## 实际验证了什么

脚本启动真实 `dsh --profile sdk-minimal`，传入应用生成的 patch，完成官方 JSON-RPC 交互。真实 runtime 自己组装 Chat Completions 请求，实际经网关发送；模拟 provider 返回固定规则生成的合法 SSE。真实 DSH 再处理响应并输出 session 事件，adapter 提取 proposal，Canvas 执行校验及事务。

第二次运行实际输入包含人工修改与评论。检查的是这些事实被真实 runtime 发送给 provider，以及模型返回结构能进入共用事务。模拟 provider 按规则保留正文，所以这**不能证明真实模型会尊重人工修改**。

冲突测试在第二次 proposal 返回后、提交前增加一个人工 revision，然后断言旧 proposal 提交失败。它验证提交边界；不是多用户网络压力测试。

每次运行使用临时目录，测试结束清理。没有归档真实用户数据、凭据或完整本地运行目录。临时 gateway key 只用于本地进程，真实 provider key 未设置。

## 固定版本与复现

包版本及 npm integrity 见 `runtime-versions.json`。DSH adapter 最初参照上游 `ddefc45fbc7f8e46dd73185e68295696d1297887`；本次实际测试的是 npm 发布版 `0.1.5-rc.2`，**没有把它冒充成该源码提交的构建产物**。这次结果只证明所测协议子集兼容；不会自动推广到别的版本。

在仓库之外安装，避免修改应用依赖：

```sh
npm install --prefix /tmp/canvas-runtime-validation --no-audit --no-fund \
  @openai/codex@0.155.1 @deepseek-ai/dsh@0.1.5-rc.2
cd canvas-demo
node validation/runtime-smoke.mjs dsh /tmp/canvas-runtime-validation/node_modules/.bin/dsh
node validation/runtime-smoke.mjs codex /tmp/canvas-runtime-validation/node_modules/.bin/codex
```

以上路径以 Linux/macOS 为例；Windows 启动方式尚未测试。脚本不需要真实 API key，provider 仅监听 loopback，不访问真实模型服务。它独立于 `npm test`，不会悄悄下载 runtime 或在普通测试中发起模型调用。

## 下一验收门槛

1. 在支持 Codex sandbox 的主机运行同一脚本，完成其真实 runtime 链路。
2. 安全配置真实 provider 的 endpoint、model ID、API key，分别运行应用中的相同 CUJ；不要把 key 写入 PR 或聊天。
3. 使用真实模型检查修改准确性、人工修改保留率、非法输出、超时、成本和请求审计。
4. 最后执行 macOS/Windows Electron 与浏览器交互验收。

本环境中 CANVAS_MODEL、CANVAS_RESPONSES_URL、CANVAS_API_KEY、CANVAS_DSH_MODEL、CANVAS_DSH_URL、CANVAS_DSH_API_KEY、OPENAI_API_KEY、DEEPSEEK_API_KEY 均未配置，因此无法继续真实模型验收。默认后端仍为 mock。

## 可执行的下一步

已提供 [真实模型验收指南](LIVE-MODEL.zh-CN.md) 与 `live-model.mjs`。配置凭据后，可在支持 runtime 沙箱的主机运行相同 CUJ；缺失配置会在零请求状态阻挡。脚本自身已用真实 DSH + 模拟 provider 跑通，但本环境仍未执行真实模型验收。
