# Requirement-Level CR 模板

本模板用于需求级 CR 产物：`{idea_dir}/cr/requirement-cr.md`

---

```yaml
---
review_level: requirement
result: approved | needs_rework | blocked
affected_tasks: [task-001, task-002]
rework_count: 0
---
```

```markdown
# Requirement-Level CR: {idea-name}

## 结论

<一句话结论：approved / needs_rework / blocked>

<简要说明理由>

## 需求覆盖度

对照 `requirement-clarification.json` 的 `acceptance_criteria`：

| AC ID | 描述 | 覆盖 Task | 验证结果 | 证据 |
|-------|------|-----------|---------|------|
| AC-001 | <描述> | task-001 | PASS/FAIL | <文件:行号> |

## 跨 Task 一致性

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 代码风格一致性 | PASS/FAIL | <说明> |
| 命名规范一致性 | PASS/FAIL | <说明> |
| 错误处理一致性 | PASS/FAIL | <说明> |
| 接口契约一致性 | PASS/FAIL | <说明> |

## 各 Task 审查摘要

### task-001

| 维度 | 结果 | 说明 |
|------|------|------|
| 功能完整度 | PASS/FAIL | <说明> |
| Scope Control | PASS/FAIL | <说明> |
| 健壮性 | PASS/FAIL | <说明> |
| 并发安全 | N/A/PASS/FAIL | <说明> |
| 事务边界 | N/A/PASS/FAIL | <说明> |
| 幂等性 | N/A/PASS/FAIL | <说明> |
| 向后兼容 | PASS/FAIL | <说明> |
| 安全性 | PASS/FAIL | <说明> |
| 可观测性 | PASS/FAIL | <说明> |
| 风格一致性 | PASS/FAIL | <说明> |

### task-002
（同上结构）

## Scope Control

### Scope Check Proof

- Command: `node ${CLAUDE_PLUGIN_ROOT}/scripts/scope-check.mjs {idea_dir} <task-id>`
- Result: pass/fail
- schema_version: 3
- changed_files_count: <N>
- violations_count: <N>
- forbidden_symbol_hits_count: <N>

<Scope Check JSON Summary>

#### Hit Proofs Reviewed

| File | Expected proof | Forbidden proof | Symbol proof | Status |
|------|---------------|-----------------|-------------|--------|

#### Invariant Proofs

| Invariant | Proof | Result |
|-----------|-------|--------|

## Wiki Entries Loaded

| Entry | File | Why Loaded | Used For |
|-------|------|-----------|----------|

## Progressive Load Proof

- Query command: <command>
- Query summary: <summary>
- category/min-score: <values>
- load_plan JSON: <json>

## Rework Items

（仅 needs_rework 时填写）

| ID | affected_task_id | 问题描述 | 修复建议 | 严重度 |
|----|------------------|---------|---------|--------|
| CR-001 | task-001 | <描述> | <建议> | high/medium/low |

## Rework Verification

（仅 rework_count > 0 时填写）

| CR Item | 上次问题 | 修复结果 | 状态 |
|---------|----------|----------|------|
| CR-001  | <问题描述> | <实际修复情况及代码证据> | fixed / not_fixed / partial |
```
