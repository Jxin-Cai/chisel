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

### 1. 文件与影响面冲突预检

```
node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-status.mjs {IDEA_DIR} --check-overlap task-001,task-002,...
```

- 无 `file_overlap` 且无 `impact_overlap` → 所有 task 可并行
- 有 `file_overlap` 或 `impact_overlap` → 重叠 task 必须串行，其余可并行

将 task 分为并行批次：同批次内无文件重叠、无 symbol/invariant/shared_state 影响面重叠。

### 2. 状态前置更新

对当前批次所有 task **串行**调用 `--start-task`（确保状态原子更新）。

### 3. 并行派发

对每个 task 使用 `Agent({ isolation: "worktree" })`，所有 Agent 调用在同一条消息中发出。TASK 输入增加 `"parallel": true`，告知 coder 不要自行更新状态。

注意：这里的 worktree 是 Agent 工具的 **临时隔离机制**（task 级，用完即弃），不是用户在 `worktree:setup` 阶段选择的需求级 worktree。Agent 的临时 worktree 在合并回收后自动清理。

### 4. 合并回收

每个 Agent 返回后：

1. 如果 Agent 报告有变更（返回 worktree 路径和分支名）：
   - `git merge <worktree-branch>` 合入当前工作分支
   - 合并成功 → 运行 `task-metrics.mjs` + `--finish-task <task-id> coded`
   - 合并冲突 → `--finish-task <task-id> failed`，报告冲突文件
2. 如果 Agent 报告无变更或失败：
   - `--finish-task <task-id> failed`

### 5. 批次推进

当前批次全部完成后：
- 如有下一批次 → 重复 2-4
- 所有批次完成 → 交还编排器

## 串行降级

以下情况回退到串行执行（不使用 Agent worktree 隔离）：
- 用户在 `worktree:setup` 选择了 `current-branch`（`worktree-decision.json` decision = "current-branch"）
- 所有 task 有文件/影响面交叉
- 只有 1 个 task
- 返修模式
