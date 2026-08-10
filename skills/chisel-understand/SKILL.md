---
name: chisel-understand
description: 当 chisel 编排器进入 understand:explore 阶段时触发。
argument-hint: "<idea-name>"
user-invocable: false
---

# chisel-understand

理解阶段。产出结构化 as-is 数据（ai-input + evidence-ledger + coverage-matrix）和人类可读文档。不做方案，不改业务代码。

## 当前工作流状态

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-snapshot.mjs 2>/dev/null || echo "无活跃工作流"`

## 执行

仅当 `requirement-classification.json.execution_profile=full` 时进入本阶段。Explore/Analyst 额度不得超过其中的 `subagent_budget`；只有可干净拆分的侦察区域才并行。Writer 专门产出人类文档，并以后台任务运行。主编排器负责调度和质量验证。

### 重试模式

如果 orchestration-status 返回 `resume_step: understand:explore` 且 `phase_detail` 中包含 `gate_reason`：
1. Read 已有的 `{idea_dir}/as-is/` 下文件，了解哪些已经完成
2. 根据 `gate_reason` 的具体内容，只补充缺失或不合格的产物
3. Phase 0 产物（repo-map.json）已存在则跳过
4. 按 gate_reason 决定从哪个 Phase 恢复

---

### Phase 0: 代码地图 + 债务扫描

**代码地图生成**：

<HARD-GATE principle="P4">
运行 repo-map 脚本生成代码地图：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/repo-map.mjs --project-root . --requirement {requirement_path} --output {idea_dir}/as-is/repo-map.json
```

Read 生成的 `{idea_dir}/as-is/repo-map.json`，了解语言、入口候选、目录结构。

然后运行 debt-scan（如有 entry_candidates，从中提取目录前缀缩小范围）：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/debt-scan.mjs --project-root . --repo-map {idea_dir}/as-is/repo-map.json --output {idea_dir}/as-is/debt-signals/ --scope-dirs <目录前缀>
```
</HARD-GATE>

---

### Phase 1: 侦察定位

<HARD-GATE principle="P4">
Read `${CLAUDE_PLUGIN_ROOT}/skills/chisel-understand/references/explore-prompt-guide.md`，基于需求特征构建 Explore prompt。
</HARD-GATE>

启动 Explore subagent（原生 `subagent_type: "Explore"`），传入构建好的 prompt。prompt 必须包含：

1. repo-map.json 路径和需求文件路径
2. 按 explore-prompt-guide.md 的结构组织侦察任务
3. 根据需求特征追加引导（字段变更→追踪透传链；接口变更→找 caller；异步→找消费者）

Explore agent 返回分层文件清单后，检查覆盖度报告：
- 入口覆盖率过低（<50%）→ 考虑补发第二个 Explore agent 针对未覆盖区域
- 链路深度不够 → 在 Phase 2 重点关注

---

### Phase 2: 深度走查（委托 Analyst Subagent）

启动 `agent-chisel-analyst`，传入 TASK：

```json
{
  "idea_dir": "{idea_dir}",
  "explore_result": "<Phase 1 Explore 返回的分层文件清单>",
  "requirement_path": "{requirement_path}"
}
```

Analyst 产出以下结构化产物（每条 fact 必须有已验证的 file:line 证据）：

| 产物 | 内容 |
|------|------|
| `as-is/evidence-ledger.json` | F-xxx 证据账本，每条 fact 含 id/description/file/line_start/line_end/status(confirmed) |
| `as-is/coverage-matrix.json` | 入口/链路/数据/副作用四维覆盖，每项含 file+line 证据 |
| `as-is/ai-input/facts.md` | 已确认事实表 |
| `as-is/ai-input/call-graph.md` | 调用链 + 入口→终点映射 + 前端→API 映射 |
| `as-is/ai-input/data-schema.md` | 表结构 + 关系 |
| `as-is/ai-input/api-surface.md` | 接口清单 + 错误码 |
| `as-is/ai-input/constraints.md` | 禁区/包袱/坏味道/兼容约束 |
| `as-is/ai-input/change-surface.md` | 安全变更区域 + 影响面 |
| `as-is/ai-input/field-flow.md` | 字段流转表（仅当有字段变更时） |
| `as-is/context-budget.json` | 已读文件清单、行数、覆盖率、未读相关文件、覆盖度自评 |

<HARD-GATE principle="P3">
Analyst 返回后，验证结构化产物合规：
- `evidence-ledger.json` 存在且非空，所有 fact 的 status 为 "confirmed"
- `coverage-matrix.json` 覆盖入口、链路、数据、副作用四个维度；不涉及的维度有 `not_applicable` reason
- `ai-input/` 下至少有 facts.md、call-graph.md、data-schema.md、api-surface.md、constraints.md、change-surface.md

不满足则重新派发 Analyst 补充缺失产物（传入 `retry_reason` 说明缺失项）。
</HARD-GATE>

---

### Phase 3: 异步人类文档生成

<HARD-GATE principle="P5">
Read `${CLAUDE_PLUGIN_ROOT}/skills/chisel-understand/references/writer-as-is-task.md`，按其 TASK 结构启动 writer。
</HARD-GATE>

先运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/document-job.mjs prepare {idea_dir} as-is` 创建带源文件 hash 的任务收据。随后启动 `agent-chisel-writer`，设置 `run_in_background: true`，传入 TASK：

