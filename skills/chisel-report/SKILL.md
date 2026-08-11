---
name: chisel-report
description: 当用户询问进度、状态、resume point、"现在到哪了"、HTML 报告、看板、可视化或进度图时触发。
argument-hint: "<idea-name> [--format text|html|all]"
allowed-tools: Bash, Read
---

# chisel-report

## 当前工作流状态

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-snapshot.mjs 2>/dev/null || echo "无活跃工作流"`

## 格式判断

根据用户触发词选择输出格式：
- **text 格式**：用户说"状态"/"进度"/"到哪了"/"resume"，或显式 `--format text`
- **html 格式**：用户说"报告"/"看板"/"可视化"/"进度图"，或显式 `--format html`
- **all 格式**：显式 `--format all` 或用户同时要求两者

## text 格式：状态报告

运行两条只读命令，用中文简要报告。不得调用 `orchestration-transition.mjs`：

```bash
IDEA_DIR=$(node ${CLAUDE_PLUGIN_ROOT}/scripts/control-plane.mjs --project-root . --idea <idea-name>)
node ${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-status.mjs "$IDEA_DIR"
node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-status.mjs "$IDEA_DIR" --summary
```

报告内容：当前状态、state revision、建议恢复点、是否需要 transition、task 状态总览、待实现/待 CR/待返修/blocked task、关键产物路径。优先展示 review/rework backlog，再展示可编码任务。

## html 格式：独立报告

生成五类独立 HTML 报告。一次只能生成一份；每份都必须获得用户明确确认后，才能生成下一份或推进工作流。

1. 从 `$ARGUMENTS` 解析 idea-name
2. 运行 `control-plane.mjs --project-root . --idea <idea-name>`，将输出设为 `{IDEA_DIR}`
3. 根据用户需要选择报告。全量请求按 `as-is → to-be → test → cr → task-time` 排序，但本轮只生成第一份：
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/reports.mjs {IDEA_DIR} --reports <report-type>
   ```
4. 解析 stdout JSON 的 `generated[0].path` 与 `generated[0].sha256`
5. 立即输出一个可点击链接、报告哈希，并询问用户是否确认。然后结束当前 turn，不得生成下一份：
   ```
   HTML 报告待确认：[{idea-name} · As-Is]({IDEA_DIR}/reports/as-is-report.html)
   SHA-256: <sha256>
   请明确回复“确认”或指出需要修改的内容。
   ```
6. 只有用户明确确认后，才运行：
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/report-confirm.mjs {IDEA_DIR} <report-type> --confirm --expected-sha <sha256>
   node ${CLAUDE_PLUGIN_ROOT}/scripts/report-confirm.mjs {IDEA_DIR} <report-type>
   ```
7. 第二条命令返回 `valid: true` 后，输出确认凭据文件链接。若还有报告，再生成下一份并重复；若报告被修改或重新生成，必须使用新哈希重新确认。
