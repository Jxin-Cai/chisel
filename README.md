<div align="center">

# Chisel

**File-driven workflow plugin for safely enhancing legacy systems — on top of Claude Code.**

[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Plugin-D97757.svg)](https://github.com/anthropics/claude-code)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933.svg?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

[English](./README.md)&ensp;|&ensp;[中文文档](./README_zh.md)&ensp;|&ensp;[License](./LICENSE)

</div>

<br/>

Chisel is a [Claude Code](https://github.com/anthropics/claude-code) plugin that enforces a structured workflow for adding features to legacy systems: understand as-is → confirm to-be plan → decompose tasks → implement → architect CR → rework loop, with project knowledge accumulated into a progressively-loaded wiki.

Every step produces file-based artifacts, making it easy to resume after interruption and audit every AI decision.

<br/>

## Table of Contents

- [Why Chisel](#why-chisel)
- [Installation](#installation)
- [Quick Start](#quick-start)
- [Core Workflow](#core-workflow)
- [Artifacts](#artifacts)
- [Knowledge System](#knowledge-system)
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
| **Confirm** | Three mandatory human checkpoints — as-is understanding, strategy direction, and task decomposition |
| **Implement** | Scoped coding with file-boundary enforcement, parallel task execution when safe |
| **Review** | Multi-dimension architect CR with automatic rework loop (max 5 rounds) |
| **Knowledge** | Capture forbidden zones, legacy baggage, and terminology into a persistent project wiki |

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

Chisel creates a runtime artifact directory `.chisel/<idea-name>/` in your business repo, recording requirement understanding, confirmation results, implementation plans, task states, CR conclusions, and knowledge candidates.

<br/>

## Core Workflow

### Overview

```
Receive requirement → Understand as-is → User confirm → [Generate AI input]
→ Strategy design → User confirm strategy → Task decomposition → User confirm tasks
→ Init tasks → Code → Architect CR → [Rework loop] → [Knowledge extraction]
→ Final summary → Done → [Worktree merge]
```

Bracketed steps may be skipped depending on complexity classification.

### Workflow Steps

| # | Step | Description |
|---|---|---|
| 1 | **Receive requirement** | Parse user input, save as `requirement.md` |
| 2 | **Understand as-is** | Explorer agent reads code, produces overview, core-walkthrough, evidence-index |
| 3 | **Confirm as-is** | Human reviews 3-minute summary, risk map, misconceptions, signs off |
| 4 | **Generate AI input** | Distill human docs into structured AI-consumable format (skipped for trivial) |
| 5 | **Design strategy** | Planner produces implementation plan, tasks, traceability matrix |
| 6 | **Confirm plan** | Human reviews strategy and task decomposition, signs off |
| 7 | **Knowledge extraction** | Extract long-term knowledge candidates (skipped for trivial) |
| 8 | **Init tasks** | Generate task files and state machine from `tasks.json` |
| 9 | **Code** | Coder agent implements within scoped file boundaries |
| 10 | **Architect CR** | Reviewer agent checks acceptance criteria and behavior invariants |
| 11 | **Rework loop** | Max 3 rounds per task, then blocked |
| 12 | **Final summary** | Aggregate changes, scope control, wiki updates |
| 13 | **Done** | Prompt worktree merge if applicable |

### Complexity Classification

| Level | Criteria | Effect |
|---|---|---|
| `trivial` | ≤ 2 files, no new tables/APIs, < 3 cross-module dirs | Skip AI input generation and knowledge extraction |
| `standard` | Default | Full workflow |

### Human Checkpoints

Chisel has **3 mandatory confirmation gates** that pause the workflow:

1. **As-is confirmation** — verify understanding of current system behavior
2. **Strategy confirmation** — approve implementation direction and design decisions
3. **Task confirmation** — approve task decomposition and dependencies

Knowledge signals detected during confirmation dialogues (forbidden zones, legacy baggage, terminology) are captured in real-time to `knowledge-candidates/`.

### Worktree Isolation

Chisel strongly recommends working in an isolated git worktree for legacy system changes. One requirement = one worktree. On completion, chisel assists with PR creation or direct merge.

### Parallel Execution

When multiple tasks have no file overlap:
- **No overlap** → parallel coding via `Agent(isolation: "worktree")`
- **File overlap or exports/imports dependency** → sequential
- **Rework tasks** → always sequential
- **CR reviews** → parallel dispatch (read-only, no worktree needed)

### Rollback

Preview rollback impact before executing:

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-status.mjs .chisel/<idea-name> --rollback-step <step> --dry-run
```

Rollback only cleans whitelisted runtime artifacts — never deletes business source code, wiki, or knowledge candidates.

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
.chisel/<idea-name>/tasks/
  task-001.md                  # Task file with Exports/Imports
.chisel/<idea-name>/task-workflow-state.yaml
```

### Reports & CR

```text
.chisel/<idea-name>/task-reports/    # Implementation reports
.chisel/<idea-name>/cr/              # Code review results
.chisel/<idea-name>/final-summary.md # Final change summary
```

<br/>

## Knowledge System

Chisel accumulates long-term project knowledge into `.chisel/wiki/{project-name}/`:

| Category | Purpose |
|---|---|
| **Forbidden zones** | Code that must not be modified directly |
| **Baggage** | Odd designs with historical reasons |
| **Code smells** | Things that look refactorable but shouldn't be touched now |
| **Terminology** | Business concept ↔ code concept mappings |
| **ADR / module map / hotspot** | Context for future task planning |

### Standalone Wiki Management

The wiki doesn't depend on the main chisel workflow. Use `/chisel-wiki` anytime:

```text
/chisel-wiki init                    # Initialize wiki
/chisel-wiki feed forbidden_zone ... # Add a knowledge entry
/chisel-wiki query payments          # Query related knowledge
/chisel-wiki health                  # Check reference validity
/chisel-wiki list                    # List all entries
/chisel-wiki import file.json        # Bulk import
```

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

### Stale Detection

Tasks in `coding`/`repairing` state for > 30 minutes trigger a stale warning in orchestration status.

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
| `/chisel-status` | View recovery point and task state |
| `/chisel-wiki` | Standalone knowledge management |

### Agents

| Agent | Description |
|---|---|
| `agent-chisel-writer` | Generate human-readable docs from structured artifacts (sonnet) |
| `agent-chisel-coder` | Implement confirmed tasks (sonnet) |
| `agent-chisel-coder-light` | Fast coding for trivial tasks (haiku) |
| `agent-chisel-coder-heavy` | Deep coding for complex tasks (opus) |
| `agent-chisel-reviewer` | Multi-dimension CR with single-dimension-per-pass (opus) |

### Scripts

| Script | Description |
|---|---|
| `orchestration-status.mjs` | Side-effect-free recovery point and complexity detection |
| `orchestration-transition.mjs` | Explicit revision-checked state transition and event recording |
| `gate-check.mjs` | Phase postcondition gate validation |
| `task-init.mjs` | Initialize task files and state machine |
| `workflow-status.mjs` | Task state query, rollback, overlap detection |
| `task-provenance.mjs` | Per-task baseline/result fingerprint and changed-file ownership |
| `verify-run.mjs` | Repository-aware build/test verification bound to workspace fingerprints |
| `checkpoint.mjs` | Source-bound, full-artifact consistent snapshots and recovery |
| `wiki-manage.mjs` | Wiki init, merge, query, health-check |
| `scope-check.mjs` | File boundary and forbidden zone validation |
| `repo-map.mjs` | Code map generation (stats, structure, entry candidates) |
| `debt-scan.mjs` | Static technical debt scanning |
| `as-is-score.mjs` | As-is artifact quality scoring |
| `cr-prepare.mjs` | Pre-compute diff/scope/wiki data for reviewer |
| `dashboard.mjs` | Self-contained HTML dashboard generation |

<br/>

## Contributing

Contributions are welcome. If you plan significant changes, **open an issue first** to discuss direction and scope.

Bug reports, feature requests, and pull requests are all appreciated.

<br/>

## License

Licensed under the [MIT License](./LICENSE).

Copyright 2026 jxin
