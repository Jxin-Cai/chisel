---
name: chisel-status
description: 当用户询问进度、状态、resume point 或"现在到哪了"时触发。
argument-hint: "<idea-name>"
allowed-tools: Bash, Read
---

# chisel-status

## 当前工作流状态

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-snapshot.mjs 2>/dev/null || echo "无活跃工作流"`

运行两条只读命令，用中文简要报告。不得调用 `orchestration-transition.mjs`：

```bash
IDEA_DIR=$(node ${CLAUDE_PLUGIN_ROOT}/scripts/control-plane.mjs --project-root . --idea <idea-name>)
node ${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-status.mjs "$IDEA_DIR"
node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-status.mjs "$IDEA_DIR" --summary
```

报告内容：当前状态、state revision、建议恢复点、是否需要 transition、task 状态总览、待实现/待 CR/待返修/blocked task、关键产物路径。优先展示 review/rework backlog，再展示可编码任务。
