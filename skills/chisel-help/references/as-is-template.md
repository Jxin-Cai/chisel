# As-Is 产物模板（人类学习版）

聚焦需求范围的逻辑走查。需求驱动裁剪，图先行，已确认事实标 `[已确认]`，推断标 `[推断]`。

---

## 文件结构

### 主干文件（必须产出，gate 强校验）

| 文件 | 定位 |
|------|------|
| `as-is/overview.md` | 需求相关的系统全景：3分钟摘要、读者导航、做什么、核心链路、关键数据、风险地图、误解点、禁区/包袱/不确定点、用户确认清单 |
| `as-is/core-walkthrough.md` | 需求涉及的核心调用链 + 关键分支走查，一个文件讲透主路径 |
| `as-is/evidence-index.md` | 所有结论的证据路径索引 |
| `as-is/evidence-ledger.json` | `F-xxx` 事实证据账本，供 gate 和 ai-input 反查 |
| `as-is/coverage-matrix.json` | 入口、链路、数据、副作用的结构化覆盖矩阵，供 gate 判断 as-is 是否覆盖关键影响面 |
| `as-is/knowledge-candidates.md` | 本次发现的禁区/包袱/坏味道/术语候选 |

### 枝干文件（按需产出，主干引用时才创建）

| 文件 | 何时产出 |
|------|---------|
| `as-is/details/entrypoints.md` | 入口数量 > 2 或入口逻辑复杂时 |
| `as-is/details/data-model.md` | 涉及 > 3 张表或数据关系复杂时 |
| `as-is/details/api-contracts.md` | 涉及外部接口契约变更时 |
| `as-is/details/data-flow.md` | 数据流转路径复杂、涉及多系统交互时 |
| `as-is/details/tests.md` | 已有测试需要评估或回归风险高时 |

---

## overview.md

以 Mermaid graph 开头，展示需求涉及的模块关系。

### 3分钟摘要

- 一句话目标：
- 当前主链路：
- 本次最可能改动的点：
- 最大风险：

### 读者导航

| 如果你想了解 | 先看 | 再看 |
|---|---|---|
| | | |

### 需求摘要

### 系统全景

### 当前能力边界

### 核心事实

### 风险地图

| 风险 | 影响区域 | 证据 | 缓解建议 |
|---|---|---|---|
| | | | |

### 常见误解点

| 容易误解为 | 实际情况 | 证据/置信度 |
|---|---|---|
| | | |

### 禁区 / 包袱 / 暂不重构

### 不确定点

### 用户确认清单

- [ ] C-001 需确认事实：
- [ ] C-002 需业务决策：

### 待澄清问题

### 阅读充分性声明

<根据实际覆盖范围填写，说明本文档已覆盖哪些维度、是否有已知局限>

---

## core-walkthrough.md

以 Mermaid sequenceDiagram 开头，中文业务语义。

必须包含：核心时序图（Mermaid）、核心流程图（Mermaid flowchart）、状态变化、异常路径、safe-to-change area。复杂细节用 `→ 详见 details/xxx.md` 引出。

---

## 枝干文件模板

| 文件 | 内容 |
|------|------|
| `details/entrypoints.md` | 每个入口：类型、位置、参数、鉴权、下游调用目标、证据 |
| `details/data-model.md` | ER 图 + 表结构、字段清单、表间关系、关联证据 |
| `details/api-contracts.md` | 接口清单 + 请求/响应 JSON 示例 + 错误码/鉴权/幂等性 |
| `details/data-flow.md` | 数据流转路径：从哪来、到哪去、中间变换 |
| `details/tests.md` | 已有测试、可复用验证命令、缺失测试、回归风险 |

---

## evidence-index.md

| 结论 | 证据位置 | 类型 |
|------|---------|------|
| [F-001] 订单创建走 OrderService | src/service/order.ts:42 | 已确认 |

## evidence-ledger.json

```json
{
  "facts": [
    {
      "id": "F-001",
      "claim": "订单创建走 OrderService",
      "status": "confirmed",
      "evidence": [
        { "file": "src/service/order.ts", "line_start": 42, "line_end": 60, "kind": "code" }
      ]
    }
  ]
}
```

---

## coverage-matrix.json

```json
{
  "schema_version": 1,
  "entrypoints": [
    {
      "id": "E-001",
      "type": "http|rpc|message|job|cli|ui|other",
      "name": "POST /orders",
      "location": { "file": "src/controller/order.ts", "line_start": 42, "line_end": 60 },
      "covered_by_facts": ["F-001"]
    }
  ],
  "links": [
    {
      "id": "L-001",
      "from": "OrderController.create",
      "to": "OrderService.create",
      "kind": "sync-call",
      "depth": "happy_path_only | error_paths_included | all_branches",
      "evidence": [{ "file": "src/controller/order.ts", "line_start": 52 }],
      "covered_by_facts": ["F-002"]
    }
  ],
  "data": [
    {
      "id": "D-001",
      "entity": "orders",
      "operation": "write",
      "fields": ["id", "status"],
      "evidence": [{ "file": "src/repository/order.ts", "line_start": 88 }]
    }
  ],
  "side_effects": [
    {
      "id": "S-001",
      "kind": "db_write|external_call|event|cache|file|auth|none",
      "description": "写入 orders 表",
      "evidence": [{ "file": "src/repository/order.ts", "line_start": 88 }]
    }
  ],
  "not_applicable": {
    "data": "",
    "side_effects": ""
  }
}
```

要求：`entrypoints`、`links`、`data`、`side_effects` 四个维度必须存在；每个维度要么有覆盖项，要么在 `not_applicable` 写明不涉及原因。每个覆盖项必须有 `file + line_start` 证据；`covered_by_facts` 只能引用 evidence-ledger 中已有的 `F-xxx`。

---

## knowledge-candidates.md

本次发现的禁区/包袱/坏味道/术语候选（人类可读摘要）。JSON 候选写入 `knowledge-candidates/` 目录，格式见 `knowledge-candidates-template.md`。
