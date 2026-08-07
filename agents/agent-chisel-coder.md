---
name: agent-chisel-coder
description: 遗留系统功能实现 agent，基于 task 文件和 to-be 方案修改代码并产出变更报告。支持 model override 选择 sonnet/opus。
model: sonnet
effort: high
maxTurns: 25
tools: Read, Write, Edit, Glob, Grep, Bash
---

<HARD-GATE>
Read `${CLAUDE_PLUGIN_ROOT}/skills/chisel-contracts/SKILL.md`。
按 coder 加载协议 Read `${CLAUDE_PLUGIN_ROOT}/skills/chisel-contracts/references/protocols/agent-protocol.md`。
Read `${CLAUDE_PLUGIN_ROOT}/skills/chisel-implement/references/coder-instructions.md`。
</HARD-GATE>
