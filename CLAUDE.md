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
- `scripts/wiki-manage.mjs` wiki 初始化、候选合入、关联关系管理。
- `scripts/wiki-rule-inject.mjs` 自动向业务项目注入 wiki 加载 rule。
- `scripts/repo-map.mjs` 产出语言统计和目录结构（无 LLM 依赖），explorer 探索前自动运行。
- `scripts/debt-scan.mjs` 纯静态技术债务扫描器（无 LLM 依赖），explorer 探索前自动运行，产出 proposed 候选。
- `scripts/as-is-score.mjs` AS_IS 产物多维质量评分（覆盖度/证据/不确定性/图表/结构/风险），explorer 完成后自动运行。
- `agent-chisel-explorer` 只读生成 as-is（面向人类学习的图形化版本）。
- `agent-chisel-planner` 从 `as-is/ai-input/` 结构化输入 + `requirement-clarification.json` 设计 to-be 方案。
- `agent-chisel-coder` 只按已确认 task 实现。
- `agent-chisel-reviewer` 通用 CR agent（opus），从功能 diff 出发审查（非全文件），每次加载一个维度定义文件（dim-spec/dim-d2~d7）执行单维度深度审查。7 个维度 7 次独立调用。

## As-Is 分层结构

- **主干文件**（必须）：`repo-map.json`（脚本生成）、`overview.md`、`core-walkthrough.md`、`evidence-index.md`、`knowledge-candidates.md`、`context-budget.md`、`quality-score.json`（脚本生成）
- **枝干文件**（按需）：`details/entrypoints.md`、`details/data-model.md`、`details/api-contracts.md`、`details/data-flow.md`
- **AI 输入版**（`as-is/ai-input/`）：用户确认后从人类版提取的结构化数据，供 Planner 使用。
- 主干聚焦需求相关的核心链路，枝干按需展开细节，主干用 `→ 详见 details/xxx.md` 引用。

## 知识系统

- 实时捕获：对话中识别到禁区/包袱/坏味道/术语时即时写入 `knowledge-candidates/`。
- Wiki 组织：`.chisel/wiki/{project-name}/` 存储长期领域知识（project-name = git 仓库名），每个文件含 `## 关联关系` 章节。
- 自动注入：SessionStart hook 检测 wiki 存在时写入 `.claude/settings.local.json` rule。
- 知识流：候选 → 用户确认 → wiki-manage.mjs 合入 → rule 激活。
- 自动种子检测：debt-scan.mjs 在 repo-map 之后运行，基于文件指标和模式匹配生成初始候选（source_step: "debt-scan"），explorer 在探索中验证并补充业务语境。

## 关键约束

- 不要跳过 as-is 和 to-be 确认。
- 不要凭上下文记忆决定下一步，始终调用 `orchestration-status.mjs`。
- 同一 task 最多返修 3 次，超过后进入 blocked。
- 知识候选不自动合入 wiki，必须用户确认。
- 每次提交代码到主干（push to main）前，必须先更新 `.claude-plugin/plugin.json` 中的 `version` 字段。版本号遵循 semver：bug fix 升 patch，新功能/行为变更升 minor，破坏性变更升 major。版本更新应包含在同一次提交中。

## 并行开发

- Worktree 粒度为 per-requirement：一个需求对应一个 worktree（用户在 `worktree:setup` 选择），内部 task 串行/并行执行。
- Worktree 决策在方案确认后（`plan:confirm` 之后、`tasks:init` 之前）由用户选择，从 main 分支创建 worktree 或在当前分支开发。
- 用户选 `current-branch` 时，所有 task 串行执行，**不使用 Agent worktree 隔离**。
- 用户选 `worktree` 时，`getNextTasks()` 返回多个 task 且无文件重叠时，使用 `Agent(isolation: "worktree")` 并行编码（这是 Agent 工具的临时隔离，task 级，用完即弃），合并后统一更新状态。
- 有重叠 task 串行执行；返修 task 始终串行。
- `chisel-review` 在所有 task 编码完成后进行 7 维度独立 CR：spec 门槛（opus，合规检查）通过后，D2-D7 每个维度独立一次 opus 调用，全量审查后聚合结果。返修后从 spec 重新开始。
- 需求完成后（`done` 阶段），如果在 worktree 中，提示用户合并分支到主干（PR 或直接 merge）。
