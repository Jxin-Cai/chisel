---
name: chisel-plan
description: 当 chisel 编排器进入 plan:design 阶段时触发。
argument-hint: "<idea-name>"
user-invocable: false
---

# chisel-plan

计划阶段。产出结构化方案（JSON 产物）和人类可读文档。不改业务代码。

方案写完后不能直接请求用户确认。主编排器必须先运行 `plan:adversarial-review`：启动一个不共享
planner 上下文的 fresh reviewer，直接读取 requirement、clarification AC/VC、as-is 证据和所有
to-be 结构化产物，逐项产出可执行 findings。审查失败时将 findings 修复回写到 tasks、traceability、
impact-risk、implementation plan 等产物，重新运行 schema/traceability 校验，再创建下一轮
`adversarial-review.json`/`.md`；只有 `status: pass` 的记录才能让用户 review `plan:confirm`。
审查必须受机器 gate 和最大轮次约束，不能只依赖提示词承诺。

> **Fresh reviewer 不能成为停止点。** 如果 reviewer 在后台运行，主编排器必须保存 task id，并在
> 当前 turn 内调用 `TaskOutput(task_id, block: true)` 等待和收割结果，再按 reviewer 的实际结论写入
> `adversarial-review.json`/`.md`、运行 gate 并继续编排。等待期间可以发简短进度，但禁止只回复
> “reviewer 仍在后台/等待完成通知”后停止，也禁止主编排器自行冒充独立 reviewer 生成 pass 记录。

## 当前工作流状态

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-snapshot.mjs 2>/dev/null || echo "无活跃工作流"`

## 参数

- `idea-name`：需求名称（必需）

## 执行

主编排器读取 `requirement-classification.json` 并遵守 `subagent_budget`。moderate/lightweight 最多启动 1 个 Plan agent，不再启动 Explore/Analyst；full 才允许完整规划链。自身精化写入 JSON 并执行完整性自检，最后由确定性 renderer 从结构化产物生成 implementation-plan.md。

---

### Phase 1: 方案框架设计

<HARD-GATE principle="P4">
Read `${CLAUDE_PLUGIN_ROOT}/skills/chisel-plan/references/plan-prompt-guide.md`，基于需求特征构建 Plan prompt。
</HARD-GATE>

先按 `execution_profile` 选择互斥分支，严禁把 full 的输入要求套到 lightweight：

#### lightweight（routing_complexity=moderate）

- 不依赖、不等待、也不补做 as-is；全新 moderate 目录没有 `as-is/` 是合法输入。
- Plan agent 的必读输入仅为 `requirement.md`、`requirement-clarification.json`、`requirement-classification.json`。
- 主编排器可做一次有界只读 discovery，生成 `to-be/source-manifest.json`：最多 12 个文件、2 个模块，只记录 path/hash/选择理由，不启动 Explore/Analyst；超界则写 `scope-escalation.json` 并重新分类。
- 仍必须产出 tasks、traceability、design-notes 和轻量 `impact-risk-report.json`，保证审查与确认指纹契约一致。

#### full（routing_complexity=standard/complex）

启动 Plan subagent（原生 `subagent_type: "Plan"`），prompt 必须包含：

启动前运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/session-metrics.mjs {idea_dir} --agent-call plan:design planner 1`。

1. 必读文件列表：
   - `{idea_dir}/as-is/ai-input/facts.md`
   - `{idea_dir}/as-is/ai-input/call-graph.md`
   - `{idea_dir}/as-is/ai-input/change-surface.md`
   - `{idea_dir}/requirement-clarification.json`
   - `{idea_dir}/clarifications.json`
   - `{idea_dir}/as-is/coverage-matrix.json`
2. 按需文件：data-schema.md、api-surface.md、field-flow.md
3. 按 plan-prompt-guide.md 的结构组织设计任务
4. 根据需求特征追加引导（字段变更→全链路透传；高并发→锁策略）

Plan agent 返回结构化方案分析结果。

两个分支均不得读取未列入各自 source manifest 的仓库文件；lightweight 不得因为缺少 `clarifications.json`、coverage-matrix 或 call-graph 而失败。

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

<HARD-GATE principle="P5">
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
| `design-notes.json` | 松散结构中间产物（CP 详情/设计理由/自检结果，供 renderer 消费） |

---

### Phase 3: 变更完整性自检

<HARD-GATE principle="P1,P4">
全部产物写完后，主编排器执行以下 8 步自检。发现遗漏则就地修补（追加 task / 补充 CP / 更新文件），不可跳过。

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

#### 7. Task Brief 自包含性

每个 task 必须仅凭自身 `description` + `file_plan` + `change_point_refs` + `trace_refs` + `imports/exports` 即可被实现者理解，不允许出现：
- "参见 Task-N 的 XX"（实现者可能乱序读或读不到其他 task）
- "与前一个 task 类似"（重复代码优于交叉引用）

自检结果写入 `design-notes.json` 的 `self_check` 字段。

#### 8. 单测 RED→GREEN 可执行性

逐个 task 检查 Verification Plan：必须包含具体测试文件、测试名、输入与断言、RED 命令及预期失败原因、GREEN 命令、完整测试/覆盖率命令和覆盖率产物路径。发现“补充相关测试”等占位内容必须就地修复。

#### 9. 对抗审查交接

先运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/adversarial-review.mjs {idea_dir} --init --attempt <N>`，由脚本
确定性生成包含全部源文件 hash、AC/VC 条目和固定 Markdown 章节的审查骨架，再把骨架与源文件交给
fresh reviewer 填写。禁止用 Bash heredoc、内联 `node -e` 或临时 `_hash_fix`/`_cov_fix` 脚本拼装
审查产物。修复后进入下一轮时，在 reviewer 启动前用 `--force` 重新初始化并递增 attempt。

将 `requirement.md`、`requirement-clarification.json` 中每个 AC 及 verification_conditions、
所有 as-is 结构化文件、to-be 全部 JSON/Markdown 的路径和 hash 交给 fresh reviewer。审查输出必须
包含 requirement/clarification coverage、implementation/change points/tasks/files/verification
证据、findings、attempt 和 status。任何未映射、未知 ref、空/占位 evidence 都是 fail；planner
必须逐条将 finding 变成 task、file plan、traceability 或验证检查的修复，并再次通过本阶段所有
schema 校验后才能重审。

如果使用后台 Agent，派发后必须立即以 `TaskOutput(task_id, block: true)` join；收到结果前不得结束
当前 turn。renderer、schema 或 traceability 校验可以在等待期间执行，但不能代替 reviewer 结论，
也不能把“已做完可并行工作”解释为允许停止。
</HARD-GATE>

---

### Phase 4: 确定性人类文档生成

结构化计划通过 tasks/traceability/schema 自检后运行：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/document-render.mjs {idea_dir} to-be
```

脚本从 design-notes、tasks、traceability 和 impact-risk 直接生成
`to-be/implementation-plan.md`，并写入绑定源文件 hash 的 receipt。不得启动 Writer agent；结构化源变化后重新运行即可。

---

## 最终产物检查

<HARD-GATE principle="P1,P4">
一次性产出完整方案，包含：
- `to-be/tasks.json` — task 拆分（每 task 含 change_point_refs + file_plan）
- `to-be/traceability-matrix.json` — 需求到 task 追溯
- `to-be/impact-risk-report.json` — 影响范围 + 风险 + flow_graph
- `to-be/design-notes.json` — 设计笔记（含自检结果）
- `to-be/implementation-plan.md` — 人类可读方案（确定性 renderer 产出）

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
