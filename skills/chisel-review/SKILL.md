---
name: chisel-review
description: 当 chisel 编排器进入 review:cr 阶段时触发。
argument-hint: "<idea-name>"
user-invocable: false
---

# chisel-review

多维度独立 CR 阶段。先通过 Dynamic Workflow 并行完成各维度审查，再由高级模型全局汇总；
只对高风险、矛盾或不确定项做有界独立核验，最后由高级模型完成根因合并与最终裁决。
只有最终裁决完成后才允许进入返修。

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
     {IDEA_DIR} --write --project-root . --base-ref "{BASE_REF}" --complexity "<complexity>"
   ```
   选择器读取实际 diff、路径和内容：≤2 个路径且 ≤80 行、无高风险信号时
   使用 `review:cr-light`；auth/payment/migration/concurrency/external boundary/
   verification mechanism 任一命中都强制升级并输出理由。选择器会用同一事务写入
   `{IDEA_DIR}/cr/review-selection.json` 和
   `{IDEA_DIR}/cr/review-workflow-input.json`。后者是 Workflow 的唯一入参来源；
   `dimension_batches` 只包含质量维度（spec 已由独立 hard gate 执行），不得手工重建。
   `skipped_dimensions` 在 `compatibility_projection` 中以
   `status: skipped, result: auto-pass` 表示，供 gate 兼容旧 D2-D9 模型。

6. **增量复审判断**（rework_cycle > 0 时）
   读取 cr-context-prev.json，对上轮 pass 且 repair 未触及的维度写入 pass-cached。

7. **获取 review budget**
   选择器已经调用 `review-budget.mjs` 生成有界的维度 batches 和 targeted skeptic 上限。
   不对所有 finding 无差别 fan-out；只核验初判为 `UNCERTAIN`、critical/high、
   高置信度误报候选或同根因组内结论冲突的 finding。最多核验 6 条，并发不超过 3。

8. **调用 Dynamic Workflow**
   调用前记录 spec 与维度 reviewer：`node ${CLAUDE_PLUGIN_ROOT}/scripts/session-metrics.mjs {IDEA_DIR} --agent-call <cr-step> reviewer <1 + activeDimensions.length>`。如果产生 fail findings，再记录初步 Opus 汇总、实际 targeted skeptic votes 和最终 Opus 裁决的调用次数。
   ```text
   Workflow({
     scriptPath: "${CLAUDE_PLUGIN_ROOT}/workflows/chisel-review.js",
     args: JSON.stringify(<完整读取并解析 review-workflow-input.json 得到的对象>)
   })
   ```
   `args` 不得使用 `"{}"`、不得省略字段、不得把 spec 加入 `activeDimensions`。
   如果 Workflow 调用失败，使用同一个规范 `scriptPath` 和同一份 input 文件重新调用；
   禁止定位、复制、修改或 resume `~/.claude/projects/.../workflows/scripts/` 下的临时生成脚本。

9. **处理多维 CR 结果并完成返修闭环**

   workflow 返回后读取结构化 `status`。该阶段只形成机器 CR 结果并驱动返修，
   不生成最终 CR 报告；最终报告必须等所有多维度 findings 修复并复审通过后再产出。
   禁止使用 `--finish-task`、`--approve-task` 或其他命令改变 task CR 状态；
   `--mark-cr-requirement` 是唯一合法手段。

   **9a. 汇总裁决（质量维度结束后、返修开始前）**：

   workflow 必须按以下顺序完成，任何一步都不得修改业务代码：
   1. 把全部 fail findings 一次性交给 `model: opus` 做初步全局判断和根因归并。
   2. 仅选择 `UNCERTAIN`、critical/high、高置信度误报候选、同根因组内结论冲突项，
      由独立 sonnet skeptic 从代码语义、运行时行为或独立证据角度核验；skeptic 不得读取初步结论。
   3. 再由 `model: opus` 综合原始 finding、全局汇总和 skeptic 证据作最终裁决；不得机械按票数决定。
   4. 最终 Opus 为每条 finding 输出 `TRUE_POSITIVE` / `FALSE_POSITIVE` / `UNCERTAIN`，
      重建 `root_cause_groups`，给出最小返修策略、涉及 task、原始 finding IDs 和返修顺序，
      并写入中文 `{IDEA_DIR}/cr/aggregate-assessment.md`。

   `FALSE_POSITIVE` 从返修输入中移除，`UNCERTAIN` 保守保留。最终裁决缺失或未覆盖全部 finding 时，
   未裁决项必须保留；初步汇总或最终裁决调用失败时返回 `assessment_failed` 并阻断返修，
   不得用初步判断代替最终裁决。禁止在该阶段完成前开始修改代码。

   **9b. 当 `status === "approved"`**：

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-status.mjs {IDEA_DIR} --mark-cr-requirement approved
   ```

   **9c. 当 `status === "assessment_failed"`**：

   报告 `failure_stage` 和调用失败信息，保持当前 CR 状态，不得标记 `needs_rework`、不得修改代码；
   重新执行汇总裁决，成功后才能继续。

   **9d. 当 `status === "spec_failed"` 或 `status === "needs_rework"`**：

   向用户展示汇总裁决后的 findings 摘要：
   - 失败维度列表及 finding 数量
   - 每个 finding 的维度、严重度（critical/high/medium/low）、一行描述
   - 合并后的根因组、覆盖的 finding IDs、建议修复顺序
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

   不得代替用户做出选择。确认处理范围后立即进入 repair；返修完成先运行受影响测试，
   再从 spec 开始复审，并复用 repair 未触及维度的 pass-cached 结果。全部 findings 清零后再运行一次完整单测与覆盖率封板。
   </HARD-GATE>

