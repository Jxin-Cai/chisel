---
name: chisel-plan
description: 当 chisel 编排器进入 plan:design 阶段时触发。
argument-hint: "<idea-name>"
user-invocable: false
---

# chisel-plan

计划阶段。产出结构化方案（JSON 产物）和人类可读文档。不改业务代码。

## 当前工作流状态

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-snapshot.mjs 2>/dev/null || echo "无活跃工作流"`

## 参数

- `idea-name`：需求名称（必需）

## 执行

主编排器利用原生 Plan subagent 做方案框架设计，自身精化写入 JSON 产物并执行完整性自检，最后由 Writer subagent 产出 implementation-plan.md。

---

### Phase 1: 方案框架设计

<HARD-GATE>
Read `${CLAUDE_PLUGIN_ROOT}/skills/chisel-plan/references/plan-prompt-guide.md`，基于需求特征构建 Plan prompt。
</HARD-GATE>

启动 Plan subagent（原生 `subagent_type: "Plan"`），prompt 必须包含：

1. 必读文件列表：
   - `{idea_dir}/as-is/ai-input/facts.md`
   - `{idea_dir}/as-is/ai-input/call-graph.md`
   - `{idea_dir}/as-is/ai-input/change-surface.md`
   - `{idea_dir}/as-is/ai-input/constraints.md`
   - `{idea_dir}/requirement-clarification.json`
   - `{idea_dir}/clarifications.json`
   - `{idea_dir}/as-is/coverage-matrix.json`
2. 按需文件：data-schema.md、api-surface.md、field-flow.md
3. 按 plan-prompt-guide.md 的结构组织设计任务
4. 根据需求特征追加引导（字段变更→全链路透传；高并发→锁策略）

Plan agent 返回结构化方案分析结果。

---

### Phase 2: 主编排器精化 + 写入

基于 Plan agent 返回的方案框架，主编排器执行：

#### 2.1 验证 CP 完整性

对 Plan agent 返回的 task 拆分中的每个 `expected_files`，用 grep 检查文件中的 caller/callee：
- 发现不在 call-graph 中的调用关系 → 追加新 CP
- 新 CP 分配到现有 task 或追加新 task

#### 2.2 补充伴生变更

对每个 CP 逐条过伴生变更规则（后端 + 前端）：
- 有触发则确认对应 task 已包含该伴生产物
- 遗漏则追加到现有 task 的 file_plan 或创建新 task

#### 2.3 写入结构化产物

<HARD-GATE>
Read `${CLAUDE_PLUGIN_ROOT}/skills/chisel-plan/references/to-be-template.md`（了解最终人类文档格式）。
Read `${CLAUDE_PLUGIN_ROOT}/skills/chisel-plan/references/design-notes-schema.md`（了解 design-notes.json 格式）。
</HARD-GATE>

写入以下产物到 `{idea_dir}/to-be/`：

| 产物 | 内容 |
|------|------|
| `tasks.json` | 完整 task 拆分（schema_version: 2, plan_with_file: true，每 task 含 file_plan） |
| `traceability-matrix.json` | AC/VC → CP → Task 追溯关系 |
| `impact-risk-report.json` | 改造点 + 风险矩阵 + 复用节点 + flow_graph |
| `data-change-plan.json`（条件） | 涉及 DB 变更时必须产出 |
| `api-change-plan.json`（条件） | 涉及 API 变更时必须产出 |
| `design-notes.json` | 松散结构中间产物（CP 详情/设计理由/自检结果，供 Writer 消费） |

---

### Phase 3: 变更完整性自检

<HARD-GATE>
全部产物写完后，主编排器执行以下 6 步自检。发现遗漏则就地修补（追加 task / 补充 CP / 更新文件），不可跳过。

#### 1. 伴生变更推断

对每个 CP，逐条过以下规则：

**后端规则**：
| 触发条件 | 必须伴生 |
|----------|---------|
| 新增/修改 DB model 字段 | DDL migration + data-change-plan.json |
| 新增/修改 API endpoint | 路由注册 + DTO + api-change-plan.json |
| 新增配置项/环境变量 | 配置文件模板更新 |
| 删除/重命名公共符号 | 所有 caller 适配 |
| 序列化格式变更 | 向后兼容处理 |
| 新增异步消费者/生产者 | 消息格式 + 幂等/重试 |

**前端规则**（当 coverage-matrix 含 `ui_entries` 或 field-flow.md 存在时）：
| 触发条件 | 必须伴生 |
|----------|---------|
| 后端 DTO 加字段 | 前端类型更新 + 调用处适配 |
| 后端接口响应变更 | 前端渲染适配 |
| 新增后端 API | 前端 API 函数 + 路由绑定 |
| DB 加字段（用户可见） | 全链路透传 Entity→DTO→API→Frontend→UI |
| 新增前端页面 | 路由注册 + 权限 + 导航 |
| 修改 API 请求参数 | 前端调用处同步 |

#### 2. Spec 覆盖率

逐条扫描 `requirement-clarification.json` 的每个 acceptance_criteria，确认至少有一个 task 的 `trace_refs` 覆盖它。

#### 3. CP-Task 一致性

确认每个 CP 至少被一个 task 的 `change_point_refs` 引用。

#### 4. File Plan 完整性

对每个 task 的 `file_plan`：
- 每个 `change_point_refs` 至少被一个 file_plan 条目覆盖
- 每个 `trace_refs` 至少被一个 file_plan 条目覆盖
- file_plan 的 path 不落入 forbidden_files
- 伴生变更文件已进入 expected_files 和 file_plan

#### 5. 依赖完备性

对每个 task 的 `imports`，确认对应的 `exports` 源 task 存在且在依赖链上游。

#### 6. 反向探测

对每个 task 的 `expected_files`，用 grep 检查 caller/callee：
- 不在 call-graph 中的调用关系 → 追加为新 CP → 分配到 task

自检结果写入 `design-notes.json` 的 `self_check` 字段。
</HARD-GATE>

---

### Phase 4: 人类文档生成

<HARD-GATE>
Read `${CLAUDE_PLUGIN_ROOT}/skills/chisel-plan/references/writer-to-be-task.md`，按其 TASK 结构启动 writer。
</HARD-GATE>

启动 `agent-chisel-writer`，传入 TASK：

```json
{
  "idea_dir": "{idea_dir}",
  "mode": "to-be",
  "source_files": [
    "to-be/design-notes.json",
    "to-be/tasks.json",
    "to-be/traceability-matrix.json",
    "to-be/impact-risk-report.json"
  ],
  "optional_sources": [
    "to-be/data-change-plan.json",
    "to-be/api-change-plan.json"
  ],
  "context_files": [
    "as-is/ai-input/call-graph.md"
  ]
}
```

Writer 产出 `to-be/implementation-plan.md`。

---

## 最终产物检查

<HARD-GATE>
一次性产出完整方案，包含：
- `to-be/tasks.json` — task 拆分（每 task 含 change_point_refs + file_plan）
- `to-be/traceability-matrix.json` — 需求到 task 追溯
- `to-be/impact-risk-report.json` — 影响范围 + 风险 + flow_graph
- `to-be/design-notes.json` — 设计笔记（含自检结果）
- `to-be/implementation-plan.md` — 人类可读方案（Writer 产出）

不要创建 `confirmations/strategy.json`。
不要创建 `confirmations/to-be.json`；to-be 确认凭据只能由主编排器在用户确认后写入。

合理化预防表：

| 你的想法 | 现实 |
|---------|------|
| "方案很明显，不需要多选项" | 至少考虑一个替代方案 |
| "task 拆分太细浪费时间" | 粗粒度 task 导致 CR 困难和返修 |
| "先写代码再补方案" | 没有方案的代码无法 CR |
| "有几个设计点不确定，先提出来问用户" | 不确定点写入风险清单，仍然完成全部产物 |
| "改造点映射太繁琐，直接写方案详情" | 改造点映射是 as-is→to-be 的桥梁，必须先映射再展开 |
| "自检太耗时，Plan agent 已经覆盖了" | Plan agent 可能遗漏，主编排器必须独立验证 |
</HARD-GATE>
