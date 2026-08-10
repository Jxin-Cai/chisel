# Merge Review（合并前人工 CR）

本阶段与自动 CR / 自修复循环分离。自动 CR 负责发现问题并驱动返修；本阶段负责把最终代码快照整理成可审阅的合并决策包，并获得用户对该精确快照的明确批准。

## 生成报告

运行：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/merge-review.mjs {IDEA_DIR} .
node ${CLAUDE_PLUGIN_ROOT}/scripts/reports.mjs {IDEA_DIR} --reports cr
node ${CLAUDE_PLUGIN_ROOT}/scripts/gate-check.mjs {IDEA_DIR} merge-review-report-exists
node ${CLAUDE_PLUGIN_ROOT}/scripts/phase-artifacts.mjs {IDEA_DIR} review:merge
```

命令顺序是硬性协议：先写入结构化 JSON/Markdown 报告，再生成独立的
`reports/cr-report.html`，解析并保留生成器返回的 SHA-256。将
`phase-artifacts.mjs` 输出原样发送到对话（其中必须有绝对路径 Markdown 链接，包含
`reports/cr-report.html`），再进入 AskUserQuestion 并停止等待用户决定。HTML renderer 直接读取
`cr/current-change-report.json`，不得用截断 Markdown 代替结构化字段；用户应可在单独页面
查看完整的 readiness、scope、diff、checks、machine CR、risk 和 decision 选项。

重点展示 `cr/current-change-report.md` 与对应 HTML，并摘要说明：

- 审查范围：每个仓库的 base、HEAD、branch、working-tree fingerprint
- 变更概览：文件、增删行、commit、未提交状态
- 行为与 task 覆盖
- 自动 Checks：命令、结果、耗时
- 自动 CR 维度、blocking findings、observations
- API / DB / dependency / security / config 等 reviewer focus
- 风险、兼容性和 merge readiness blockers

报告只读当前变更，不修改业务代码。范围使用 base→当前 working tree；同时包含 staged、unstaged、untracked 文件。任何 HEAD、working tree、final-summary 或报告内容变化都会使旧批准失效。

## 用户决策

使用 `AskUserQuestion` 提供三种决策：

1. `Approve`：批准报告绑定的精确快照进入合并流程
2. `Request changes`：拒绝合并并给出必须修改的意见
3. `Comment / hold`：记录意见或暂缓，不授权合并

不得代替用户选择，不得把模糊回复解释为 Approve。

### Approve

收到明确批准后运行：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/merge-review.mjs {IDEA_DIR} --confirm approve --comment "<用户原始意见摘要>"
node ${CLAUDE_PLUGIN_ROOT}/scripts/gate-check.mjs {IDEA_DIR} merge-review-confirmed
```

用户明确决定后才能运行 `merge-review.mjs --confirm ...`；该命令会把决定同时绑定到 Current Change JSON 和刚展示的 CR HTML 哈希。输出 `confirmations/merge-review.json` 的文件链接。随后重新运行 runner；只有 gate 通过才能进入 `done` 和合并菜单。

### Request changes

运行 `merge-review.mjs ... --confirm request_changes` 记录决策，把用户反馈写入 `{IDEA_DIR}/cr/merge-review-user-feedback.md`，然后将受影响 task 标记为 `needs_rework`。无法准确定位 task 时覆盖所有 task：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-status.mjs {IDEA_DIR} --mark-cr-requirement needs_rework <task-id-1,task-id-2,...>
```

返回 `repair:code`。修复、验证和自动 CR 完成后，必须重新生成报告并重新获得批准。

### Comment / hold

运行 `merge-review.mjs ... --confirm comment` 记录决定，保持在 `review:merge`，等待用户后续明确 Approve 或 Request changes。

## 设计依据

- 仿照 GitHub PR review 的 `Approve / Request changes / Comment` 三态决策
- 仿照 GitHub Checks，把命令、状态和详细证据与人工批准分离
- 仿照 Codex `/review`，明确 base/HEAD/working tree 范围，输出按审阅用途组织的结果且不修改工作树
- 仿照 stale review dismissal：代码快照变化后旧批准自动失效