10. **仅在 CR 与返修全部完成后生成最终 CR 报告**

   orchestration-status 返回 `review:cr-report` 时才执行：

   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/cr-report.mjs {IDEA_DIR}
   node ${CLAUDE_PLUGIN_ROOT}/scripts/reports.mjs {IDEA_DIR} --reports cr
   node ${CLAUDE_PLUGIN_ROOT}/scripts/phase-artifacts.mjs {IDEA_DIR} review:cr-report
   ```

   报告聚焦当前代码实际实现的功能、多维 CR 问题、汇总裁决与根因合并、返修措施、
   累计返修次数和最终复审结论。
   将 `phase-artifacts.mjs` 的 stdout 原样输出到对话（已包含绝对路径 Markdown 链接，不得修改或重新拼接），并附 `reports.mjs` JSON 输出的 SHA-256。CR 报告是非阻塞交付物；source fingerprint 新鲜即可自动进入 final:summary，
   不创建 `confirmations/cr-report.json`，最终用户决策统一在绑定精确代码快照的 merge review 完成。

### Integration Review（条件触发）

当所有 per-task CR 通过且 task_count > 1 且复杂度为 standard/complex 时：
1. 启动 `agent-chisel-reviewer`（opus），dimension=integration
2. `cr-parse.mjs {IDEA_DIR} --dim integration`
3. pass 后进入 `review:cr-report`；fail 时按 findings 进入 repair，修复后重跑单测与 CR。

Integration Review 不走验证子阶段，不使用 workflow。

Integration 结果必须纳入最终 CR 报告，但不得在返修闭环完成前提前生成报告。

<HARD-GATE principle="P2,P4">
spec 是门槛——fail 直接返修，不跑后续质量维度。
返修后必须从 spec 重新开始；未触及的质量维度允许使用绑定 repair diff 的 pass-cached 结果。
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
| "问题很多，看到一个先修一个" | 必须先由高级模型汇总全部 findings、判真伪并合并根因，再统一返修 |
| "workflow 失败了，直接标记 approved" | workflow 失败时报告错误，不改状态 |
</HARD-GATE>
