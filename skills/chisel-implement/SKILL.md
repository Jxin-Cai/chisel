---
name: chisel-implement
description: 基于已确认的 to-be 方案和 task-workflow-state.yaml，编排 coding subagent 实现 task 并记录变更报告。当 chisel 编排器进入 implement:code 或 repair:code 阶段时触发。
argument-hint: "<idea-name>"
---

# chisel-implement

实现阶段。只处理脚本返回的可执行 task。

## 执行流程

1. `node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-status.mjs {IDEA_DIR} --next-tasks rework`
   - 如有 rework task → 串行处理（返修不并行）
2. 如果没有 rework task，运行 `--next-tasks code`
3. **单 task** → 串行执行：
   - `--start-task <task-id>`
   - 启动 `agent-chisel-coder`，传入 TASK：
     ```json
     { "idea_dir": "{IDEA_DIR}", "task_id": "<task-id>", "task_file": "tasks/<task-id>.md" }
     ```
   - coder 完成后运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/task-metrics.mjs {IDEA_DIR} <task-id>`
4. **多 task** → Read `${CLAUDE_PLUGIN_ROOT}/skills/chisel-help/references/phase-parallel-coding.md`，按其流程并行执行

<HARD-GATE>
只有 `--next-tasks` 返回的 task 才能启动。
有依赖的 task 必须串行。
有 expected_files 重叠的 task 必须串行（用 `--check-overlap` 检测）。
无依赖且无文件重叠的 task 通过 worktree 并行。
</HARD-GATE>
