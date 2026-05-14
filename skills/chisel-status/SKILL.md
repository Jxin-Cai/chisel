---
name: chisel-status
description: 查看 chisel 需求目录的当前恢复点、task 状态和下一步。当用户询问进度、状态、resume point 或"现在到哪了"时触发。
argument-hint: "<idea-name>"
---

# chisel-status

运行两条命令，用中文简要报告：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-status.mjs .chisel/<idea-name>
node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-status.mjs .chisel/<idea-name> --summary
```

报告内容：当前恢复点、下一步、task 状态总览、待实现/待 CR/待返修/blocked task、关键产物路径。
