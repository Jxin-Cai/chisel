---
name: chisel-dashboard
description: 生成工作流可视化仪表板。当用户说"dashboard"、"仪表板"、"看板"、"可视化"、"进度"时触发。
argument-hint: "<idea-name>"
allowed-tools: Bash, Read
---

# chisel-dashboard

生成自包含 HTML 仪表板，展示当前工作流进度、task 状态、CR 维度结果、分层需求可追溯覆盖度、To-Be 拆解链路、DB/API 变更契约和 as-is 内容。

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
  - Task 状态矩阵（着色表格，task ID 可点击查看 task/report/CR 详情）
  - CR 维度雷达图
  - 需求可追溯覆盖进度条（REQ/AC/C/VC 需求类统计，RISK 单独展示不计入覆盖率）
  - To-Be 方案视图（方案概览、需求拆解链路、CP 改造点、Task 拆分、数据变更、API 契约、风险与缓解）
  - DB 数据变更视图（优先读取 `to-be/data-change-plan.json` 渲染 ER 图和字段 diff，Markdown 兜底）
  - API 契约变更视图（优先读取 `to-be/api-change-plan.json` 渲染 endpoint/request/response diff，Markdown 兜底）
  - As-Is 查看器（Tab 切换：概览、核心走查、证据表、质量评分雷达图、覆盖矩阵）
  - 步骤时间线
