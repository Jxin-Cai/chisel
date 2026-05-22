# CLAUDE.md

This repository contains the `chisel` Claude Code plugin.

## 项目概述

`chisel` 用于在遗留系统上增加功能。它通过文件驱动流程强制完成 as-is 理解、to-be 方案确认、task 化实现、架构师 CR 和返修闭环。

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
- `scripts/repo-map.mjs` 产出语言统计和目录结构（无 LLM 依赖），explorer 探索前自动运行。
- `scripts/debt-scan.mjs` 纯静态技术债务扫描器（无 LLM 依赖），explorer 探索前自动运行，产出 proposed 候选。
- `scripts/as-is-score.mjs` AS_IS 产物多维质量评分（覆盖度/证据/不确定性/图表/结构/风险），explorer 完成后自动运行。
- `scripts/quick-dev-init.mjs` trivial 快速通道自动生成单 task + worktree-decision + traceability-matrix。
- `scripts/traceability-check.mjs` 需求→task 可追溯性验证，final 阶段前确认所有 AC 被覆盖实现。
- `scripts/cr-prepare.mjs` CR 预计算——Spec 通过后一次性收集 diff/scope-check/wiki 数据写入 `cr-context.json`，D2-D8 agent 共用。
- `scripts/dashboard.mjs` 生成自包含 HTML 仪表板（工作流进度/task 矩阵/CR 雷达图/traceability 覆盖度/as-is 查看器）。
- `agent-chisel-explorer` 只读生成 as-is（面向人类学习的图形化版本）。
- `agent-chisel-planner` 从 `as-is/ai-input/` 结构化输入 + `requirement-clarification.json` 设计 to-be 方案。
- `agent-chisel-coder` 只按已确认 task 实现。
- `agent-chisel-reviewer` 通用 CR agent（opus），从功能 diff 出发审查（非全文件），优先从 `cr-context.json` 预计算数据读取，每次加载一个维度定义文件（dim-spec/dim-d2~d8）执行单维度深度审查。D2-D8 分两批（4+3）并行调用，避免 7 agent 并发 stall。

## As-Is 分层结构

- **主干文件**（必须）：`repo-map.json`（脚本生成）、`overview.md`、`core-walkthrough.md`、`evidence-index.md`、`knowledge-candidates.md`、`context-budget.md`、`quality-score.json`（脚本生成）
- **枝干文件**（按需）：`details/entrypoints.md`、`details/data-model.md`、`details/api-contracts.md`、`details/data-flow.md`
- **AI 输入版**（`as-is/ai-input/`）：用户确认后从人类版提取的结构化数据，供 Planner 使用。
- 主干聚焦需求相关的核心链路，枝干按需展开细节，主干用 `→ 详见 details/xxx.md` 引用。

## 知识系统

- 实时捕获：对话中用户澄清的代码之外上下文（历史背景/业务术语映射/禁区原因/约束决策）即时写入 `knowledge-candidates/`。
- 不收录代码可推导内容：坏味道、静态分析信号属于 as-is 产物，不进入知识候选池。
- Wiki 组织：`.chisel/wiki/{project-name}/` 存储长期领域知识（project-name = git 仓库名），每个文件含 `## 关联关系` 章节。
- 自动注入：SessionStart hook 检测 wiki 存在时写入 `.claude/settings.local.json` rule。
- 知识流：候选 → 用户确认 → wiki-manage.mjs 合入 → rule 激活。
- debt-scan.mjs 产出写入 `as-is/debt-signals/` 仅作探索参考，不进入知识候选池。

## 关键约束

- 不要跳过 as-is 和 to-be 确认。
- 不要凭上下文记忆决定下一步，始终调用 `orchestration-status.mjs`。
- 同一 task 最多返修 3 次，超过后进入 blocked。
- 知识候选不自动合入 wiki，必须用户确认。
- 每次提交代码到主干（push to main）前，必须先更新 `.claude-plugin/plugin.json` 中的 `version` 字段。版本号遵循 semver：bug fix 升 patch，新功能/行为变更升 minor，破坏性变更升 major。版本更新应包含在同一次提交中。

## 并行开发

- Worktree 粒度为 per-requirement：一个需求对应一组 worktree（用户在 `worktree:setup` 选择），内部 task 串行/并行执行。
- **多仓支持**：工作空间可能是非 git 的目录，下包含多个独立 Git 仓库。一个需求可能跨多个仓库改动。`worktree:setup` 阶段通过 `multi-repo-worktree.mjs --detect` 扫描仓库，在每个涉及的仓库中创建同名分支 worktree（`worktree-decision.json` schema_version=2）。
- 单仓场景退化为 schema_version=1，行为不变。
- Worktree 决策在方案确认后（`plan:confirm` 之后、`tasks:init` 之前）由用户选择。
- 用户选 `current-branch` 时，所有 task 串行执行，**不使用 Agent worktree 隔离**。
- 用户选 `worktree` 时，`getNextTasks()` 返回多个 task 且无文件重叠时，使用 `Agent(isolation: "worktree")` 并行编码（这是 Agent 工具的临时隔离，task 级，用完即弃），合并后统一更新状态。
- 有重叠 task 串行执行；返修 task 始终串行。
- `chisel-review` 在所有 task 编码完成后进行 8 维度独立 CR：spec 门槛（opus，合规检查）通过后，D2-D8 每个维度独立一次 opus 调用，全量审查后聚合结果。返修后从 spec 重新开始。
- 需求完成后（`done` 阶段），多仓场景对每个仓库分别创建 PR 或 merge。

## 知识提取并行化

- `knowledge:extract` 在 `plan:confirm` 后作为并行旁支启动（后台 Agent），不阻塞 `worktree:setup` 和后续 implement 主链路。
- 在 `final:summary` 前同步：如果 knowledge 提取尚未完成则此时等待/执行。
- trivial 模式跳过 knowledge 提取。

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
- as-is 完成后自动启动仪表盘并打开浏览器，后续步骤静默更新、浏览器 30s 自动刷新。
- 自包含 HTML，使用 Mermaid CDN + Chart.js CDN 渲染图表。
- 含 As-Is 查看器（5 Tab：概览、核心走查、证据表、质量雷达图、覆盖矩阵）。
- 含全链路改造视图：从 `impact-risk-report.json` 的 `flow_graph` 渲染带颜色标记的 Mermaid 流程图（灰=保留/蓝=改造/绿=新增/红=删除）。
- `workflow-state.yaml` 的 `step_history` 提供时间线数据。
