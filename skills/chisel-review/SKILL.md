---
name: chisel-review
description: 对 chisel 已实现 task 做资深架构师 CR，从功能完整度、健壮性、并发安全等维度决定 approved、needs_rework 或 blocked。当 chisel 编排器进入 review:cr 阶段时触发。
argument-hint: "<idea-name>"
---

# chisel-review

CR 阶段。不直接改业务代码。

## 执行流程

1. `node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-status.mjs {IDEA_DIR} --next-tasks review`
2. 对每个 task：
   - `--start-review <task-id>`
   - 启动 `agent-chisel-architect-reviewer`，传入 TASK：
     ```json
     { "idea_dir": "{IDEA_DIR}", "task_id": "<task-id>" }
     ```
   - CR 完成后运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/cr-parse.mjs {IDEA_DIR} <task-id>` 解析结论
   - 用解析到的结论运行 `--mark-cr <task-id> <result>`（如果 cr-parse 返回 confidence: low，先展示给用户确认）

<HARD-GATE>
每个 coded task 必须独立 CR。
上次通过不等于这次通过。
同一 task 返修 3 次后会被脚本标记为 blocked。
</HARD-GATE>
