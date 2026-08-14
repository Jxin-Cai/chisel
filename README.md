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

For a fully unattended run that merges into the local default branch after every quality gate passes, use HOTOL mode:

```text
/chisel-hotol Add phone-number validation while preserving the existing API response contract
```

HOTOL persists the user's explicit authorization, applies conservative reversible defaults, approves the plan and exact final snapshot,
uses isolated worktrees, and merges only after verification and CR pass. It does not push, force-push, delete branches, or absorb
pre-existing uncommitted changes by default. A real conflict, missing authority, or high-risk ambiguity without a uniquely safe answer
becomes a recorded terminal blocker instead of an interactive question.

Every `/chisel` invocation starts a new isolated requirement by default. Chisel never resumes, scans, or reuses another requirement's
artifacts unless the user explicitly asks to resume a specific idea. Runtime artifacts live under the Git common root at
`.chisel/<allocated-idea-name>/`; repeated names receive numeric suffixes. Set `CHISEL_CONTROL_ROOT` to override the control root.

<br/>

## Core Workflow

### Overview

```
Receive requirement → Clarify requirement → Classify difficulty/profile
→ [Full only: Understand as-is → deterministic document rendering]
→ Strategy design → deterministic document rendering → Adversarial completeness review (repair loop) → User confirm strategy
→ Init tasks → Code → Unit tests/coverage and consolidated anomaly repair → Unit-test report
→ Multi-dimensional Architect CR → [Rework loop] → Final CR report
→ Final summary → Merge-review section in CR report → User merge decision → Delivery
```

Bracketed steps may be skipped depending on complexity classification.

### Workflow Steps

| # | Step | Description |
|---|---|---|
| 1 | **Receive requirement** | Parse user input into a temporary `requirement.md`; clarification freezes it as `requirement-original.md` |
| 2 | **Clarify, confirm, and classify** | Let the model identify material gaps, persist every user addition, synthesize a development-ready `requirement.md`, bind user confirmation to its hash, then classify difficulty, risk, execution profile, and subagent budget |
| 3 | **Understand as-is (full only)** | Existing codebases use Explorer/analyst plus deterministic rendering. Repositories with zero historical source files use a greenfield baseline and launch no discovery agents. |
| 4 | **Confirm as-is (full only)** | Human reviews 3-minute summary, risk map, misconceptions, signs off |
| 5 | **Design strategy** | Planner produces implementation plan, tasks, traceability matrix |
| 6 | **Adversarial completeness review** | A fresh reviewer checks every requirement/AC/VC against the complete to-be artifacts; findings force a planner repair and another review |
| 7 | **Confirm plan** | Human reviews only after the adversarial gate passes |
| 8 | **Init tasks** | Generate task files and state machine from `tasks.json` |
| 9 | **Code** | Coder starts from the user-confirmed canonical requirement and navigation hints, then independently traces source, callers, dependencies, and tests |
| 10 | **Unit tests and coverage** | Fresh complete tests, coverage collection, consolidated anomaly repair, and a test report |
| 11 | **Architect CR** | Reviewer agent checks acceptance criteria and behavior invariants |
| 12 | **Rework loop** | Up to 5 rounds per task; later rounds use a fresh agent and then become blocked |
| 13 | **CR report** | After every finding is repaired and re-reviewed, summarize features, findings, and fixes |
| 14 | **Final summary** | Aggregate changes, scope control, and delivery receipts |
| 15 | **Merge review** | Generate the current change report; require Approve, Request changes, or Comment/hold |
| 16 | **Delivery** | Convert, merge, or resolve through isolated integration worktrees after approval |

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
IDEA_DIR=$(node ${CLAUDE_PLUGIN_ROOT}/scripts/control-plane.mjs --project-root . --idea <explicit-idea-name>)
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
    change-surface.md
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
.chisel/<idea-name>/cr/current-change-report.json # Internal snapshot data rendered into the CR report
.chisel/<idea-name>/confirmations/merge-review.json # Approve / request changes / hold decision
.chisel/<idea-name>/confirmations/to-be.json        # The only phase-level plan decision
.chisel/<idea-name>/reports/                        # Five standalone HTML reports, including unit-test coverage
.chisel/<idea-name>/final-summary.md # Final change summary
```

After every completed workflow step, Chisel prints each deliverable as an absolute-path Markdown link in the conversation. The deterministic renderer can also be run directly:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/phase-artifacts.mjs <idea-dir> <completed-step>
```

Standalone HTML report links supplement these file links; they do not replace the underlying artifacts. Chisel generates As-Is, To-Be, unit-test, CR, and task/time reports one at a time, immediately returns the file link and SHA-256, and blocks workflow progress until the user explicitly confirms that exact report version. The unit-test report precedes CR and focuses on coverage, requirement-specific tests, failures, and repair count. The CR report is generated only after multi-dimensional review and rework are complete.

