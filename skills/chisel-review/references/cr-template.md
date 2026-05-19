---
task_id: task-001-example
round: 1
result: approved
rework_count: 0
---

# Architecture CR: task-001-example

## 结论

approved | needs_rework | blocked

结论章节仅供人类阅读；状态机只读取 frontmatter 的 `result` 字段。

## 功能完整度

## Scope Control

### Scope Check Re-run

- Command：`node ${CLAUDE_PLUGIN_ROOT}/scripts/scope-check.mjs {idea_dir} {task_id}`
- Result：pass | fail
- schema_version：3
- changed_files_count：
- violations_count：
- forbidden_symbol_hits_count：
- Reviewer conclusion：

#### Scope Check JSON Summary

粘贴 scope-check.mjs 的完整 JSON 输出。

#### Hit Proofs Reviewed

| File | Expected proof | Forbidden proof | Symbol proof | Reviewer assessment |
|---|---|---|---|---|
| | | | | |

#### Invariant Proofs

| Invariant | Proof | Result |
|---|---|---|
| | | pass / fail |

必须逐项覆盖 task `Behavior Invariants`；`Proof` 必须填写实际验证证据，不得为空或占位；`Result` 只能是 `pass` 或 `fail`；approved CR 必须全部为 `pass`。

## 审查详情

按 reviewer 审查维度（健壮性、并发安全、事务边界、兼容性、安全性、可观测性）逐项填写有发现的维度，无发现的跳过。

## Wiki Entries Loaded

| Entry | File | Why Loaded | Used For |
|---|---|---|---|
| | | | |

## Progressive Load Proof

- Query command：
- Query summary：
- category/min-score：
- load_plan：
- None matched：

## Rework Items

- [ ] CR-001：具体到文件、函数、行为的返修项

## 建议优化项

## Rework Verification

rework_count > 0 时必填。逐项对照上次 CR 的 Rework Items，验证每项修复结果。

| CR Item | 上次要求 | 本次验证结果 | 证据 |
|---------|---------|-------------|------|
| CR-001 | <上次返修要求> | fixed / not_fixed / partially_fixed | <文件:行号或说明> |

## Final Recommendation
