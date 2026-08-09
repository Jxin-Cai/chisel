---
name: chisel-review
description: 当 chisel 编排器进入 review:cr 阶段时触发。
argument-hint: "<idea-name>"
user-invocable: false
---

# chisel-review

多维度独立 CR 阶段。通过 Dynamic Workflow 实现真正并行的维度审查和对抗性验证。

## 当前工作流状态

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-snapshot.mjs 2>/dev/null || echo "无活跃工作流"`

## 动态路径（所有复杂度）

### 执行流程

1. **解析 IDEA_DIR**
   ```bash
   IDEA_DIR=$(node ${CLAUDE_PLUGIN_ROOT}/scripts/control-plane.mjs --project-root . --idea <idea-name>)
   ```

2. **确定 diff 基准**
   从 `worktree-decision.json` 读取 base_commit → 设为 `{BASE_REF}`

3. **获取 review backlog**
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-status.mjs {IDEA_DIR} --next-tasks review
   ```
   对所有待 review 的 task 执行 `--start-review <task-id>`

4. **预计算共享上下文**
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/cr-prepare.mjs {IDEA_DIR} "{BASE_REF}" .
   ```

5. **风险选择（spec 永远必跑）**
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/review-selector.mjs \
     --project-root . --base-ref "{BASE_REF}" --complexity "<complexity>"
   ```
   选择器读取实际 diff、路径和内容：≤2 个路径且 ≤80 行、无高风险信号时
   使用 `review:cr-light`；auth/payment/migration/concurrency/external boundary/
   verification mechanism 任一命中都强制升级并输出理由。结果中的
   `dimension_batches` 直接传给 Dynamic Workflow；`skipped_dimensions` 以
   `status: skipped, result: auto-pass` 投影为旧 D2-D9 文件，保持旧 gate 兼容。

6. **增量复审判断**（rework_cycle > 0 时）
   读取 cr-context-prev.json，对上轮 pass 且 repair 未触及的维度写入 pass-cached。

7. **获取 review budget**
   选择器已经调用 `review-budget.mjs` 生成有界 batches；若 finding 产生对抗性
   验证，再用该脚本按 `finding-count` 补充 skeptic 预算。

8. **调用 Dynamic Workflow**
   ```
   Workflow({
     scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/chisel-review.js",
     args: {
       pluginRoot: "${CLAUDE_PLUGIN_ROOT}",
       ideaDir: "{IDEA_DIR}",
       baseRef: "{BASE_REF}",
       projectRoot: ".",
       complexity: "<complexity>",
       riskLevel: "<risk_level>",
       taskIds: [<task-ids>],
       reworkCycle: <n>,
       activeDimensions: [<activated-dims>],
       dimensionBatches: [[<batch1>], [<batch2>], ...]
     }
   })
   ```

