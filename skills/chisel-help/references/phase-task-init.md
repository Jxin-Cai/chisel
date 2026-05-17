# Task 初始化指南

当 `resume_step` = `tasks:init` 时加载本文件。

## 流程

1. Read `{IDEA_DIR}/to-be/implementation-plan.md` 中的 task 拆分建议
2. 在 `{IDEA_DIR}/tasks/` 下创建 task 文件（参考 `${CLAUDE_PLUGIN_ROOT}/skills/chisel-help/references/task-template.md`）
3. 调用 `workflow-status.mjs --init-tasks`，**推荐使用 JSON 格式**（避免描述或路径中的冒号导致解析错误）：
   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-status.mjs {IDEA_DIR} --init-tasks <idea-name> \
     '{"taskId":"task-001","depends_on":[],"description":"描述","file":"tasks/task-001.md","expected_files":["src/a.ts"]}' \
     '{"taskId":"task-002","depends_on":["task-001"],"description":"描述","file":"tasks/task-002.md","expected_files":["src/b.ts"]}'
   ```
   `expected_files` 可为空数组但不应省略已知修改范围——并行编码依赖此字段做文件冲突预检。
