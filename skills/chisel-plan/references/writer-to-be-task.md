# Writer To-Be 模式 TASK 模板

当主编排器完成 Phase 2-3（精化写入 + 自检）后，启动 `agent-chisel-writer` 时传入以下 TASK 结构。

## TASK JSON

```json
{
  "idea_dir": ".chisel/<idea-name>",
  "mode": "to-be",
  "source_files": [
    "to-be/design-notes.json",
    "to-be/tasks.json",
    "to-be/traceability-matrix.json",
    "to-be/impact-risk-report.json"
  ],
  "optional_sources": [
    "to-be/data-change-plan.json",
    "to-be/api-change-plan.json"
  ],
  "context_files": [
    "as-is/ai-input/call-graph.md"
  ]
}
```

## 期望产出

Writer 必须产出 `{idea_dir}/to-be/implementation-plan.md`，严格按 `to-be-template.md` 格式填充以下章节：

| 章节 | 数据来源 |
|------|---------|
| 目标行为 | design-notes.json → goal_behavior |
| 非目标行为 | design-notes.json → non_goal_behavior |
| 方案总览 | design-notes.json → strategy_overview |
| 改造点映射 | impact-risk-report.json → change_points + reuse_nodes + call-graph.md |
| 改造点详情（每个 CP） | design-notes.json → change_point_details[CP-x] |
| 允许修改范围 | design-notes.json → allowed_scope |
| 禁止修改范围 | design-notes.json → forbidden_scope |
| 需要保留的历史行为 | design-notes.json → historical_behaviors |
| Context to Load | design-notes.json → context_to_load |
| 方案详情 | design-notes.json → change_point_details（按维度展开） |
| Verification Surface | design-notes.json → verification_surface |
| 回滚方案 | design-notes.json → rollback_plan |
| 风险清单 | impact-risk-report.json → risk_matrix |
| 知识候选处理策略 | design-notes.json → knowledge_strategy（如有） |
| Task 拆分建议 | tasks.json → 完整 JSON 结构 |
| 变更完整性自检结果 | design-notes.json → self_check |

## 关键规则

1. **改造点映射表必须完整**：对照 call-graph.md 中的所有链路节点，每个节点都要出现在表中（保留/改造/新增/删除）
2. **CP 编号贯穿**：从 impact-risk-report.json 的 change_points[].id 取 CP 编号，保持一致
3. **tasks.json 完整嵌入**：Task 拆分建议章节中的 JSON 示例必须是 tasks.json 的完整内容
4. **自检结果忠实还原**：从 design-notes.json → self_check 的各项结果逐条写入，不虚构
5. **traceability 引用**：在 Task 拆分建议中标注每个 task 对应的 trace_refs

## 重试模式

如果 TASK 中包含 `retry_reason`，Read 已有的 `implementation-plan.md`，根据 retry_reason 补充缺失章节。
