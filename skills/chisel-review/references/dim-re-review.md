# Scoped Re-review：返修增量复审

## 审查目标

验证上轮 Rework Items 是否被正确修复，并检查修复 diff 是否引入新问题。

**不重新全量审查——聚焦修复 diff + 原 findings。**

## 输入

| 来源 | 内容 |
|------|------|
| TASK.dimension | 本次复审的原维度（d2/d3/d4/d5/d6/d7/d8/d9） |
| 上轮 CR 文件 | `{idea_dir}/cr/dim-{dimension}-cr.md` 中的 Rework Items 表 |
| 修复 diff | `git diff {base_ref}...HEAD -- <affected_files>` 或 cr-context.json 的 repair_diff |
| task reports | `{idea_dir}/task-reports/{task_id}-report.md` 中的 Rework Resolution Matrix |

## 检查清单

### 1. 逐项验证修复

对上轮 CR 的 `## Rework Items` 表每一行：

1. 读取 task report 的 `Rework Resolution Matrix` 了解 coder 声明的处理方式
2. 在修复 diff 中定位对应代码变更
3. 判定修复状态：

| 判定 | 含义 |
|------|------|
| ADDRESSED | 问题已正确修复，有代码证据 |
| NOT_ADDRESSED | 问题未修复或修复不正确 |
| PARTIAL | 部分修复，核心问题仍存在 |

- 每个判定必须提供 `file:line` 证据
- **不信任 coder 的自述**——以实际 diff 为准

### 2. 修复 diff 新问题扫描

仅对修复涉及的文件/行范围，按**原维度**的关注点执行精简检查：
- 只报置信度 >= 80 的问题
- 只关注 Critical/Important 严重度
- 不检查修复 diff 之外的代码
- 不检查上轮已 pass 的代码段

### 3. 不做

- 不重新审查全量 diff（那是上轮的工作）
- 不评估整体架构
- 不报告 < 60 置信度的嫌疑
- 不检查其他维度的问题（即使顺手发现了——记入 Observations 即可）

## CR 产物格式

### Frontmatter

```yaml
---
dimension: {dimension}
result: pass | fail
affected_tasks: [task-001]
rework_count: {N}
review_mode: scoped-rework
---
```

### 正文模板

```markdown
# {DIMENSION} Scoped Re-review (Rework Round {N})

## Rework Verification

| CR Item | 上次问题 | 修复结果 | file:line 证据 | 状态 |
|---------|----------|----------|---------------|------|
| CR-001 [{DX}] | <问题描述> | <实际修复情况> | src/foo.ts:42 | ADDRESSED / NOT_ADDRESSED / PARTIAL |

## Verdict Summary

- 总 Rework Items：X
- ADDRESSED：Y
- NOT_ADDRESSED：Z
- PARTIAL：W

## New Issues in Fix Diff

置信度 >= 80 的新问题（仅在修复 diff 范围内发现的）。

| ID | affected_task_id | 问题描述 | 位置 | 严重度 | 置信度 |
|----|------------------|---------|------|--------|--------|
| CR-NEW-001 [{DX}] | task-001 | <描述> | file:line | high/medium | 80-100 |

## Observations (non-blocking)

修复 diff 中发现的其他维度问题或 < 80 置信度的嫌疑，仅供参考。

| ID | 描述 | 置信度 |
|----|------|--------|
| OBS-001 | <描述> | 60-79 |

## 结论

PASS（所有 Rework Items ADDRESSED 且无新 Critical/Important 问题）
| FAIL（存在 NOT_ADDRESSED/PARTIAL 或新发现 >= 80 置信度问题）
```

## result 判定规则

- 所有 Rework Items 状态为 ADDRESSED **且** 无新 >= 80 置信度问题 → `result: pass`
- 存在任一 NOT_ADDRESSED / PARTIAL **或** 有新 >= 80 置信度问题 → `result: fail`
  - fail 时：NOT_ADDRESSED/PARTIAL 项 + 新问题 → 进入下轮 Rework Items

## 不要标记

- 上轮已 pass 的维度中的问题（不在本次复审范围）
- 修复 diff 之外的 pre-existing 问题
- 纯风格偏好（除非原 Rework Item 就是风格问题）
- 与修复无关的改进建议
