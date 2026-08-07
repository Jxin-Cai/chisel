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

## Trivial 快速路径（review:cr-light）

如果当前需求复杂度为 `trivial`（读取 `{IDEA_DIR}/requirement.md` 判断复杂度），则：
- **只执行 Spec 门槛**（不使用 workflow）
- 启动 `agent-chisel-reviewer`（opus），dimension=spec
- `cr-parse.mjs {IDEA_DIR} --dim spec`
- pass → `--mark-cr-requirement approved`
- fail → `--mark-cr-requirement needs_rework`

## Moderate 路径（review:cr-moderate）

如果当前需求复杂度为 `moderate`，则：
- 执行 Spec 门槛（同上）
- Spec pass → 只启动 D3 + D4 + D5（不使用 workflow，逐个启动 reviewer）
- D2/D6/D7/D8/D9 自动写入 pass CR 文件（理由: "moderate 路径仅审查 spec+D3+D4+D5"）
- 不执行验证子阶段
- 全 pass → `--mark-cr-requirement approved`
- 任一 fail → `--mark-cr-requirement needs_rework`

## Standard/Complex 路径（使用 Dynamic Workflow）

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

5. **条件激活**
   分析变更文件特征，决定哪些维度需要激活（D3/D4/D5/D6 始终激活；D2/D7/D8/D9 按 grep 条件激活）。
   未激活维度自动写入 pass CR 文件。

6. **增量复审判断**（rework_cycle > 0 时）
   读取 cr-context-prev.json，对上轮 pass 且 repair 未触及的维度写入 pass-cached。

7. **获取 review budget**
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/review-budget.mjs --dimensions <activated> --finding-count 0 --risk-level <level>
   ```
   从输出中获取 `dimension_batches`。

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

9. **解释 workflow 返回结果**
   - `status: "spec_failed"` → `workflow-status.mjs --mark-cr-requirement needs_rework <affected_tasks>`
   - `status: "needs_rework"` → `workflow-status.mjs --mark-cr-requirement needs_rework <affected_tasks>`
   - `status: "approved"` → `workflow-status.mjs --mark-cr-requirement approved`

10. **生成 CR 汇总报告**
    ```bash
    node ${CLAUDE_PLUGIN_ROOT}/scripts/cr-report.mjs {IDEA_DIR}
    ```

11. **更新 dashboard**
    ```bash
    node ${CLAUDE_PLUGIN_ROOT}/scripts/dashboard-blocks.mjs {IDEA_DIR} --blocks cr-results
    ```

### Integration Review（条件触发）

当所有 per-task CR 通过且 task_count > 1 且复杂度为 standard/complex 时：
1. 启动 `agent-chisel-reviewer`（opus），dimension=integration
2. `cr-parse.mjs {IDEA_DIR} --dim integration`
3. pass → 流程继续；fail → `--mark-cr-requirement needs_rework`

Integration Review 不走验证子阶段，不使用 workflow。

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
