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
- `scripts/audit-log.mjs` 全链路审计日志（step 流转、gate 结果、task 状态变更）。
- `scripts/wiki-manage.mjs` wiki 初始化、候选合入、关联关系管理。
- `scripts/wiki-rule-inject.mjs` 自动向业务项目注入 wiki 加载 rule。
- `agent-chisel-explorer` 只读生成 as-is（面向人类学习的图形化版本）。
- `agent-chisel-planner` 从 `as-is/ai-input/` 结构化输入设计 to-be 方案。
- `agent-chisel-coder` 只按已确认 task 实现。
- `agent-chisel-architect-reviewer` 只读 CR，不直接修改代码。

## As-Is 分层结构

- **主干文件**（必须）：`overview.md`、`core-walkthrough.md`、`evidence-index.md`、`knowledge-candidates.md`
- **枝干文件**（按需）：`details/entrypoints.md`、`details/data-model.md`、`details/api-contracts.md`、`details/data-flow.md`、`details/tests.md`
- **AI 输入版**（`as-is/ai-input/`）：用户确认后从人类版提取的结构化数据，供 Planner 使用。
- 主干聚焦需求相关的核心链路，枝干按需展开细节，主干用 `→ 详见 details/xxx.md` 引用。

## 知识系统

- 实时捕获：对话中识别到禁区/包袱/坏味道/术语时即时写入 `knowledge-candidates/`。
- Wiki 组织：`.chisel/wiki/{project-name}/` 存储长期领域知识（project-name = git 仓库名），每个文件含 `## 关联关系` 章节。
- 自动注入：SessionStart hook 检测 wiki 存在时写入 `.claude/settings.local.json` rule。
- 知识流：候选 → 用户确认 → wiki-manage.mjs 合入 → rule 激活。

## 关键约束

- 不要跳过 as-is 和 to-be 确认。
- 不要凭上下文记忆决定下一步，始终调用 `orchestration-status.mjs`。
- 同一 task 最多返修 3 次，超过后进入 blocked。
- 知识候选不自动合入 wiki，必须用户确认。

## 并行开发

- Worktree 粒度为 per-requirement：一个需求对应一个 worktree，内部 task 串行/并行执行。
- 启动时检测 worktree 隔离状态，建议用户使用 `EnterWorktree` 保护当前分支。
- `getNextTasks()` 返回多个 task 时，`chisel-implement` 通过 `--check-overlap` 检测文件重叠。
- 无重叠 task 使用 `Agent(isolation: "worktree")` 并行编码，合并后统一更新状态。
- 有重叠 task 串行执行；返修 task 始终串行。
- `chisel-review` 对多个 coded task 并行派发 reviewer（reviewer 只读，无需 worktree）。
- 需求完成后（`done` 阶段），如果在 worktree 中，提示用户合并分支到主干（PR 或直接 merge）。
