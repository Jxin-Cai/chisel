---
task_id: task-001-example
review_type: spec_compliance
result: pass
---

# Spec Compliance CR: task-001-example

## 结论

pass | fail

结论章节仅供人类阅读；状态机只读取 frontmatter 的 `result` 字段。

## Acceptance Criteria 覆盖

| AC | Task 要求 | Report 证据 | 结果 |
|----|----------|-------------|------|
| AC-1 | ... | ... | pass / fail |

## Expected Files 覆盖

- expected_files：
- changed_files：
- 未覆盖：（无 / 列出缺失文件）
- 结果：pass / fail

## Scope Check

- Command：`node ${CLAUDE_PLUGIN_ROOT}/scripts/scope-check.mjs {idea_dir} {task_id}`
- pass：true / false
- violations：

## Forbidden Files 检查

- 禁区列表：
- 触碰情况：（无 / 列出触碰文件）
- 结果：pass / fail

## 不合规项汇总

result 为 fail 时，列出所有不合规项：

- [ ] SPEC-001：具体不合规描述
