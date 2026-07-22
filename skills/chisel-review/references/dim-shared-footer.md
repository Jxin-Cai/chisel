# CR 产物共享格式模板

以下表格格式模板适用于所有维度（D2–D8）的 CR 产物正文。

`[DX]` 表示当前维度编号（如 D2、D3 等），请在实际产物中替换为对应维度。

---

## Scope / Wiki / Invariant Proof

见 `cr/dim-spec-cr.md`（spec 维度已执行全局 Scope Check 和 Wiki 查询，本维度不重复执行）。

N/A 只用于正文检查项；frontmatter `result` 仍只能是 `pass | fail`。`pass` 表示该维度无阻塞问题，不表示所有检查项都适用。

---

## Rework Items

置信度 ≥80 的问题进入此表，触发返修。

| ID | affected_task_id | 问题描述 | 修复建议 | 严重度 | 置信度 |
|----|------------------|---------|---------|--------|--------|
| CR-001 [DX] | task-001 | <描述> | <建议> | high/medium/low | 80-100 |

## Observations (non-blocking)

置信度 60-79 的发现记录于此，供参考但不触发返修。

| ID | affected_task_id | 描述 | 置信度 |
|----|------------------|------|--------|
| OBS-001 [DX] | task-001 | <描述> | 60-79 |

## Rework Verification

（仅 rework_count > 0 时填写）

| CR Item | 上次问题 | 修复结果 | 状态 |
|---------|----------|----------|------|
| CR-001 [DX] | <问题描述> | <实际修复情况及代码证据> | fixed / not_fixed / partial |
