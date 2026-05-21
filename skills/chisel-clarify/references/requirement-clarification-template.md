# Requirement Clarification 模板

本模板用于 `clarify:requirement` 阶段产出：

- `{IDEA_DIR}/requirement-clarification.json`：权威机器可读记录，供 Planner 和后续 gate 使用。
- `{IDEA_DIR}/requirement-clarification.md`：人类可读镜像，便于用户审阅。

**复杂度裁剪**：trivial 需求只需覆盖 `functional_scope` + `acceptance_criteria` 两个维度，其余维度可省略。standard/complex 需求仍需覆盖全部 7 维度。

---

## requirement-clarification.json

```json
{
  "schema_version": 1,
  "source_step": "clarify:requirement",
  "clarified_at": "2026-05-19T00:00:00.000Z",
  "requirement_ref": "requirement.md",
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
        "verification_method": "<如何验证>"
      }
    ],
    "risk_tolerance": {
      "level": "conservative | moderate | aggressive",
      "notes": "<用户说明>"
    }
  },
  "unresolved": [],
  "planner_hints": ["<给 planner 的特别提示>"]
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
