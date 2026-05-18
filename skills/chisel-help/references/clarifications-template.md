# Clarifications

本模板用于 `understand:confirm` 阶段产出：

- `{IDEA_DIR}/clarifications.json`：权威机器可读记录，供 gate、Planner 和 traceability 使用。
- `{IDEA_DIR}/clarifications.md`：人类可读镜像，便于用户审阅和历史兼容。
- `{IDEA_DIR}/confirmations/as-is.json`：as-is 阶段确认凭据。

---

## clarifications.json

```json
{
  "schema_version": 1,
  "source_step": "understand:confirm",
  "confirmed_at": "2026-05-18T00:00:00.000Z",
  "summary": "用户确认 AS_IS 理解正确，旧接口响应字段必须保持。",
  "decisions": [
    {
      "id": "C-001",
      "question": "旧接口响应字段是否必须保持？",
      "decision": "必须保持",
      "rationale": "旧客户端依赖当前字段",
      "status": "confirmed",
      "source": "as-is/overview.md#用户确认清单"
    }
  ],
  "answers": [
    {
      "question": "旧接口响应字段是否必须保持？",
      "answer": "必须保持"
    }
  ],
  "unresolved": [],
  "constraints_added": [
    {
      "description": "不得修改旧接口响应字段",
      "evidence": "用户确认 C-001"
    }
  ],
  "knowledge_signals": [
    {
      "category": "forbidden_zone",
      "description": "旧接口响应结构不能改",
      "candidate_file": "knowledge-candidates/fz-001.json"
    }
  ]
}
```

状态说明：
- `confirmed`：用户明确回答。
- `defaulted`：用户接受默认建议。
- `deferred`：推迟到后续阶段决定。

---

## confirmations/as-is.json

```json
{
  "schema_version": 1,
  "phase": "as-is",
  "status": "confirmed",
  "confirmed_at": "2026-05-18T00:00:00.000Z",
  "confirmed_by": "user",
  "source_files": [
    "as-is/overview.md",
    "as-is/core-walkthrough.md",
    "as-is/evidence-index.md",
    "as-is/evidence-ledger.json",
    "as-is/coverage-matrix.json",
    "clarifications.json"
  ],
  "checklist": [
    { "id": "C-001", "status": "confirmed" }
  ]
}
```

---

## clarifications.md

`clarifications.md` 是 `clarifications.json` 的人类可读镜像；新流程 gate 以 `clarifications.json` 为准，旧流程兼容时才读取 `clarifications.md`。

```markdown
# Clarifications

## 确认结论

<一句话总结用户确认结果>

## 逐项决策记录

| ID | 问题 | 用户决策 | 理由 | 状态 |
|---|---|---|---|---|
| C-001 | <问题描述> | <用户决策> | <理由> | confirmed/defaulted/deferred |

## 澄清答案

<用户对待澄清问题的回答>

## 未决项

<仍无法确定的事项，需后续明确>

## 新增约束

<确认过程中发现的新约束条件>

## 知识候选信号

<对话中发现的禁区/包袱/坏味道/术语，已写入 knowledge-candidates/>
```
