# 并行编码指南

当 `--next-tasks code` 返回多个 task 时加载本文件。

## 前置条件

- `--next-tasks` 返回 N > 1 个 task
- 所有 task 的依赖已 approved（由调度器保证）
- `{IDEA_DIR}/worktree-decision.json` 的 `decision` 字段为 `"worktree"`（用户选择了需求级 worktree 隔离）

**如果 `decision` 为 `"current-branch"`，直接降级为串行执行，不使用本文件的并行流程。**

## 多仓环境说明

当 `worktree-decision.json` schema_version=2 且 `repos` 数组非空时，表示工作空间包含多个独立 Git 仓库。

- 每个 task 的 `expected_files` 和 `allowed_files` 中的路径可能跨多个仓库
- 在派发 Agent 编码时，需要根据 task 涉及的文件路径确定其应在哪个仓库的 worktree 中工作
- Agent 的 cwd 应设置为对应仓库的 worktree 路径（从 `repos[].worktree_path` 读取）
- 如果一个 task 跨多个仓库，必须串行执行（在各仓库中依次完成）

## 流程

### 1. 生成确定性并行批次并一次性领取首批任务

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-status.mjs {IDEA_DIR} --prepare-task-batch task-001,task-002,... --project-root . --owner main-orchestrator
```

- `batch` 是当前立即派发的最大安全批次。
- `remaining_batches` 是后续波次；每个波次内部无文件、symbol、invariant、共享资源或 exports/imports 冲突。
- `starts[]` 已包含每个 task 的 `run_id`，无需再逐 task 调用 `--start-task`。

只查看计划而不领取任务时使用 `--parallel-plan task-001,task-002,...`。批次由脚本稳定生成，不再由主编排器手工拆分。

### 2. 并行派发

对每个 task 使用 `Agent({ subagent_type: "agent-chisel-coder", model: <by_task_complexity>, isolation: "worktree" })`（`trivial`/`standard` 不传 model，继承主编排器当前模型；`complex` 传 model: opus），所有 Agent 调用在同一条消息中发出。TASK 输入增加 `"parallel": true` 和该 task 的 `"run_id"`。coder 进入临时 worktree 后必须先运行：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/task-provenance.mjs {IDEA_DIR} <task-id> --rebase-baseline --project-root . --run-id <run-id>
```

写完 report 和 scope proof 后、返回前必须运行 `task-provenance.mjs ... --finish --run-id <run-id>`，冻结该 agent worktree 中的真实 changed files；不要调用 `workflow-status --finish-task`。

注意：这里的 worktree 是 Agent 工具的 **临时隔离机制**（task 级，用完即弃），不是用户在 `worktree:setup` 阶段选择的需求级 worktree。Agent 的临时 worktree 在合并回收后自动清理。

#### 后台 Agent 生命周期硬约束

- 优先在同一条消息中并行发出 Agent 调用并等待它们返回；并行不等于允许主编排器结束当前 turn。
- 如果运行环境使用 `run_in_background: true`，必须保存每个 Agent 返回的 task id，并在派发后对每个任务调用 `TaskOutput(task_id, block: true)` 收割结果。等待期间可以发送简短进度，但不得只回复“后台编码中/等待完成通知”后停止。
- 只要 task 状态仍为 `coding` / `repairing` 且 lease 未过期，主编排器不得 yield。后台完成通知也不等于 task 完成；必须继续执行下方的合并回收、`--finish-task`、report/scope 校验和后续批次。
- 只有 Agent 明确返回 `NEEDS_CONTEXT` / `BLOCKED`，或 lease 已过期且无法恢复任务时，才按对应阻塞流程交还用户。

### 3. 合并回收

每个 Agent 返回后：

1. 如果 Agent 报告有变更（返回 worktree 路径和分支名）：
   - `git merge <worktree-branch>` 合入当前工作分支
   - 合并成功 → 运行 `--finish-task <task-id> coded --run-id <run-id>` + `task-metrics.mjs`（`--finish-task` 会读取 agent 已冻结的 provenance）
   - 合并冲突 → `--finish-task <task-id> failed --run-id <run-id>`，报告冲突文件
2. 如果 Agent 报告无变更或失败：
   - `--finish-task <task-id> failed --run-id <run-id>`

### 4. 批次推进

当前批次全部完成后：
- 如有下一批次 → 重复 2-4
- 所有批次完成 → 交还编排器

## 串行降级

以下情况回退到串行执行（不使用 Agent worktree 隔离）：
- 用户在 `worktree:setup` 选择了 `current-branch`（`worktree-decision.json` decision = "current-branch"）
- 所有 task 有文件/影响面交叉
- 只有 1 个 task
- 返修模式
