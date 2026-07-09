# design-notes.json Schema

松散结构 + 关键字段必填。由主编排器在 Phase 2 写入，供 Writer 生成 `implementation-plan.md`。

## Schema

```json
{
  "schema_version": 1,
  "generated_at": "ISO timestamp",

  "goal_behavior": "目标行为的一段叙事描述",
  "non_goal_behavior": "非目标行为（本次明确不做的事）",
  "strategy_overview": "方案总览——一段概括性描述",

  "change_point_details": [
    {
      "cp_id": "CP-1",
      "node": "链路节点名（对应 call-graph 中的节点）",
      "decision": "改造 | 新增 | 删除",
      "what": "做什么（一句话）",
      "why": "为什么要改（关联哪个 AC/需求）",
      "current_behavior": "当前行为描述（引用 F-xxx）",
      "target_behavior": "目标行为描述",
      "modification_approach": "修改方式（具体到函数级）",
      "upstream_impact": "影响的上游节点",
      "downstream_impact": "影响的下游节点",
      "invariants": ["不能破坏的现有契约"],
      "corresponding_tasks": ["task-001"],
      "design_rationale": "选择这种方式的原因/权衡过程（自由文本）"
    }
  ],

  "allowed_scope": [
    { "scope": "路径或模块", "reason": "原因", "cp_refs": ["CP-1"] }
  ],
  "forbidden_scope": [
    { "scope": "路径或模块", "reason": "原因", "trigger_condition": "触碰条件" }
  ],

  "historical_behaviors": ["需要保留的历史行为描述"],

  "context_to_load": {
    "as_is": [],
    "wiki": [],
    "module_map": [],
    "adr": []
  },

  "verification_surface": ["验证面描述"],
  "rollback_plan": "回滚方案叙事",
  "knowledge_strategy": "知识候选处理策略（可选）",

  "self_check": {
    "companion_changes": [
      { "cp": "CP-1", "rule": "DB model 字段变更", "companion": "migration", "arranged_in": "task-002", "notes": "" }
    ],
    "spec_coverage": {
      "total_ac": 3,
      "covered": 3,
      "uncovered": []
    },
    "cp_task_consistency": "all_covered | <列出孤立 CP>",
    "file_plan_completeness": [
      { "task": "task-001", "cp_covered": true, "trace_covered": true, "no_forbidden": true, "companion_included": true }
    ],
    "dependency_completeness": "pass | <列出缺失的 export/import>",
    "reverse_detection": [
      { "file": "src/x.ts", "discovered_relation": "caller Y not in call-graph", "action": "追加 CP-N 到 task-M" }
    ]
  }
}
```

## 必填字段

以下字段不能省略（可以为空字符串/空数组，但键必须存在）：

- `schema_version`
- `goal_behavior`
- `non_goal_behavior`
- `strategy_overview`
- `change_point_details`（至少一项）
- `change_point_details[].cp_id`
- `change_point_details[].decision`
- `change_point_details[].what`
- `change_point_details[].current_behavior`
- `change_point_details[].target_behavior`
- `allowed_scope`
- `forbidden_scope`
- `rollback_plan`
- `self_check`
- `self_check.spec_coverage`
- `self_check.cp_task_consistency`

## 自由文本字段

以下字段允许自由格式文本，Writer 会据此生成叙事段落：

- `strategy_overview`
- `change_point_details[].design_rationale`
- `change_point_details[].modification_approach`
- `rollback_plan`
- `knowledge_strategy`
- `self_check.reverse_detection[].action`
