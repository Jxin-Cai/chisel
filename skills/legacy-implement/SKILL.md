---
name: legacy-implement
description: 基于已确认的 to-be 方案和 task-workflow-state.yaml，编排 coding subagent 实现 task 并记录变更报告。当 legacy 编排器进入 implement:code 或 repair:code 阶段时触发。
argument-hint: "<idea-name>"
---

# legacy-implement

实现阶段。只处理脚本返回的可执行 task。

## 执行流程

1. `node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-status.mjs {IDEA_DIR} --next-tasks code`
2. 如果没有 code task，运行 `--next-tasks rework`
3. 对每个 task：
   - `--start-task <task-id>`
   - 启动 `agent-legacy-coder`，传入 TASK：
     ```json
     { "idea_dir": "{IDEA_DIR}", "task_id": "<task-id>", "task_file": "tasks/<task-id>.md" }
     ```
   - coder 完成后运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/task-report.mjs {IDEA_DIR} <task-id>`

<HARD-GATE>
只有 `--next-tasks` 返回的 task 才能启动。
有依赖的 task 必须串行。
无依赖的 task 可以并行。
</HARD-GATE>
