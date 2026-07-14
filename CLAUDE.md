# CLAUDE.md

This repository contains the `chisel` Claude Code plugin.

## 项目概述

`chisel` 用于在遗留系统上增加功能。它通过文件驱动流程强制完成 as-is 理解、to-be 方案确认、task 化实现、架构师 CR 和返修闭环。

## 关键约束

- 不要跳过 as-is 和 to-be 确认。
- 不要凭上下文记忆决定下一步，始终调用 `orchestration-status.mjs`。
- 同一 task 最多返修 3 次，超过后进入 blocked。
- 知识候选不自动合入 wiki，必须用户确认。
- 每次提交代码到主干（push to main）前，必须先更新 `.claude-plugin/plugin.json` 中的 `version` 字段。版本号遵循 semver：bug fix 升 patch，新功能/行为变更升 minor，破坏性变更升 major。版本更新应包含在同一次提交中。

## 架构详情

详细架构说明参见 `skills/chisel-contracts/references/architecture-overview.md`。
