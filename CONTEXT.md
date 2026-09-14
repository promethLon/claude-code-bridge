# 术语库（CONTEXT.md）

本仓库文档与交流使用的术语中文对照。为降低中文母语者阅读成本，能用中文解释的术语一律用中文，必要时在旁边注释英文原文。

| 中文术语 | 英文原文 | 含义 |
|---|---|---|
| 宿主框架 | harness | 运行编码智能体的 CLI 外壳（如 Claude Code、Codex CLI、Gemini CLI、ZCode），插件/技能被加载到它里面执行 |
| 插件 | plugin | 按 Claude Code 插件格式打包的分发单元，含技能、子代理等组件 |
| 插件市场 | marketplace | 含 `.claude-plugin/marketplace.json` 的 Git 仓库，宿主框架从中发现并安装插件 |
| 技能 | skill | Agent Skills 开放标准的 markdown 指令文档（`skills/*/SKILL.md`），可跨宿主复用 |
| 子代理 | subagent | 由主线程派生的下级智能体，本仓库中是纯转发器（`agents/claude-delegate.md`） |
| 桥接 | bridge | 本仓库的核心脚本 `claude-companion.mjs`：包装 Claude Code CLI 并补齐会话记账 |
| 委托 | delegate | 主线程把一个自包含任务交给 Claude Code 会话执行的过程 |
| 会话续接 | resume | 通过 `--resume <id>` / `--resume-last` 在已存在的 Claude 会话上继续工作 |
| 后台任务 | background job | 分离进程运行的委托任务，用 `result`/`stop` 轮询或终止 |
| 权限预授权 | --allow / allowedTools | 在发起委托时预先放行子会话的某个工具规则（如 `Bash(npm test:*)`） |
| 权限拒绝 | auto-deny / permission denial | headless 模式下无交互提示，超出权限模式的操作被自动拒绝 |
| 全放行 | --yolo / bypass permissions | 跳过全部权限检查（映射 `--dangerously-skip-permissions`），宜配合工作树使用 |
| 工具规则 | toolspec | Claude Code 权限规则字符串，形如 `Bash(npm test:*)`、`WebFetch` |
