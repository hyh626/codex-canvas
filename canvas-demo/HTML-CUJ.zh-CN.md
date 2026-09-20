# HTML 组件：实现与验收

## 数据契约

新增组件类型 `{id, kind: "html", html}`。`html` 是原文字符串，保存在不可变 snapshot blob 中，由已提交事件引用。旧版 `{id,title,body,color}` 卡片保持兼容。所有编辑通过同一个 revision 检查和 commit 入口；Undo/Redo 追加事务，恢复完整原文。

`.data/workspace/components/<id>.html` 是投影：HTML 组件按原文输出，卡片按字段生成。直接修改投影不会提交，重启会覆盖。当前没有文件 watcher、资产管理、多文件原子发布或任意网页导入。

`html.mjs` 使用 parse5 的 HTML5 解析和 source offsets。每个元素要求唯一 `data-node-id`，只允许一个顶层 `root`；除 `br` 外要求显式闭合。最多 100 个元素、12,000 个 JavaScript 字符。只支持静态容器和文字标签、白名单行内 CSS；禁止脚本、事件属性、外部资源及 URL 样式。完整白名单见 `html.mjs`。

文字编辑只允许叶子文字节点，最多 2,000 个字符。替换原文中目标开始标签与结束标签之间的文字范围，转义输入，其余原文保持不变。布局或源码编辑提交完整 HTML，重新校验。原文 diff 保存 `node_id: "html"` 的前后值；人工文字命令的 `intent.nodeId` 记录具体目标。这里没有声称已实现通用 DOM 结构 diff。

评论保存组件 ID、节点 ID 和原 revision。当前节点存在则可定位；节点删除则显示历史评论；Undo 恢复同一 ID 后可以再次定位。尚不检测“删除后将原 ID 复用给另一语义节点”，因此调用方必须保留身份语义，不能任意复用 ID。

预览 iframe 开启 sandbox，仅允许 same-origin 供父页面绑定点击事件；不启用 scripts。组件 HTML 经后端校验，并受 iframe CSP 限制；Electron renderer 关闭 Node integration，开启 context isolation 和 sandbox。

## 完整操作流程

```sh
cd canvas-demo
npm ci --omit=dev
npm start
```

打开 `http://127.0.0.1:4317`：

1. 点击 **New HTML**，新增包含标题、正文和列表的组件。
2. 双击 HTML 标题，输入新文字并提交。检查原文和事件；组件与节点 ID 不变。
3. 给 `title` 节点添加评论，点击 **Locate node**，目标应高亮。
4. 选择 mock，输入 `layout: horizontal` 并运行。布局变为横向，文字保留。
5. Undo 恢复之前原文和纵向布局；Redo 恢复横向布局。
6. 窗口 A 打开正文编辑弹窗并输入草稿；窗口 B 修改标题并提交。A 提交应被拒绝，保留草稿。
7. A 点击弹窗中的加载最新版本按钮，阅读最新文字，再显式提交草稿。该步骤更新 baseRevision，不做自动三方合并。
8. 在原文编辑器把标题的 `data-node-id="title"` 改为 `replacement` 并提交。旧评论应显示节点已删除；Undo 后定位恢复。
9. 正常退出并重启相同数据目录，检查完整 HTML、revision、事件和评论恢复。

Mock 布局使用确定性函数，不调用模型。Codex proposal schema 已支持 HTML，但真实模型端到端调用仍未验收。单次 Canvas 上下文仍受现有 8 KB 上限约束；多个或较大的 HTML 组件可保存，但 agent 输入超限会明确拒绝，不截断后冒充完整上下文。

## 自动化与实际结果

| 检查 | 当前结果 |
| --- | --- |
| 17 项 Node 单元／HTTP 集成测试 | 本地通过 |
| 原文非目标范围保持、HTML 校验拒绝非法输入 | 通过 |
| HTTP 改字、评论、mock 布局、旧版本拒绝、Undo/Redo、恢复 | 通过 |
| 模型输入包含修改后的 HTML 与评论、默认 capture 不保存 body | 通过 |
| Electron 双击、定位、双窗口冲突、显式重试、节点删除／恢复、重启 | 脚本已实现，本地启动受阻，未记为通过 |
| macOS / Windows 原生 UI | CI 已配置，需查看实际运行结果 |
| 浏览器自动化与真实 Codex 模型 | 未通过端到端验收 |
| 安装包、签名、自动更新 | 未实现 |

桌面验收运行方式（需要图形会话）：

```sh
npm ci
npm run desktop
npm run test:desktop
```

Linux CI 使用 `xvfb-run -a npm run test:desktop`。CI 容器仅在需要时设置 `CANVAS_E2E_NO_SANDBOX=1`，正常桌面启动不添加此标志。测试使用临时 userData，不修改用户工作区；完成后删除测试数据，截图写入被 Git 忽略的 `test-results/`。

本地 Linux 环境中 Electron 40 启动调试端口后、创建首个窗口前发生 SIGSEGV；尝试安装显示依赖也受环境权限限制。因此后端测试通过不能代表桌面 UI 通过。`.github/workflows/canvas-html-cuj.yml` 在三平台运行相同 CUJ 并上传截图，CI 结果是桌面验收的下一项证据。

仓库要求的 `just fmt` 已尝试；运行环境缺少 Cargo / DotSlash 时无法完成上游格式化。本功能不修改上游 Rust 代码。
