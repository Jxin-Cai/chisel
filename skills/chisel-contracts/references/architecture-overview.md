# Chisel 架构详细说明

## 架构要点

- 单一插件 `chisel`，主入口 skill 是 `/chisel`。
- 运行态产物写入业务仓库的 `.chisel/<idea-name>/`。
- `scripts/orchestration-status.mjs` 是恢复点判定入口。
- `scripts/workflow-status.mjs` 和 `scripts/workflow-lib.mjs` 管理 task 状态机。
- `scripts/gate-check.mjs` 管理每步 postcondition。
- `scripts/scope-check.mjs` 检查变更文件是否越界或触碰禁区。
- `scripts/multi-repo-worktree.mjs` 多仓 worktree 检测/创建/状态/清理（支持非 git 工作空间下的多 git 仓库场景）。
- `scripts/wiki-manage.mjs` wiki 初始化、候选合入、关联关系管理。
- `scripts/wiki-rule-inject.mjs` 自动向业务项目注入 wiki 加载 rule。
- `scripts/repo-map.mjs` 产出语言统计、目录结构和前端框架/路由检测（无 LLM 依赖），explorer 探索前自动运行。
- `scripts/debt-scan.mjs` 纯静态技术债务扫描器（无 LLM 依赖），explorer 探索前自动运行，产出 proposed 候选。
- `scripts/as-is-score.mjs` AS_IS 产物多维质量评分（覆盖度/证据/不确定性/图表/结构/风险），explorer 完成后自动运行。
- `scripts/quick-dev-init.mjs` trivial 快速通道自动生成单 task + worktree-decision + traceability-matrix。
- `scripts/traceability-check.mjs` 需求→task 可追溯性验证，final 阶段前确认所有 AC 被覆盖实现。
- `scripts/cr-prepare.mjs` CR 预计算——Spec 通过后一次性收集 diff/scope-check/wiki 数据写入 `cr-context.json`，D2-D8 agent 共用。
- `scripts/dashboard.mjs` 生成自包含 HTML 仪表板（工作流进度/task 矩阵/CR 雷达图/traceability 覆盖度/as-is 查看器）。
- **理解阶段**（`chisel-understand`）由主编排器直接执行：先调用原生 Explore subagent 侦察定位文件，然后主编排器（真身）深度走查产出结构化数据（evidence-ledger.json + coverage-matrix.json + ai-input/*.md），最后调用 `agent-chisel-writer`(sonnet) 从结构化数据生成面向人类的图文文档。
- **规划阶段**（`chisel-plan`）由主编排器直接执行：先调用原生 Plan subagent 设计方案框架，然后主编排器精化并写入 JSON 产物（tasks.json + traceability-matrix.json + impact-risk-report.json）+ 执行 6 步变更完整性自检，最后调用 `agent-chisel-writer`(sonnet) 生成 implementation-plan.md。
- `agent-chisel-writer` 从结构化产物（JSON/md 表格）生成面向人类的图文中文文档（含 Mermaid），不探索代码、不做设计决策。支持 as-is 和 to-be 两种模式。
- `agent-chisel-coder` 只按已确认 task 实现，完成后执行 diff 自检（bug/AC/scope 三项检查）。
- `agent-chisel-reviewer` 通用 CR agent（opus），从功能 diff 出发审查（非全文件），优先从 `cr-context.json` 预计算数据读取，每次加载一个维度定义文件（dim-spec/dim-d2~d8）执行单维度深度审查。dim-spec 包含伴生产物完整性检查（后端规则：加字段→DDL、加接口→路由+DTO；前端规则：DTO加字段→前端类型+页面适配、接口响应变更→前端渲染适配）和全链路字段透传验证。每个发现项附带 0-100 置信度评分，≥80 进 Rework Items 触发返修，60-79 进 Observations 供参考。D2/D7/D8 按变更特征条件激活，D3-D6 始终激活。fail 项经 sonnet 验证子阶段确认后聚合。

## As-Is 分层结构

- **结构化产物**（主编排器 Phase 2 产出）：`evidence-ledger.json`、`coverage-matrix.json`、`context-budget.json`、`ai-input/*.md`（facts/call-graph/data-schema/api-surface/constraints/change-surface/field-flow）
- **脚本产物**：`repo-map.json`（Phase 0）、`quality-score.json`（Phase 4）
- **人类文档**（Writer 产出）：`overview.md`、`core-walkthrough.md`、`evidence-index.md`、`knowledge-candidates.md`、`context-budget.md`
- **枝干文件**（Writer 按需产出）：`details/entrypoints.md`、`details/data-model.md`、`details/api-contracts.md`、`details/data-flow.md`
- 结构化产物是核心数据源（供 Planner 和 gate 使用），人类文档由 Writer 从结构化产物二次生成（供用户阅读和 dashboard 展示）。

## 知识系统

- 实时捕获：对话中用户澄清的代码之外上下文（历史背景/业务术语映射/禁区原因/约束决策）即时写入 `knowledge-candidates/`。
- 不收录代码可推导内容：坏味道、静态分析信号属于 as-is 产物，不进入知识候选池。
- Wiki 组织：`.chisel/wiki/{project-name}/` 存储长期领域知识（project-name = git 仓库名），每个文件含 `## 关联关系` 章节。
- 自动注入：SessionStart hook 检测 wiki 存在时写入 `.claude/settings.local.json` rule。
- 知识流：候选 → 用户确认 → wiki-manage.mjs 合入 → rule 激活。
- debt-scan.mjs 产出写入 `as-is/debt-signals/` 仅作探索参考，不进入知识候选池。

## 并行开发

- Worktree 粒度为 per-requirement：一个需求对应一组 worktree（用户在 `worktree:setup` 选择），内部 task 串行/并行执行。
- **多仓支持**：工作空间可能是非 git 的目录，下包含多个独立 Git 仓库。一个需求可能跨多个仓库改动。`worktree:setup` 阶段通过 `multi-repo-worktree.mjs --detect` 扫描仓库，在每个涉及的仓库中创建同名分支 worktree（`worktree-decision.json` schema_version=2）。
- 单仓场景退化为 schema_version=1，行为不变。
- Worktree 决策在方案确认后（`plan:confirm` 之后、`tasks:init` 之前）由用户选择。
- 用户选 `current-branch` 时，所有 task 串行执行，**不使用 Agent worktree 隔离**。
- 用户选 `worktree` 时，`getNextTasks()` 返回多个 task 且无文件重叠时，使用 `Agent(isolation: "worktree")` 并行编码（这是 Agent 工具的临时隔离，task 级，用完即弃），合并后统一更新状态。
- 有重叠 task 串行执行；返修 task 始终串行。
- `chisel-review` 在所有 task 编码完成后进行多维度 CR：spec 门槛（opus）通过后，D2-D8 按变更特征条件激活（D2 需并发/错误处理代码、D7 需删除/重命名、D8 需公共 API 变更，D3-D6 始终激活），已激活维度并行 opus 审查，每个发现附带置信度评分（≥80 返修、60-79 仅参考），fail 项经 sonnet 验证子阶段确认后聚合结果。Scope/Wiki Proof 只在 spec 维度执行一次，D2-D8 引用之。返修后从 spec 重新开始。
- 需求完成后（`done` 阶段），多仓场景对每个仓库分别创建 PR 或 merge。

## 知识提取（可选）

- `knowledge:extract` 为可选步骤：`plan:confirm` 后询问用户是否启用知识沉淀，决策存入 `confirmations/to-be.json` 的 `knowledge_extraction.enabled` 字段。
- 用户选择"是"时：作为并行旁支启动（后台 Agent），不阻塞主链路，在 `final:summary` 前同步。实时知识捕获在对话中自动监测知识信号。
- 用户选择"否"时：跳过 knowledge:extract 全部环节（包括实时捕获），gate 自动 pass，final-summary 不要求 Knowledge Candidates / Wiki Updates 章节。
- trivial 模式始终跳过 knowledge 提取。

## Quick-dev 快速通道

- 当 complexity=trivial（scope≤2 项、无新表/API）时自动激活。
- 缩短路径：`receive → clarify(2 维度) → quick-dev:init → implement → review:cr-light(spec-only) → done`。
- 跳过：as-is 探索/确认、ai-input、plan、knowledge、worktree 选择、D2-D8 CR。
- `quick-dev-init.mjs` 从 requirement-clarification.json 自动生成单 task + worktree-decision(current-branch) + traceability-matrix。

## 需求可追溯性

- `to-be/traceability-matrix.json` 记录每个 AC 由哪些 task 覆盖。
- `traceability-check.mjs` 验证覆盖链完整性：final 模式要求所有 covering tasks 为 approved。
- `gate-check.mjs` 的 `traceability-complete` gate 在 final:summary 前阻断未覆盖情况。
- 向后兼容：matrix 文件不存在时 gate 自动 pass。

## 可视化仪表板

- `/chisel-dashboard <idea-name>` 手动生成 `{idea-dir}/dashboard.html`。
- **每次步骤切换时强制打开浏览器**，并等待用户确认已查看后才继续执行（仪表盘确认协议）。浏览器 30s 自动刷新。
- 自包含 HTML，使用 Mermaid CDN + Chart.js CDN 渲染图表。
- 含"步骤产出详情"表：展示当前需求的完整执行步骤列表、每步状态（已完成/进行中/待执行/已跳过）和对应的产出文件完成情况。
- 含 As-Is 查看器（5 Tab：概览、核心走查、证据表、质量雷达图、覆盖矩阵）。
- 含全链路改造视图：从 `impact-risk-report.json` 的 `flow_graph` 渲染带颜色标记的 Mermaid 流程图（灰=保留/蓝=改造/绿=新增/红=删除）。
- `workflow-state.yaml` 的 `step_history` 提供时间线数据。
