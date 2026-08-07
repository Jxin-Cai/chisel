---
name: chisel-dashboard
description: 当用户说"dashboard"、"仪表板"、"看板"、"可视化"、"进度图"时触发。
argument-hint: "<idea-name>"
allowed-tools: Bash, Read
---

# chisel-dashboard

生成分块 HTML 仪表板，每个维度一个独立 HTML 文件，展示当前工作流进度、task 状态、CR 维度结果、需求覆盖度、To-Be 方案和时间线。

## 执行流程

1. 从 `$ARGUMENTS` 解析 idea-name
2. 运行 `control-plane.mjs --project-root . --idea <idea-name>`，将输出设为 `{IDEA_DIR}`
3. 运行分块生成器：
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/dashboard-blocks.mjs {IDEA_DIR}
   ```
4. 解析 stdout JSON 获取 `dir` 和 `generated` 数组
5. **在消息中逐一输出每个生成文件的完整路径**，格式：
   ```
   📊 Dashboard 已生成：
   - {dir}/overview.html
   - {dir}/as-is.html
   - {dir}/to-be.html
   - {dir}/progress.html
   - {dir}/cr-results.html
   - {dir}/timeline.html
   ```
   用户可通过 Read tool 查看内容，或在浏览器中打开。

## 输出

- `{IDEA_DIR}/dashboard/` 目录下 6 个独立 HTML 文件：
  - `overview.html` — 工作流总览（进度、Task 完成率、需求覆盖、耗时）
  - `as-is.html` — 现状理解（概览、核心走查、证据索引、质量评分）
  - `to-be.html` — 方案设计（需求覆盖、改造点、Task 拆分、风险矩阵）
  - `progress.html` — 实现进度（Task 状态矩阵、需求覆盖度）
  - `cr-results.html` — CR 审查结果（维度总览、Rework 项）
  - `timeline.html` — 时间线与产出（环节耗时、步骤产出）

## 指定分块

可通过 `--blocks` 参数只生成部分分块：
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/dashboard-blocks.mjs {IDEA_DIR} --blocks overview,progress
```
