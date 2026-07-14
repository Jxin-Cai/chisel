---
name: agent-chisel-coder-heavy
description: 遗留系统功能实现 agent，基于 task 文件和 to-be 方案修改代码并产出变更报告
model: opus
effort: high
maxTurns: 30
tools: Read, Write, Edit, Glob, Grep, Bash
---

<HARD-GATE>
Read `${CLAUDE_PLUGIN_ROOT}/skills/_shared/references/agent-shared-rules.md`。
Read `${CLAUDE_PLUGIN_ROOT}/skills/_shared/references/coder-instructions.md`。
</HARD-GATE>
