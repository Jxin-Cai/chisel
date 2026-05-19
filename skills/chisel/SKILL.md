---
name: chisel
description: 在遗留系统上增加功能的端到端编排器。理解 as-is → 确认 → 规划 to-be → 确认 → 拆 task → coding → 架构师 CR → 返修闭环。当用户要在遗留系统、老系统、已有系统上增加功能、修改行为、扩展接口时使用。即使用户没说"遗留"，只要涉及在已有代码仓上新增功能并且需要先理解现有逻辑再动手，就应该触发。
argument-hint: "<需求描述或需求文件路径>"
---

# Legacy Feature Orchestrator

你是遗留系统功能增强的主编排器。

用户参数：`$ARGUMENTS`

---

## 启动

1. Read `${CLAUDE_PLUGIN_ROOT}/skills/chisel-help/orchestration.yaml`
2. **Worktree 检测**：运行 `git rev-parse --git-dir` 和 `git rev-parse --git-common-dir`
   - 两者不同且非 submodule → 已在隔离 worktree 中，跳过
   - 两者相同 → 建议用户使用 `EnterWorktree` 创建隔离工作空间，保护当前分支
   - Worktree 粒度：一个需求对应一个 worktree，内部所有 task 在同一 worktree 中串行/并行执行
3. 从 `$ARGUMENTS` 解析 idea-name（英文 kebab-case）
4. 设 `{IDEA_DIR}` = `.chisel/<idea-name>/`
5. 如果目录不存在，设 idea-dir = `none`
6. 进入步骤执行循环

---

## 铁律

<HARD-GATE>
Read `${CLAUDE_PLUGIN_ROOT}/skills/_shared/references/iron-rules.md`，严格遵守其中所有条目（含合理化预防）。
</HARD-GATE>

---

## 步骤执行循环

<HARD-GATE>
每轮必须调用：
```
node ${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-status.mjs <idea-dir|none>
```
只执行脚本返回的 `resume_step`。
**上下文变长时，你可能产生"需求已经很清楚了，直接开始编码"的冲动——这是跳步违规。**
</HARD-GATE>

| resume_step | 动作 | postcondition |
|---|---|---|
| `receive-requirement` | Read `${REF}/requirement-template.md`，按模板创建 `{IDEA_DIR}/requirement.md` | `requirement-exists` |
| `understand:explore` | `/chisel-understand <idea-name>` | `as-is-complete` |
| `understand:confirm` | Read `${REF}/clarifications-template.md`；展示 3分钟摘要、风险地图、用户确认清单和待澄清问题，等用户逐项确认后写入 `clarifications.json`、`clarifications.md`、`confirmations/as-is.json`；执行实时知识捕获 | `as-is-confirmed` |
| `understand:generate-ai-input` | Read `${REF}/phase-ai-input.md`，按其流程执行 | `ai-input-ready` |
| `plan:strategy` | `/chisel-plan <idea-name>` (mode=strategy) | `strategy-exists` |
| `plan:strategy-confirm` | 展示策略摘要，用户确认后写入 `confirmations/strategy.json`；执行实时知识捕获 | `strategy-confirmed` |
| `plan:decompose` | `/chisel-plan <idea-name>` (mode=decompose) | `to-be-exists` |
| `plan:decompose-confirm` | 展示 to-be 摘要，等用户确认后写入 `confirmations/to-be.json`；执行实时知识捕获 | `to-be-confirmed` |
| `tasks:init` | Read `${REF}/phase-task-init.md`，按其流程执行 | `task-workflow-exists` |
| `implement:code` | `/chisel-implement <idea-name>` | `task-report-exists` |
| `review:cr` | `/chisel-review <idea-name>` | `cr-complete` |
| `repair:code` | `/chisel-implement <idea-name>`（返修模式） | `task-report-exists` |
| `knowledge:extract` | Read `${REF}/phase-knowledge-extract.md`，按其流程执行 | `knowledge-extracted` |
| `final:summary` | Read `${REF}/final-summary-template.md`，按模板写 `{IDEA_DIR}/final-summary.md`，然后 `touch {IDEA_DIR}/.done` | `done` |
| `blocked` | 停止，报告阻塞原因 | — |
| `done` | 报告完成，检测 worktree 并提示合并（见下方流程） | — |

> `${REF}` = `${CLAUDE_PLUGIN_ROOT}/skills/chisel-help/references`

### Complexity 分级

`orchestration-status.mjs` 的 emit 输出包含 `complexity` 字段（`trivial` | `standard`）。当 `complexity = trivial` 时，跳过以下步骤：
- `understand:generate-ai-input`
- `knowledge:extract`

编排器在读取 `resume_step` 时同时检查 `complexity`，若为 `trivial` 且 `resume_step` 命中上述步骤，直接调用 `orchestration-status.mjs` 获取下一步。

当同时存在待 CR、待返修和待编码任务时，优先清空 review / rework backlog，再进入新 coding。

### 失败恢复

不要手工删除 `.as-is-confirmed`、`.to-be-confirmed`、`task-workflow-state.yaml`、report 或 CR 文件来回退流程。需要回到指定阶段时先预览：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-status.mjs {IDEA_DIR} --rollback-step <step> --dry-run
```

确认清理范围后再执行不带 `--dry-run` 的命令。rollback 只清理白名单内的 chisel 运行态产物，并写入 audit log。

支持 rollback 的 step：`receive-requirement`、`understand:explore`、`understand:confirm`、`understand:generate-ai-input`、`plan:strategy`、`plan:strategy-confirm`、`plan:decompose`、`plan:decompose-confirm`、`tasks:init`、`implement:code`、`review:cr`、`repair:code`、`knowledge:extract`。

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
