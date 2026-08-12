---
name: chisel-debug
description: 面向失败任务的“先复现、再根因”调试工作流；既可独立调用，也可由返修循环调用。
argument-hint: "<idea-name> <task-id> [--standalone|--return-diagnosis]"
user-invocable: true
---

# chisel-debug

`chisel-debug` 是一等的、文件驱动的调试工作流。它既可以直接处理线上故障或可复现问题，
也可以在 task 多次被 CR 驳回时由 `chisel-implement` 调用。它不会只看最新一轮 CR 就猜测原因；
报告必须记录证据以及实际推进到的阶段。

## 模式

- **独立模式**（`--standalone`）：根因确认后，工作流可以协调最小修复和验证。
  debug agent 仍不得静默修改业务代码；返修是一个明确且独立验证的阶段。
- **返回诊断模式**（`--return-diagnosis`，兼容默认值）：只完成调查与修复策略，
  然后把报告交回 `chisel-implement`。该模式不执行返修，也不得声称已经验证。

## 先复现的阶段顺序

必须按以下顺序执行；每个完成的阶段都必须附带证据：

1. `triage`（初步研判）— 收集 task、历次 CR、故障现象和影响范围。
2. `reproduce`（复现）— 记录可稳定失败的命令、输入和输出；无法复现时明确记录原因。
3. `environment_sanity`（环境核验）— 检查版本、配置、fixture，以及相关 worktree/commit 身份。
4. `trace`（链路追踪）— 从入口沿数据流和控制流追到故障现象。
5. `root_cause`（根因确认）— 用证据逐一比较假设；只有某个假设能解释故障时，才能设置
   `root_cause.confirmed=true`。
6. `fix_strategy`（修复策略）— 描述保持既有不变量的最小修复，以及对应验证方案。

独立模式随后增加 `repair`（返修）和 `verify`（验证）。`repair` 未完成前，`verify` 不得完成。
返回诊断模式以机器可读的 handoff 结束，并把控制权交回实现工作流。

## 调用方式

先解析共享控制面，使命令能从外层 workspace、原仓库或任意关联 worktree 中运行：

```bash
IDEA_DIR=$(node ${CLAUDE_PLUGIN_ROOT}/scripts/control-plane.mjs --project-root . --idea <idea-name>)
node ${CLAUDE_PLUGIN_ROOT}/scripts/debug-workflow.mjs \
  --idea-dir "$IDEA_DIR" --task <task-id> --return-diagnosis
```

显式推进一个阶段（命令幂等，并采用原子写入）：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/debug-workflow.mjs \
  --idea-dir "$IDEA_DIR" --task <task-id> \
  --phase reproduce --status completed --evidence 'test command + output'
```

规范报告是 `{IDEA_DIR}/debug/{task-id}-debug.json`。可另行渲染中文摘要
`{IDEA_DIR}/debug/{task-id}-debug.md`；两者必须具有相同的模式、阶段顺序、根因确认状态和 handoff 状态。

## 与返修流程衔接

当返修次数 ≥ 2 时，`chisel-implement` 调用返回诊断模式。再次尝试实现前，必须读取全部历史 CR、
复现当前故障并交回诊断报告。如果报告确认问题来自方案或 task 边界，应建议退回规划阶段并把 task
标记为 blocked，不能继续重复未经验证的补丁。

<HARD-GATE principle="P2">
根因未确认，或缺少明确的复现/环境/链路证据链时，不得记录返修，也不得声称“已验证”。
返回诊断报告只是交接物，不代表已经修改代码。
</HARD-GATE>
