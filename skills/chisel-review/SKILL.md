---
name: chisel-review
description: 对 chisel 已实现 task 做资深架构师 CR，从功能完整度、健壮性、并发安全等维度决定 approved、needs_rework 或 blocked。当 chisel 编排器进入 review:cr 阶段时触发。
argument-hint: "<idea-name>"
---

# chisel-review

CR 阶段。不直接改业务代码。

## 执行流程

1. `node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-status.mjs {IDEA_DIR} --next-tasks review`
2. **单 task** → 串行执行：
   - `--start-review <task-id>`
   - 启动 `agent-chisel-architect-reviewer`，传入 TASK：
     ```json
     { "idea_dir": "{IDEA_DIR}", "task_id": "<task-id>" }
     ```
   - CR 完成后运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/cr-parse.mjs {IDEA_DIR} <task-id>` 解析结论
   - 用解析到的结论运行 `--mark-cr <task-id> <result>`（confidence: low 时先展示给用户确认）
3. **多 task** → 并行派发多个 reviewer Agent（reviewer 只读，无需 worktree 隔离）：
   - 对所有 task 串行调用 `--start-review`
   - 在同一条消息中并行启动多个 `agent-chisel-architect-reviewer`
   - 所有 reviewer 返回后，依次解析 CR 结论并用 `--mark-cr` 更新状态

<HARD-GATE>
每个 coded task 必须独立 CR。
上次通过不等于这次通过。
同一 task 返修 3 次后会被脚本标记为 blocked。
</HARD-GATE>
