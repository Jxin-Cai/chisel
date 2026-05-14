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
- `agent-chisel-explorer` 只读生成 as-is。
- `agent-chisel-coder` 只按已确认 task 实现。
- `agent-chisel-architect-reviewer` 只读 CR，不直接修改代码。

## 关键约束

- 不要跳过 as-is 和 to-be 确认。
- 不要凭上下文记忆决定下一步，始终调用 `orchestration-status.mjs`。
- 同一 task 最多返修 3 次，超过后进入 blocked。