<br/>

## Quality Control

### Risk-based SDD Requirements

| Risk Level | Required Sections |
|---|---|
| `low` | Acceptance Criteria |
| `medium` | + Behavior Invariants, Forbidden Files |
| `high` | All fields mandatory |

### Scope Check

After coding, `scope-check.mjs`:
- Blocks explicitly forbidden files and symbols
- Records expansion beyond starting points for semantic review instead of rejecting it
- Flags unusually broad file or module expansion

### To-be completeness gate

Before `plan:confirm`, `plan:adversarial-review` runs a fresh, adversarial comparison of `requirement.md`, clarification AC/VC, as-is evidence, and every structured to-be artifact. It writes `to-be/adversarial-review.json` and `.md`. A `fail` result includes actionable findings and routes back to `plan:design`; only a machine-validated `pass` can reach user confirmation. The loop has a bounded retry count and becomes `blocked` rather than silently allowing an incomplete plan.

Traceability remains strict in schema v2+. The Coder receives user-confirmed Plan goals, non-goals, contracts, invariants, tradeoffs, and task-relevant change points as decision context, while verifying Plan claims about existing code and exact files against first-hand evidence. It delivers only code, tests, and a summary of at most five lines. Provenance and post-processing scripts generate changed-file inventories and scope-risk records; reviewers verify invariants and requirement relevance.

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
| `/chisel-report` | View recovery point/task state or generate five standalone HTML reports |
| `/chisel-debug` | Reproduce-first root-cause workflow (standalone or return-diagnosis mode) |
| `/chisel-hotol` | Unattended requirement-to-verified-code flow with local default-branch merge |

### Agents

| Agent | Description |
|---|---|
| `scripts/document-render.mjs` | Deterministically render human-readable docs from structured artifacts without an agent call |
| `agent-chisel-analyst` | Deep code walkthrough, produce structured as-is data (sonnet) |
| `agent-chisel-coder` | Implement directly from the original requirement, source code, and runtime evidence without producing process-proof reports |
| `agent-chisel-oracle` | Freeze 1–12 independently observable black-box assertions from only the user-confirmed canonical requirement and public entry points, preferring detected project-native runners |
| `agent-chisel-reviewer` | Multi-dimension CR with single-dimension-per-pass (opus) |

### Scripts

| Script | Description |
|---|---|
| `orchestration-runner.mjs` | Durable leased runner with crash recovery and idempotent transitions |
| `orchestration-status.mjs` | Side-effect-free authoritative recovery-point calculation |
| `control-plane.mjs` | Resolves the shared control plane across linked worktrees |
| `orchestration-transition.mjs` | Explicit revision-checked state transition and event recording |
| `oracle-prepare.mjs` / `oracle-run.mjs` | Prepare isolated public-interface evidence and execute the frozen acceptance Oracle |
| `gate-check.mjs` | Phase postcondition gate validation |
| `traceability-check.mjs` | Bidirectional AC/VC → task coverage and final approval check |
| `adversarial-review.mjs` | Deterministic to-be completeness review and bounded repair-loop record |
| `task-init.mjs` | Initialize task files and state machine |
| `workflow-status.mjs` | Task state query, rollback, overlap detection |
| `task-provenance.mjs` | Per-task baseline/result fingerprint and changed-file ownership |
| `verify-run.mjs` | Repository-aware build/test verification bound to workspace fingerprints |
| `checkpoint.mjs` | Source-bound, full-artifact consistent snapshots and recovery |
| `scope-check.mjs` | Explicit forbidden-boundary validation plus starting-point expansion and diff-risk detection |
| `multi-repo-worktree.mjs` | Registry-backed multi-repository worktrees, locator/resume/status, and receipts |
| `branch-merge.mjs` | Isolated integration merge and machine-readable conflict analysis |
| `review-selector.mjs` | Diff/path/content-based review risk and dimension selection |
| `repo-map.mjs` | Code map generation (stats, structure, entry candidates) |
| `as-is-score.mjs` | As-is artifact quality scoring |
| `cr-prepare.mjs` | Pre-compute diff and scope data for reviewer |
| `reports.mjs` | Five standalone HTML reports (As-Is, To-Be, unit tests, CR, task/time) |

<br/>

## Contributing

Contributions are welcome. If you plan significant changes, **open an issue first** to discuss direction and scope.

Bug reports, feature requests, and pull requests are all appreciated.

<br/>

## License

Licensed under the [MIT License](./LICENSE).

Copyright 2026 jxin
