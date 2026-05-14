# chisel

Claude Code plugin for adding features to legacy systems with a file-driven workflow.

## Usage

Use the main skill:

```text
/chisel <需求描述或需求文件路径>
```

The plugin creates runtime artifacts in the target project:

```text
.chisel/<idea-name>/
```

## Workflow

1. Understand as-is behavior.
2. Confirm as-is with the user.
3. Design to-be implementation plan.
4. Confirm to-be with the user.
5. Split work into tasks.
6. Implement tasks with coding subagents.
7. Review each task with an architect reviewer.
8. Rework at most three times per task.
9. Summarize final changes.

## Key files

- `skills/chisel/SKILL.md` — main orchestrator.
- `scripts/orchestration-status.mjs` — resume point detector.
- `scripts/workflow-status.mjs` — task state manager.
- `scripts/gate-check.mjs` — postcondition checker.
- `agents/agent-chisel-coder.md` — task implementation agent.
