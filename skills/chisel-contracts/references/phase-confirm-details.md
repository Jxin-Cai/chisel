# 阶段详细行为指南

由 `chisel/SKILL.md` 按需加载。仅在进入对应步骤时 Read 本文件。

---

## understand:confirm 详细行为

读取并展示 `{IDEA_DIR}/as-is/overview.md` 中的 `3分钟摘要`、`风险地图`、`用户确认清单` 和 `待澄清问题`，等用户逐项确认或补充。

将结果写入 `{IDEA_DIR}/clarifications.json`（权威机器可读记录）和 `{IDEA_DIR}/clarifications.md`（人类可读镜像）。`clarifications.json` 必须包含每个 `C-xxx` 的 `id/question/decision/rationale/status/source`，状态只能是 `confirmed/defaulted/deferred`。

同时写入 `{IDEA_DIR}/confirmations/as-is.json`，至少包含：`schema_version: 1`、`phase: "as-is"`、`status: "confirmed"`、`confirmed_at`、`confirmed_by: "user"`、`source_files`、`checklist`。

新流程不得只创建 `.as-is-confirmed` marker；该 marker 仅用于历史运行目录兼容。

---

## plan:confirm 详细行为

展示 `{IDEA_DIR}/to-be/implementation-plan.md` 中的实现策略方向、设计决策、目标行为、非目标行为、**改造点映射**（保留/改造/新增/删除决策表）、允许修改范围、禁止修改范围、Task 拆分建议、风险和回滚信息，等用户明确确认。

### 风险报告展示

如果 `{IDEA_DIR}/to-be/impact-risk-report.json` 存在，必须向用户展示：

1. **影响概览**：改造点数、影响文件数、影响符号数、总风险等级
2. **风险矩阵**：每个 RISK 条目的类别、描述、严重度、可能性、缓解方式
3. **最高风险项**：`summary.highest_risk` 高亮展示

用户必须在看过风险报告后才能确认。

### 确认凭据

确认后写入 `{IDEA_DIR}/confirmations/to-be.json`，必须严格包含以下结构（gate-check 会逐字段校验）：

```json
{
  "schema_version": 1,
  "phase": "to-be",
  "status": "confirmed",
  "confirmed_at": "<ISO 8601>",
  "confirmed_by": "user",
  "source_files": ["to-be/implementation-plan.md", "to-be/tasks.json", "to-be/traceability-matrix.json", "to-be/impact-risk-report.json"],
  "task_acknowledgement": {
    "task_ids": ["task-001", "task-002"],
    "dependencies_reviewed": true
  },
  "risk_acknowledgement": {
    "reviewed": true,
    "risk_level": "medium",
    "risk_count": 3
  }
}
```

- `task_acknowledgement.task_ids` 必须列出 `to-be/tasks.json` 中所有 task_id
- `task_acknowledgement.dependencies_reviewed` 必须为 `true`
- `risk_acknowledgement.reviewed` 必须为 `true`
- `risk_acknowledgement.risk_level` 应填 impact-risk-report.json 的 `summary.risk_level`
- `risk_acknowledgement.risk_count` 应填 `risk_matrix` 数组长度
- 任何字段缺失或值错误都会导致 `to-be-confirmed` gate 失败

新流程不得只创建 `.to-be-confirmed` marker；该 marker 仅用于历史运行目录兼容。

用户可以在此阶段要求调整方案，调整后需重新运行 `plan:design`。

---

## final:summary 详细行为

写入 `{IDEA_DIR}/final-summary.md`，必须包含：变更摘要、验证结果、Scope Control Summary。

验证证据汇总：从所有 task-report 的验证表格中提取结果，在 final-summary 中以汇总表形式展示：

```markdown
## 验证证据汇总

| Task | 验证项 | 命令 | 结果 |
|------|--------|------|------|
| task-001 | ... | ... | PASS |
```

写完后运行 `final-summary-complete` gate。此时禁止创建 `.done`；必须先完成 `review:merge` 并获得用户对当前代码快照的明确批准。

---

## 完成后合并流程

当 `resume_step` = `done` 时：

先运行 `gate-check.mjs {IDEA_DIR} merge-review-confirmed`。通过后才允许 `touch {IDEA_DIR}/.done` 并展示合并选项。若 HEAD 或工作区在批准后发生变化，gate 会失效，必须重新生成 Current Change Report 并重新批准。

### 1. 环境检测

