# Task 初始化指南

当 `resume_step` = `tasks:init` 时加载本文件。

## 流程

1. Read `{IDEA_DIR}/to-be/implementation-plan.md` 中的 task 拆分建议
2. 在 `{IDEA_DIR}/tasks/` 下创建 task 文件（参考 `${CLAUDE_PLUGIN_ROOT}/skills/chisel-help/references/task-template.md`）
3. 调用：
   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-status.mjs {IDEA_DIR} --init-tasks <idea-name> "task-001:dep1,dep2:描述:tasks/task-001.md:src/a.ts,src/b.ts" ...
   ```
   最后一段是 expected_files，可为空但不应省略已知修改范围。