9. **先生成并交付 CR 报告（任何用户决策或状态变更之前）**

   workflow 返回后先读取 `status`，但不得立即询问用户，也不得先写入
   `needs_rework` / `approved`。无论 `approved`、`spec_failed` 还是
   `needs_rework`，都必须先执行完整的报告交付链：

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/cr-report.mjs {IDEA_DIR}
   node ${CLAUDE_PLUGIN_ROOT}/scripts/dashboard-blocks.mjs {IDEA_DIR} --blocks cr-results
   node ${CLAUDE_PLUGIN_ROOT}/scripts/phase-artifacts.mjs {IDEA_DIR} <cr-step>
   ```

   其中 `<cr-step>` 必须与当前路线一致：`review:cr`、`review:cr-light`、
   `review:cr-moderate` 或 `review:integration`。将最后一条命令 stdout
   **原样输出到对话**，确保包含绝对路径 Markdown 链接和
   `dashboard/cr-results.html`；不得只说“已生成”、只给目录或把链接留到最终总结。
   报告 HTML 读取结构化 CR 结果，用户应能在独立浏览器页面 review。

10. **报告交付后再处理 workflow 结果**

   <HARD-GATE principle="P2,P4">
   只有完成步骤 9 的 `cr-report`、`cr-results.html` 和 phase artifact 链接交付后，
   才能根据 `status` 执行状态变更或询问用户。禁止使用 `--finish-task`、
   `--approve-task` 或其他命令改变 task CR 状态；`--mark-cr-requirement` 是唯一合法手段。

   **10a. 当 `status === "approved"`**：

   报告和链接已交付后直接执行：
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-status.mjs {IDEA_DIR} --mark-cr-requirement approved
   ```

   **10b. 当 `status === "spec_failed"` 或 `status === "needs_rework"`**：

   在已经交付的 HTML/文件链接之后，向用户展示 findings 摘要：
   - 失败维度列表及 finding 数量
   - 每个 finding 的维度、严重度（critical/high/medium/low）、一行描述
   - 受影响 task 列表（`affected_tasks`）

   然后使用 `AskUserQuestion` 提供三种选择：

   | 选项 | 描述 |
   |------|------|
   | 接受全部 findings，开始返修 | 将受影响 task 标记为 needs_rework，进入 repair 循环 |
   | 驳回部分 findings | 用户指定驳回项（按编号），剩余 findings 仍触发 rework |
   | 全部 override 为 approved | 忽略所有 findings，强制标记 approved |

   根据用户选择执行：

   - **接受全部**：
     ```bash
     node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-status.mjs {IDEA_DIR} --mark-cr-requirement needs_rework <affected_tasks逗号分隔>
     ```

   - **驳回部分**：
     将用户驳回的 finding 写入 `{IDEA_DIR}/cr/user-dismissed-findings.json`（含时间戳、finding ID、驳回理由）。
     如果驳回后无剩余 findings：
     ```bash
     node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-status.mjs {IDEA_DIR} --mark-cr-requirement approved
     ```
     如果仍有剩余 findings，重新计算受影响 task：
     ```bash
     node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-status.mjs {IDEA_DIR} --mark-cr-requirement needs_rework <仍受影响的tasks>
     ```

   - **全部 override**：
     将 override 决定写入 `{IDEA_DIR}/cr/user-override.json`（含时间戳和用户理由）。
     ```bash
     node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-status.mjs {IDEA_DIR} --mark-cr-requirement approved
     ```

   不得代替用户做出选择。不得在报告交付前询问或直接标记 needs_rework。
   </HARD-GATE>

### Integration Review（条件触发）

当所有 per-task CR 通过且 task_count > 1 且复杂度为 standard/complex 时：
1. 启动 `agent-chisel-reviewer`（opus），dimension=integration
2. `cr-parse.mjs {IDEA_DIR} --dim integration`
3. 先运行 `cr-report.mjs`、`dashboard-blocks.mjs --blocks cr-results` 和
   `phase-artifacts.mjs {IDEA_DIR} review:integration`，将绝对路径链接交付。
4. 交付完成后，pass 才可继续；fail 才可询问用户并执行
   `--mark-cr-requirement needs_rework`。

Integration Review 不走验证子阶段，不使用 workflow。

无论 integration pass 还是 fail，都必须先按步骤 9 生成 CR 汇总报告、
`dashboard/cr-results.html`，并以 `review:integration` 作为 phase-artifacts step
交付绝对路径链接；若 fail，完成交付后才可询问用户并执行
`--mark-cr-requirement needs_rework`。不得先变更状态再生成报告。

<HARD-GATE principle="P2,P4">
spec 是门槛——fail 直接返修，不跑后续质量维度。
返修后必须从 spec 重新开始，不能跳过。
上次通过不等于这次通过。
同一 task 返修 5 次后会被脚本标记为 blocked（第 4-5 轮由 fresh agent 接管）。
必须用 cr-parse.mjs 解析 frontmatter，不得根据正文猜测结论。
workflow 返回后必须通过 workflow-status.mjs 更新 task 状态。

合理化预防表：

| 你的想法 | 现实 |
|---------|------|
| "spec 已通过，后续维度走个过场" | spec 只管合规，质量需要独立深度审查 |
| "改动很小，用一次调用审查多个维度" | 每个维度独立调用，注意力不稀释 |
| "CR 报告中说了通过就行" | 必须用 cr-parse.mjs 解析 frontmatter |
| "只有一个 task，不需要完整流程" | 单 task 也走完整流程 |
| "验证子阶段太慢，跳过" | 验证是假阳性控制的关键环节，不可跳过 |
| "workflow 失败了，直接标记 approved" | workflow 失败时报告错误，不改状态 |
</HARD-GATE>