```json
{
  "idea_dir": "{idea_dir}",
  "mode": "as-is",
  "source_files": [
    "as-is/repo-map.json",
    "as-is/evidence-ledger.json",
    "as-is/coverage-matrix.json",
    "as-is/context-budget.json",
    "as-is/ai-input/facts.md",
    "as-is/ai-input/call-graph.md",
    "as-is/ai-input/data-schema.md",
    "as-is/ai-input/api-surface.md",
    "as-is/ai-input/constraints.md",
    "as-is/ai-input/change-surface.md"
  ],
  "requirement_path": "{requirement_path}"
}
```

`source_files` 之外，prepare 会自动把当时存在的 `as-is/ai-input/field-flow.md` 与 `as-is/debt-signals/**/*`（递归稳定排序）纳入唯一 source manifest，Writer 必须全部读取。

Writer 产出人类可读文档：overview.md / core-walkthrough.md / evidence-index.md / context-budget.md / knowledge-candidates.md（有候选时）/ details/*.md。complete receipt 必须绑定所有实际存在的条件输出。

派发后不要原地阻塞：主编排器并行执行结构化 schema/coverage 检查和质量评分前置检查。Writer 最后必须运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/document-job.mjs complete {idea_dir} as-is`。进入 `understand:confirm` 前必须运行 `document-job.mjs check` 并等待 `status=complete`；pending/stale 时不得让用户 review，stale 必须重新 prepare + 派发。

---

### Phase 4: 质量评分

<HARD-GATE principle="P4">
Writer 完成后运行质量评分脚本：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/as-is-score.mjs {idea_dir}
```

Read stdout 查看各维度得分。hard gate 是 `overall >= 0.6` 且每个维度 `>= 0.3`。

低于 0.4 的维度需补强：
- coverage 低 → 检查 coverage-matrix 是否遗漏维度
- evidence_density 低 → 回到 Phase 2 补充 fact
- diagram 低 → 重新启动 Writer 补充 Mermaid 图
- risk_awareness 低 → 在 Phase 2 补充风险识别后重新写入

补强后重新运行评分，直到满足 hard gate。
</HARD-GATE>

---

## 最终产物检查清单

<HARD-GATE principle="P1,P4">
Phase 4 通过后，确认以下产物全部存在：

**结构化产物（Analyst Phase 2 写入）：**
- `as-is/repo-map.json`（Phase 0 脚本生成）
- `as-is/evidence-ledger.json`
- `as-is/coverage-matrix.json`
- `as-is/context-budget.json`
- `as-is/ai-input/facts.md`
- `as-is/ai-input/call-graph.md`
- `as-is/ai-input/data-schema.md`
- `as-is/ai-input/api-surface.md`
- `as-is/ai-input/constraints.md`
- `as-is/ai-input/change-surface.md`

**人类文档（Writer 产出）：**
- `as-is/overview.md`
- `as-is/core-walkthrough.md`
- `as-is/evidence-index.md`
- `as-is/context-budget.md`
- `as-is/quality-score.json`（Phase 4 脚本生成）

**条件产物：**
- `as-is/ai-input/field-flow.md`（字段变更时）
- `as-is/details/*.md`（按 coverage-matrix 触发条件）

如果产物不完整，运行 gate-check 获取具体失败原因：
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/gate-check.mjs {idea_dir} as-is-complete
```

合理化预防表：

| 你的想法 | 现实 |
|---------|------|
| "这个模块我已经理解了" | 理解必须体现在结构化产物中，不是记忆中 |
| "只改一个文件，不需要全局理解" | 变更影响面可能超出预期 |
| "代码注释已经很清楚了" | 注释可能过时，以运行行为为准 |
| "Explore 返回的文件清单够用了" | Explore 读片段，Analyst 必须 Read 全文件验证 |
</HARD-GATE>
