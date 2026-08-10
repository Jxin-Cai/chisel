<div align="center">

# Chisel

**File-driven workflow plugin for safely enhancing legacy systems — on top of Claude Code.**

[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Plugin-D97757.svg)](https://github.com/anthropics/claude-code)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933.svg?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

[English](./README.md)&ensp;|&ensp;[中文文档](./README_zh.md)&ensp;|&ensp;[License](./LICENSE)

</div>

<br/>

Chisel is a [Claude Code](https://github.com/anthropics/claude-code) plugin that enforces a structured workflow for adding features to legacy systems: understand as-is → design to-be → run an adversarial completeness review → confirm the plan → decompose tasks → implement → architect CR → rework loop → review the current change report → approve delivery. The adversarial review is machine-gated: an incomplete plan cannot be shown to the user for confirmation.

Every step produces file-based artifacts, making it easy to resume after interruption and audit every AI decision.

<br/>

## Table of Contents

- [Why Chisel](#why-chisel)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Core Workflow](#core-workflow)
- [Artifacts](#artifacts)
- [Quality Control](#quality-control)
- [Architecture](#architecture)
- [Contributing](#contributing)
- [License](#license)

<br/>

## Why Chisel

Legacy systems carry hidden constraints, undocumented business rules, and fragile integration points. Directly prompting an AI to "add feature X" skips the understanding phase and risks breaking invariants.

Chisel solves this with a **gate-driven workflow**:

| Phase | What it does |
|---|---|
| **Understand** | Read-only exploration of relevant code paths, producing human-readable as-is documentation with evidence |
| **Confirm** | Human gates for as-is, the complete to-be plan/task set, and the exact pre-merge change snapshot |
| **Implement** | Scoped coding with file-boundary enforcement, parallel task execution when safe |
| **Review** | Multi-dimension architect CR with automatic rework, followed by a snapshot-bound human merge review |

No step is skipped. No decision is made from memory alone — the orchestrator always reads the file-based state machine.

<br/>

## Installation

### Step 1: Add the plugin marketplace

```text
/plugin marketplace add Jxin-Cai/chisel
```

This registers the `Jxin-Cai/chisel` repository as your plugin source. Only needed once.

### Step 2: Install the plugin

```text
/plugin install chisel@chisel
/reload-plugins
```

Verify with `/plugin` and `/skills` — you should see the `chisel` plugin and its skills listed.

### Step 3: Use it

Run Claude Code in your **target business repository**, then:

```text
/chisel <requirement description or path to requirement file>
```

> Chisel runs in the target codebase, not in the chisel plugin repository itself.

### Alternative install methods

**CLI install** (non-interactive):

```bash
claude plugin install chisel@chisel --scope user
```

**Local development** (load from local directory):

```bash
claude --plugin-dir /absolute/path/to/chisel
```

<br/>

## Quick Start

```text
/chisel Add phone number format validation to user creation flow, keep old API response compatible
```

Or pass a requirement file:

```text
/chisel docs/requirements/user-phone-validation.md
```

Chisel stores runtime artifacts under the Git common root at `.chisel/<idea-name>/`, so the main checkout and linked worktrees share one control plane. Set `CHISEL_CONTROL_ROOT` to override it.

<br/>

## Core Workflow

### Overview

```
Receive requirement → Clarify requirement → Classify difficulty/profile
→ [Full only: Understand as-is → async Writer → User confirm]
→ Strategy design → async Writer → Adversarial completeness review (repair loop) → User confirm strategy
→ Init tasks → Code → Architect CR → [Rework loop]
→ Final summary → Current Change Report → User merge decision → Delivery
```

Bracketed steps may be skipped depending on complexity classification.

### Workflow Steps

| # | Step | Description |
|---|---|---|
| 1 | **Receive requirement** | Parse user input, save as `requirement.md` |
| 2 | **Clarify and classify** | Clarify first, then persist a fingerprinted difficulty, risk, execution profile, and subagent budget |
| 3 | **Understand as-is (full only)** | Existing codebases use Explorer/analyst plus a background Writer. Repositories with zero historical source files use a deterministic greenfield baseline and launch no discovery agents. |
| 4 | **Confirm as-is (full only)** | Human reviews 3-minute summary, risk map, misconceptions, signs off |
| 5 | **Design strategy** | Planner produces implementation plan, tasks, traceability matrix |
| 6 | **Adversarial completeness review** | A fresh reviewer checks every requirement/AC/VC against the complete to-be artifacts; findings force a planner repair and another review |
| 7 | **Confirm plan** | Human reviews only after the adversarial gate passes |
| 8 | **Init tasks** | Generate task files and state machine from `tasks.json` |
| 9 | **Code** | Coder agent implements within scoped file boundaries |
| 10 | **Architect CR** | Reviewer agent checks acceptance criteria and behavior invariants |
| 11 | **Rework loop** | Up to 5 rounds per task; later rounds use a fresh agent and then become blocked |
| 12 | **Final summary** | Aggregate changes, scope control, and delivery receipts |
| 13 | **Merge review** | Generate the current change report; require Approve, Request changes, or Comment/hold |
| 14 | **Delivery** | Convert, merge, or resolve through isolated integration worktrees after approval |

### Complexity Classification

| Level | Criteria | Effect |
|---|---|---|
| `hotfix` | Explicit urgent fix, low risk, one bounded file | Quick path with spec-only review; otherwise auto-escalate |
| `minor` | Small compatible behavior change | Clarify, quick path, spec-only review |
| `trivial` | ≤ 2 files, no new tables/APIs, < 3 cross-module dirs | Quick path with spec-only review |
| `moderate` | Conservative post-clarification floor or bounded multi-file change | Lightweight plan from requirement/clarification plus a bounded source manifest; no as-is agents |
| `standard` | Cross-module or boundary change | Full as-is/to-be flow plus integration review; greenfield repositories keep this delivery rigor while using the fast N/A as-is profile |
| `complex` | High-risk, multi-repo, migration, or broad change | Full flow with all review dimensions and integration review |

### Human Checkpoints

Chisel has **up to 3 human gates**, selected by the classified workflow:

1. **As-is confirmation** — verify understanding of current system behavior
2. **To-be confirmation** — approve implementation direction, task decomposition, dependencies, and risk
3. **Pre-merge review** — review the generated change report and explicitly approve the exact Git/workspace snapshot

The full route uses all three gates. The moderate route skips as-is confirmation and uses To-be plus pre-merge review. Direct hotfix/minor/trivial routes skip both design confirmations and normally require only the exact pre-merge review.

Confirmation decisions are persisted in the idea directory and are read by the orchestrator on every resume; no hidden sidecar knowledge store is required.

### Worktree Isolation

Chisel supports an outer non-Git workspace containing one or more Git repositories. The shared idea registry records the control plane, repository paths, branches, base/default refs, and lifecycle so a later session can locate/resume from the outer workspace, any repository, or any linked worktree. One requirement gets one logical branch per repository; parallel repositories use separate worktrees.

### Parallel Execution

When multiple tasks have no file overlap:
- **No overlap** → parallel coding via `Agent(isolation: "worktree")`
- **File overlap or exports/imports dependency** → sequential
- **Rework tasks** → always sequential
- **CR reviews** → parallel dispatch (read-only, no worktree needed)

### Rollback

Preview rollback impact before executing:

```bash
IDEA_DIR=$(node ${CLAUDE_PLUGIN_ROOT}/scripts/control-plane.mjs --project-root . --idea <idea-name>)
node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-status.mjs "$IDEA_DIR" --rollback-step <step> --dry-run
```

Rollback only cleans whitelisted runtime artifacts — never deletes business source code.

<br/>

## Artifacts

### As-is Documentation

```text
.chisel/<idea-name>/as-is/
  overview.md              # 3-minute summary, risk map, misconceptions
  core-walkthrough.md      # Core path sequence diagrams
  evidence-index.md        # Evidence index table
  evidence-ledger.json     # Structured evidence ledger
  coverage-matrix.json     # Entry/path/data/side-effect coverage
  ai-input/                # Structured AI-consumable version (standard only)
    facts.md, call-graph.md, data-schema.md, api-surface.md,
    constraints.md, change-surface.md
```

### To-be & Tasks

```text
.chisel/<idea-name>/to-be/
  implementation-plan.md       # Strategy and design decisions
  tasks.json                   # Machine-readable task definitions
  traceability-matrix.json     # Requirement → task traceability
  adversarial-review.md        # Human-readable completeness findings and evidence
  adversarial-review.json      # Machine-gated pass/findings record
.chisel/<idea-name>/tasks/
  task-001.md                  # Task file with Exports/Imports
.chisel/<idea-name>/task-workflow-state.yaml
```

### Reports & CR

```text
.chisel/<idea-name>/task-reports/    # Implementation reports
.chisel/<idea-name>/cr/              # Code review results
.chisel/<idea-name>/cr/current-change-report.md   # Human pre-merge report
.chisel/<idea-name>/cr/current-change-report.json # Snapshot-bound report data
.chisel/<idea-name>/confirmations/merge-review.json # Approve / request changes / hold decision
.chisel/<idea-name>/confirmations/cr-report.json    # Hash-bound CR report confirmation
.chisel/<idea-name>/confirmations/task-time-report.json # Hash-bound task/time report confirmation
.chisel/<idea-name>/reports/                        # Four standalone HTML reports
.chisel/<idea-name>/final-summary.md # Final change summary
```

After every completed workflow step, Chisel prints each deliverable as an absolute-path Markdown link in the conversation. The deterministic renderer can also be run directly:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/phase-artifacts.mjs <idea-dir> <completed-step>
```

Standalone HTML report links supplement these file links; they do not replace the underlying artifacts. Chisel generates As-Is, To-Be, CR, and task/time reports one at a time, immediately returns the file link and SHA-256, and blocks workflow progress until the user explicitly confirms that exact report version.

<br/>

## Quality Control

### Risk-based SDD Requirements

| Risk Level | Required Sections |
|---|---|
| `low` | Acceptance Criteria |
| `medium` | + Behavior Invariants, Forbidden Files |
| `high` | All fields mandatory |

### Scope Check

After coding, `scope-check.mjs` verifies:
- Changed files stay within declared boundaries
- No forbidden file modifications
- No undeclared new public exports

### To-be completeness gate

Before `plan:confirm`, `plan:adversarial-review` runs a fresh, adversarial comparison of `requirement.md`, clarification AC/VC, as-is evidence, and every structured to-be artifact. It writes `to-be/adversarial-review.json` and `.md`. A `fail` result includes actionable findings and routes back to `plan:design`; only a machine-validated `pass` can reach user confirmation. The loop has a bounded retry count and becomes `blocked` rather than silently allowing an incomplete plan.

Traceability is strict in schema v2+: missing or empty matrices fail, every AC and verification condition needs an exact mapping, and task-to-matrix references are checked in both directions. Implementation cannot pass on a vague report: each task must have non-placeholder Acceptance Criteria Result and Traceability Evidence, and `Completion Status: DONE` (or an explicitly reviewed `DONE_WITH_CONCERNS`) before verification/review.

### Stale Detection

A task becomes stale when its `run_id` lease expires. Long operations renew the lease with a heartbeat instead of relying on a fixed 30-minute guess.

<br/>

## Architecture

### Skills

| Skill | Description |
|---|---|
| `/chisel` | Main orchestrator — drives end-to-end workflow |
| `/chisel-understand` | Read-only as-is exploration and documentation |
| `/chisel-plan` | To-be planning (strategy + decomposition) |
| `/chisel-implement` | Orchestrate coding subagents |
| `/chisel-review` | Architect CR review |
| `/chisel-report` | View recovery point/task state or generate four standalone HTML reports |
| `/chisel-debug` | Reproduce-first root-cause workflow (standalone or return-diagnosis mode) |

### Agents

| Agent | Description |
|---|---|
| `agent-chisel-writer` | Generate human-readable docs from structured artifacts (sonnet) |
| `agent-chisel-analyst` | Deep code walkthrough, produce structured as-is data (sonnet) |
| `agent-chisel-coder` | Implement and verify confirmed tasks (inherits the orchestrator model; opus override for complex/escalated work) |
| `agent-chisel-reviewer` | Multi-dimension CR with single-dimension-per-pass (opus) |

### Scripts

| Script | Description |
|---|---|
| `orchestration-runner.mjs` | Durable leased runner with crash recovery and idempotent transitions |
| `orchestration-status.mjs` | Side-effect-free authoritative recovery-point calculation |
| `control-plane.mjs` | Resolves the shared control plane across linked worktrees |
| `orchestration-transition.mjs` | Explicit revision-checked state transition and event recording |
| `gate-check.mjs` | Phase postcondition gate validation |
| `traceability-check.mjs` | Bidirectional AC/VC → task coverage and final approval check |
| `adversarial-review.mjs` | Deterministic to-be completeness review and bounded repair-loop record |
| `task-init.mjs` | Initialize task files and state machine |
| `workflow-status.mjs` | Task state query, rollback, overlap detection |
| `task-provenance.mjs` | Per-task baseline/result fingerprint and changed-file ownership |
| `verify-run.mjs` | Repository-aware build/test verification bound to workspace fingerprints |
| `checkpoint.mjs` | Source-bound, full-artifact consistent snapshots and recovery |
| `scope-check.mjs` | File boundary and forbidden zone validation |
| `multi-repo-worktree.mjs` | Registry-backed multi-repository worktrees, locator/resume/status, and receipts |
| `branch-merge.mjs` | Isolated integration merge and machine-readable conflict analysis |
| `review-selector.mjs` | Diff/path/content-based review risk and dimension selection |
| `repo-map.mjs` | Code map generation (stats, structure, entry candidates) |
| `debt-scan.mjs` | Static technical debt scanning |
| `as-is-score.mjs` | As-is artifact quality scoring |
| `cr-prepare.mjs` | Pre-compute diff and scope data for reviewer |
| `reports.mjs` | Four standalone HTML reports (As-Is, To-Be, CR, task/time) |

<br/>

## Contributing

Contributions are welcome. If you plan significant changes, **open an issue first** to discuss direction and scope.

Bug reports, feature requests, and pull requests are all appreciated.

<br/>

## License

Licensed under the [MIT License](./LICENSE).

Copyright 2026 jxin
