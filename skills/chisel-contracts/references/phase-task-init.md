# Task 初始化指南

当 `resume_step` = `tasks:init` 时加载本文件。

## 流程

1. 确认 `{IDEA_DIR}/to-be/tasks.json` 存在。该文件由 planner 产出，是 task 初始化的唯一结构化输入。
2. 先做只读校验：
   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/task-init.mjs {IDEA_DIR} --idea <idea-name> --from to-be/tasks.json --check
   ```
3. 校验通过后生成 task 文件和状态机：
   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/task-init.mjs {IDEA_DIR} --idea <idea-name> --from to-be/tasks.json
   ```
4. 运行完整性 gate：
   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/gate-check.mjs {IDEA_DIR} task-integrity
   ```

<HARD-GATE>
不要手工搬运 task 到 workflow-status.mjs。缺字段时回到 plan 阶段修正。已存在 task 文件时默认拒绝覆盖，需用户明确要求 `--force`。
</HARD-GATE>