先运行 locator（可从 outer workspace、原 repo 或 linked worktree 启动），再读取
`{IDEA_DIR}/worktree-decision.json` 和 registry 判断多仓 vs 单仓：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/control-plane.mjs --locate --project-root . --idea <idea-name>
node ${CLAUDE_PLUGIN_ROOT}/scripts/multi-repo-worktree.mjs --resume <idea-name> --project-root .
```

**单仓模式**（schema_version=1 或无 repos 字段）：
```bash
GIT_DIR=$(git rev-parse --git-dir)
GIT_COMMON=$(git rev-parse --git-common-dir)
BRANCH=$(git branch --show-current)
```

- `GIT_DIR ≠ GIT_COMMON` → 在 worktree 中（完整 5 选项）
- `GIT_DIR = GIT_COMMON` 且当前分支非主干 → 在主仓库功能分支上（选项 1/2/3）
- `GIT_DIR = GIT_COMMON` 且当前分支是主干 → 已合并完成（仅提示）

**多仓模式**（schema_version=2/3，repos 数组非空）：
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/multi-repo-worktree.mjs --status <idea-name>
```

### 2. 展示变更概要

**单仓**：
```bash
git log --oneline main..HEAD
```

**多仓**：对每个仓库分别展示：
```bash
# 在各 worktree 目录中
git -C <worktree-path> log --oneline <default-branch>..HEAD
```

告知用户："需求 `{idea-name}` 已完成，涉及 N 个仓库。"

### 3. 结构化选项菜单

使用 `AskUserQuestion` 向用户呈现选项：

**在 worktree 中时（5 选项）：**

| 选项 | 描述 |
|------|------|
| 创建 PR | 推送分支并创建 Pull Request（推荐） |
| 合并到主干 | 将变更合并到主干分支（含智能冲突分析） |
| 转为常规分支 | 移除 worktree 保留分支，回归常规 git 分支管理 |
| 保留分支 | 暂不处理，保留当前分支稍后决定 |
| 放弃变更 | 丢弃所有变更并清理 worktree |

**在主仓库功能分支上时（3 选项）：**

| 选项 | 描述 |
|------|------|
| 创建 PR | 推送分支并创建 Pull Request（推荐） |
| 合并到主干 | 将变更合并到主干分支（含智能冲突分析） |
| 保留分支 | 暂不处理，保留当前分支稍后决定 |

### 4. 执行用户选择

**单仓**：

- **创建 PR**：`git push -u origin {branch}`，然后用 `gh pr create` 创建 PR，展示 PR URL

- **合并到主干（含冲突分析）**：
  1. 不转换、不 checkout 主仓；运行 `branch-merge.mjs --merge`，脚本在独立
     integration worktree 中执行并返回 receipt。外部 merge/push 前必须得到
     用户确认并传 `--confirm`，目标远端 fetch 后若漂移则停止，绝不 force push。
  2. `status: "merged"` → 记录 receipt；`status: "conflicts_detected"` →
     保留 integration worktree 和外部 `.chisel-merge-receipts/*-conflict.json`，进入专门冲突链路。

- **转为常规分支**（只在用户选择此项时）：
  1. 展示当前分支提交数：`git log --oneline {default-branch}..HEAD | wc -l`
  2. 执行转换：`node ${CLAUDE_PLUGIN_ROOT}/scripts/branch-merge.mjs --convert {branch} --repo .`
  3. 处理结果：
     - `status: "converted"` → 告知用户："Worktree 已移除，分支 `{branch}` 保留了 N 个提交；主仓 checkout 未被切换。"
     - `status: "uncommitted_changes"` → 告知有未提交变更，列出脏文件，建议先 commit 或 stash
  4. 更新 `{IDEA_DIR}/worktree-decision.json`，添加 `"converted_at": "<ISO 8601>"`

- **保留分支**：仅提示用户分支名和 worktree 路径，告知后续可用 `/chisel-branch` 管理

- **放弃变更**：先展示将被删除的内容（分支名、commit 列表 `git log --oneline main..HEAD`），要求用户明确输入"确认放弃"后才执行 `ExitWorktree(action: "remove", discard_changes: true)`。未收到确认文字前不得执行删除。

**多仓**：

- **创建 PR**：对每个仓库的 worktree 分支执行 `git -C <worktree-path> push -u origin {branch}`，然后在每个仓库创建 PR（`gh pr create`），汇总展示所有 PR URL

- **合并到主干（含冲突分析）**：
  1. 不先转换 worktree；对每个仓库在独立 integration worktree 执行
     `branch-merge.mjs --merge --source {branch} --target {default-branch} --repo <repo-path>`。
  2. 持久化逐仓 receipt/delivery 状态，汇总成功、失败和冲突；部分成功必须显式记录。
  3. 冲突按外部 receipt 的 base/ours/theirs 报告处理，用户确认后
     `--continue --confirm`，验证无 unmerged 后 commit，再按需安全 push。

- **转为常规分支**：
  1. 执行转换：`node ${CLAUDE_PLUGIN_ROOT}/scripts/multi-repo-worktree.mjs --convert <idea-name> --repos <...>`
  2. 展示每个仓库的转换结果
  3. 告知后续可用 `/chisel-branch` 管理各仓库分支

- **保留分支**：提示每个仓库的分支名和 worktree 路径

- **放弃变更**：展示所有仓库将被删除的内容，确认后执行 cleanup

---
