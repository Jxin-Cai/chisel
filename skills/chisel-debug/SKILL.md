---
name: chisel-debug
description: Reproduce-first root-cause workflow for a failing task; callable independently or from the rework loop.
argument-hint: "<idea-name> <task-id> [--standalone|--return-diagnosis]"
user-invocable: true
---

# chisel-debug

`chisel-debug` is a first-class, file-backed debugging workflow. It can be
invoked directly for a production/repro incident, or by `chisel-implement`
when a task is repeatedly rejected. It never guesses from the latest CR only:
the report records evidence and the exact phase reached.

## Modes

- **Standalone** (`--standalone`): after the root cause is confirmed, the
  workflow may coordinate a minimal repair and verification. The debug agent
  still does not silently edit business code; the repair is an explicit,
  separately verified phase.
- **Return diagnosis** (`--return-diagnosis`, the compatibility default): run
  the investigation and fix strategy only, then hand the report back to
  `chisel-implement`. This mode never executes a repair or claims verification.

## Reproduce-first phases

Run the phases in this order; each completed phase must include evidence:

1. `triage` — collect the task, CR rounds, symptoms, and affected scope.
2. `reproduce` — capture a deterministic failing command/input/output, or
   explicitly record why reproduction is unavailable.
3. `environment_sanity` — check versions, configuration, fixtures, and the
   relevant worktree/commit identity.
4. `trace` — follow the failing data/control path from entry to symptom.
5. `root_cause` — compare hypotheses against evidence and set
   `root_cause.confirmed=true` only when one explains the failure.
6. `fix_strategy` — describe the smallest invariant-preserving repair and its
   verification plan.

Standalone mode then adds `repair` and `verify`. `verify` cannot complete until
`repair` is complete. Return-diagnosis mode ends with a machine-readable
handoff and returns control to the implementation workflow.

## Invocation

Resolve the shared control plane first, so the command works from the outer
workspace, the original repository, or any linked worktree:

```bash
IDEA_DIR=$(node ${CLAUDE_PLUGIN_ROOT}/scripts/control-plane.mjs --project-root . --idea <idea-name>)
node ${CLAUDE_PLUGIN_ROOT}/scripts/debug-workflow.mjs \
  --idea-dir "$IDEA_DIR" --task <task-id> --return-diagnosis
```

Advance a phase explicitly (the command is idempotent and writes atomically):

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/debug-workflow.mjs \
  --idea-dir "$IDEA_DIR" --task <task-id> \
  --phase reproduce --status completed --evidence 'test command + output'
```

The canonical report is `{IDEA_DIR}/debug/{task-id}-debug.json`. A human
summary may be rendered as `{IDEA_DIR}/debug/{task-id}-debug.md`; both must
carry the same mode, phase order, root-cause confirmation, and handoff status.

## Rework integration

`chisel-implement` invokes return-diagnosis mode at rework count ≥ 2. Read all
prior CRs, reproduce the current failure, and return the report before making
another implementation attempt. If the report confirms a plan/task boundary
defect, recommend returning to planning and mark the task blocked rather than
repeating an unverified patch.

<HARD-GATE principle="P2">
No repair or “verified” claim may be recorded before a confirmed root cause and
an explicit reproduce/environment/trace evidence chain. A return-diagnosis
report is a handoff, not a code change.
</HARD-GATE>
