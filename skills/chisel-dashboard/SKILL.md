---
name: chisel-dashboard
description: 生成工作流可视化仪表板。当用户说"dashboard"、"仪表板"、"看板"、"可视化"、"进度"时触发。
argument-hint: "<idea-name>"
---

# chisel-dashboard

生成自包含 HTML 仪表板，展示当前工作流进度、task 状态、CR 维度结果、需求可追溯覆盖度和 as-is 内容。

## 执行流程

1. 从 `$ARGUMENTS` 解析 idea-name
2. 设 `{IDEA_DIR}` = `.chisel/<idea-name>/`
3. 运行生成器：
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/dashboard.mjs {IDEA_DIR}
   ```
4. 解析 stdout JSON 获取输出路径
5. 提示用户在浏览器中打开生成的 HTML 文件

## 输出

- `{IDEA_DIR}/dashboard.html` — 自包含 HTML（含 Mermaid CDN + Chart.js CDN）
- 包含内容：
  - 工作流步骤进度条（当前步高亮）
  - Task 状态矩阵（着色表格）
  - CR 维度雷达图
  - 需求可追溯覆盖进度条
  - As-Is 查看器（Tab 切换：概览、核心走查、证据表、质量评分雷达图、覆盖矩阵）
  - 步骤时间线
