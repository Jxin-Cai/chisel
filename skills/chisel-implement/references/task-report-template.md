---
task_id: task-001-example
status: coded
loc_added: 0
loc_deleted: 0
expected_files: []
changed_files: []
file_report_schema_version: 1
scope_check_schema_version: 3
scope_check_result: pass
invariant_check_result: pass
completion_status: DONE
concerns: ""
---

# Legacy Task Report: task-001-example

> 仅用于读取历史运行目录。新任务由 `task-metrics.mjs` 从 Git diff/provenance 自动生成 schema v4 inventory；Coder 不读取或填写本模板。

## 做了什么

## 改了什么

| 文件 | 修改点 | 是否在 expected_files 内 |
|---|---|---|
| | | |

## File-Level Implementation Report

| File | Planned | Change Type | CP Refs | Trace Refs | Summary | Evidence | Status |
|---|---|---|---|---|---|---|---|
| src/a.ts | yes | modify | CP-1 | REQ-001 | 增加 X 场景处理 | src/a.ts:123 / 验证命令 | done |

必须覆盖 task `File-Level Plan` 中 `Report Required=true` 的每个文件，并覆盖 scope-check JSON `changed_files[]` 中的每个文件。
- `Planned` 只能是 `yes` 或 `no`。
- `Status` 只能是 `done`、`not_changed`、`extra`、`blocked`。
- `Evidence` 必须填写实际文件行号、验证命令或行为说明，不得为空、占位、`TODO/TBD/无/-`。
- 计划外文件必须标记 `Planned=no`，并在 `Summary` 说明为什么必要。

## 代码量

- 新增行数：
- 删除行数：
- 修改文件数：

## Acceptance Criteria Result

- [x] <AC> — Evidence: <文件:行号 / 验证命令 / 行为说明>

## Requirement Unit Tests

| Test File | Test Name | Trace Ref | RED Evidence | GREEN Evidence | Result |
|---|---|---|---|---|---|
| tests/example.test.ts | rejects empty input | AC-001/VC-001 | `<命令 + 预期失败原因>` | `<命令 + PASS>` | pass / fail |

每个新增或改变的行为至少一行。RED Evidence 必须证明测试曾因目标行为缺失而失败，不能填写语法错误、环境错误或占位内容。

## Traceability Evidence

| Trace Ref | Evidence | Result |
|---|---|---|
| REQ-001 | <文件:行号 / 验证命令 / 行为说明> | pass / fail |

必须覆盖 task frontmatter 中的每个 `trace_refs`；Evidence 不得为空或占位。

## 风格对齐

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

## Scope Control

### Scope Check Proof

- Command：`node ${CLAUDE_PLUGIN_ROOT}/scripts/scope-check.mjs {idea_dir} {task_id}`
- Result：pass | fail
- schema_version：3
- changed_files_count：
- violations_count：
- forbidden_symbol_hits_count：

#### Scope Check JSON Summary

粘贴 scope-check.mjs 的完整 JSON 输出。新契约报告必须包含可解析 JSON，至少包含：`schema_version`、`changed_files`、`hit_proofs`、`violations`、`summary.changed_files_count`、`summary.violations_count`、`pass`。

#### Hit Proofs Summary

| File | Expected proof | Forbidden proof | Symbol proof | Status |
|---|---|---|---|---|
| | | | | |

#### Invariant Proofs

| Invariant | Proof | Result |
|---|---|---|
| | | pass / fail |

必须逐项覆盖 task `Behavior Invariants`；`Proof` 必须填写实际验证证据，不得为空或占位；`Result` 只能是 `pass` 或 `fail`。

## Rework Resolution Matrix

| CR ID | 修改文件 | 处理方式 | 验证结果 |
|---|---|---|---|
| | | | |

## Knowledge Candidates

- Forbidden zones：
- Weirdness：
- Smells：
- Terms：

## 风险与后续

## Completion Status

status: DONE | DONE_WITH_CONCERNS | NEEDS_CONTEXT | BLOCKED
concerns: <仅 DONE_WITH_CONCERNS 时填写——对实现有疑虑但已完成>
missing_context: <仅 NEEDS_CONTEXT 时填写——缺少哪些信息无法继续>
blocker: <仅 BLOCKED 时填写——无法完成的原因>
