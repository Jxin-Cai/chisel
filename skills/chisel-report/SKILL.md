---
name: chisel-report
description: 当用户询问进度、状态、resume point、"现在到哪了"、"dashboard"、"仪表板"、"看板"、"可视化"、"进度图"时触发。
argument-hint: "<idea-name> [--format text|html|all]"
allowed-tools: Bash, Read
---

# chisel-report

## 当前工作流状态

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-snapshot.mjs 2>/dev/null || echo "无活跃工作流"`

## 格式判断

根据用户触发词选择输出格式：
- **text 格式**：用户说"状态"/"进度"/"到哪了"/"resume"，或显式 `--format text`
- **html 格式**：用户说"dashboard"/"仪表板"/"看板"/"可视化"/"进度图"，或显式 `--format html`
- **all 格式**：显式 `--format all` 或用户同时要求两者

## text 格式：状态报告

运行两条只读命令，用中文简要报告。不得调用 `orchestration-transition.mjs`：

```bash
IDEA_DIR=$(node ${CLAUDE_PLUGIN_ROOT}/scripts/control-plane.mjs --project-root . --idea <idea-name>)
node ${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-status.mjs "$IDEA_DIR"
node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-status.mjs "$IDEA_DIR" --summary
```

报告内容：当前状态、state revision、建议恢复点、是否需要 transition、task 状态总览、待实现/待 CR/待返修/blocked task、关键产物路径。优先展示 review/rework backlog，再展示可编码任务。

## html 格式：Dashboard

生成分块 HTML 仪表板，每个维度一个独立 HTML 文件。

1. 从 `$ARGUMENTS` 解析 idea-name
2. 运行 `control-plane.mjs --project-root . --idea <idea-name>`，将输出设为 `{IDEA_DIR}`
3. 运行分块生成器：
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/dashboard-blocks.mjs {IDEA_DIR}
   ```
4. 解析 stdout JSON 获取 `dir` 和 `generated` 数组
5. 在消息中逐一输出每个生成文件的完整路径，格式：
   ```
   Dashboard 已生成：
   - {dir}/overview.html
   - {dir}/as-is.html
   - {dir}/to-be.html
   - {dir}/progress.html
   - {dir}/cr-results.html
   - {dir}/timeline.html
   ```

可通过 `--blocks` 参数只生成部分分块：
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/dashboard-blocks.mjs {IDEA_DIR} --blocks overview,progress
```
