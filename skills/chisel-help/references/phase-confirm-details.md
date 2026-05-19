# 阶段详细行为指南

由 `chisel/SKILL.md` 按需加载。仅在进入对应步骤时 Read 本文件。

---

## understand:confirm 详细行为

读取并展示 `{IDEA_DIR}/as-is/overview.md` 中的 `3分钟摘要`、`风险地图`、`用户确认清单` 和 `待澄清问题`，等用户逐项确认或补充。

将结果写入 `{IDEA_DIR}/clarifications.json`（权威机器可读记录）和 `{IDEA_DIR}/clarifications.md`（人类可读镜像）。`clarifications.json` 必须包含每个 `C-xxx` 的 `id/question/decision/rationale/status/source`，状态只能是 `confirmed/defaulted/deferred`。

同时写入 `{IDEA_DIR}/confirmations/as-is.json`，至少包含：`schema_version: 1`、`phase: "as-is"`、`status: "confirmed"`、`confirmed_at`、`confirmed_by: "user"`、`source_files`、`checklist`。

新流程不得只创建 `.as-is-confirmed` marker；该 marker 仅用于历史运行目录兼容。

---

## plan:strategy-confirm 详细行为

展示 `{IDEA_DIR}/to-be/implementation-plan.md` 中的实现策略方向、设计决策、允许修改范围和禁止修改范围，等用户确认策略方向正确。

确认后写入 `{IDEA_DIR}/confirmations/strategy.json`，至少包含：`schema_version: 1`、`phase: "strategy"`、`status: "confirmed"`、`confirmed_at`、`confirmed_by: "user"`、`source_files`、`strategy_acknowledgement`。

用户可以在此阶段要求调整策略方向，调整后需重新运行 `plan:strategy`。

---

## plan:decompose-confirm 详细行为

展示 `{IDEA_DIR}/to-be/implementation-plan.md` 中的目标行为、非目标行为、允许修改范围、禁止修改范围、Task 拆分建议、风险和回滚信息，等用户明确确认。

确认后写入 `{IDEA_DIR}/confirmations/to-be.json`，至少包含：`schema_version: 1`、`phase: "to-be"`、`status: "confirmed"`、`confirmed_at`、`confirmed_by: "user"`、`source_files`、`task_acknowledgement`、`risk_acknowledgement`。

新流程不得只创建 `.to-be-confirmed` marker；该 marker 仅用于历史运行目录兼容。

---

## final:summary 详细行为

写入 `{IDEA_DIR}/final-summary.md`，必须包含：变更摘要、验证结果、Scope Control Summary、Knowledge Candidates、Wiki Updates。只有写完后才允许 `touch {IDEA_DIR}/.done`。

---

## 完成后合并流程

当 `resume_step` = `done` 且 `phase_detail.in_worktree` = `true` 时：

1. `git log --oneline main..HEAD` 展示本次需求所有 commit
2. 告知用户："需求 `{idea-name}` 已完成，当前在 worktree 分支 `{branch}` 中。"
3. 提供两种合并选项：
   - **创建 PR**：`git push -u origin {branch}`，然后协助创建 Pull Request
   - **直接合并**：提醒用户先 `ExitWorktree` 回到主分支，再 `git merge {branch}`
4. 等待用户选择后协助执行

当 `phase_detail.in_worktree` = `false` 时，直接报告完成，不触发合并流程。

---

## 实时知识捕获

在 `understand:confirm`、`plan:strategy-confirm` 和 `plan:decompose-confirm` 对话中，监听知识信号（"不能动"/"历史原因"/"以后再改"/业务术语映射）并按 agent-shared-rules §2 即时写入 `{IDEA_DIR}/knowledge-candidates/`。候选由 `knowledge:extract` 阶段统一去重和合入。无信号时不创建候选文件。
