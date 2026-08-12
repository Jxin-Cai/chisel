# Requirement Clarification 模板

本模板用于 `clarify:requirement` 阶段产出：

- `{IDEA_DIR}/requirement-clarification.json`：权威机器可读记录，供 Planner 和后续 gate 使用。
- `{IDEA_DIR}/requirement-clarification.md`：人类可读镜像，便于用户审阅。

本文件是澄清审计记录，不是下游需求语义源。下游只以用户确认后的 `requirement.md` 为权威需求。
维度按相关性填写；不适用项可以记录为 `not_applicable` 及理由，不需要为满足固定数量而向用户提问。

---

## requirement-clarification.json

```json
{
  "schema_version": 2,
  "source_step": "clarify:requirement",
  "clarified_at": "2026-05-19T00:00:00.000Z",
  "requirement_ref": "requirement.md",
  "original_requirement_ref": "requirement-original.md",
  "input_ledger_ref": "requirement-inputs.json",
  "as_is_ref": "as-is/overview.md",
  "dimensions": {
    "functional_scope": {
      "in_scope": ["<明确要实现的功能>"],
      "out_of_scope": ["<明确排除的功能>"],
      "user_notes": "<用户原话或补充>"
    },
    "impact_analysis": {
      "affected_systems": ["<受影响的系统/模块>"],
      "confirmed_impacts": ["<已确认的影响>"],
      "user_notes": "<用户原话>"
    },
    "compatibility_constraints": {
      "must_preserve": ["<必须保留的行为/接口>"],
      "can_break": ["<允许破坏的旧行为>"],
      "user_notes": "<用户原话>"
    },
    "non_functional": {
      "performance": "<要求或无特殊要求>",
      "concurrency": "<要求或无特殊要求>",
      "security": "<要求或无特殊要求>",
      "observability": "<要求或无特殊要求>",
      "user_notes": "<用户原话>"
    },
    "priority": {
      "p0": ["<必须实现>"],
      "p1": ["<应该实现>"],
      "p2": ["<可以推迟>"],
      "user_notes": "<用户原话>"
    },
    "acceptance_criteria": [
      {
        "id": "AC-001",
        "description": "<可验证的行为描述>",
        "verification_method": "<如何验证>",
        "verification_conditions": [
          { "id": "VC-001", "condition": "<子验证条件，可选>" }
        ]
      }
    ],
    "risk_tolerance": {
      "level": "conservative | moderate | aggressive",
      "notes": "<用户说明>"
    }
  },
  "unresolved": [],
  "planner_hints": ["<给 planner 的特别提示>"],
  "readiness": {
    "status": "ready",
    "checked_dimensions": ["goal", "scope", "behavior", "edge_cases", "compatibility", "non_functional", "acceptance"],
    "assumptions_confirmed": ["<已由用户通过最终 MD 确认的低风险假设>"],
    "remaining_questions": []
  },
  "canonical_requirement_ref": "requirement.md"
}
```

---

## requirement-clarification.md

```markdown
# 需求澄清记录

## 功能范围

### IN Scope
- <功能 1>

### OUT of Scope
- <排除的功能>

### 用户说明
<原话>

## 影响分析

| 受影响系统 | 影响内容 | 用户确认 |
|-----------|---------|---------|
| <系统>    | <影响>   | 是/否    |

## 兼容性约束

### 必须保留
- <行为/接口>

### 允许破坏
- <旧行为>

## 非功能需求

| 维度 | 要求 |
|------|------|
| 性能 | <要求或无> |
| 并发 | <要求或无> |
| 安全 | <要求或无> |
| 可观测性 | <要求或无> |

## 优先级

| 级别 | 内容 |
|------|------|
| P0（必须） | <功能> |
| P1（应该） | <功能> |
| P2（可推迟） | <功能> |

## 验收标准

| ID | 描述 | 验证方法 |
|----|------|---------|
| AC-001 | <行为描述> | <验证方式> |

## 风险容忍度

等级：conservative / moderate / aggressive

说明：<用户说明>

## 未决项

- <仍无法确定的事项>

## Planner 提示

- <给方案设计的特别提示>
```
