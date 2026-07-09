# Writer As-Is 模式 TASK 模板

当主编排器完成 Phase 2（深度走查 + 结构化产物写入）后，启动 `agent-chisel-writer` 时传入以下 TASK 结构。

## TASK JSON

```json
{
  "idea_dir": ".chisel/<idea-name>",
  "mode": "as-is",
  "source_files": [
    "as-is/repo-map.json",
    "as-is/evidence-ledger.json",
    "as-is/coverage-matrix.json",
    "as-is/context-budget.json",
    "as-is/ai-input/facts.md",
    "as-is/ai-input/call-graph.md",
    "as-is/ai-input/data-schema.md",
    "as-is/ai-input/api-surface.md",
    "as-is/ai-input/constraints.md",
    "as-is/ai-input/change-surface.md"
  ],
  "optional_sources": [
    "as-is/ai-input/field-flow.md",
    "as-is/debt-signals/"
  ],
  "requirement_path": ".chisel/<idea-name>/requirement.md"
}
```

## 期望产出

Writer 必须在 `{idea_dir}/as-is/` 下产出以下文件：

### 必产出

| 文件 | 数据来源 | 关键内容 |
|------|---------|---------|
| `overview.md` | facts.md + constraints.md + coverage-matrix | 3 分钟摘要 + 系统全景 Mermaid graph + 风险地图 + 误解点 + 确认清单 |
| `core-walkthrough.md` | call-graph.md + facts.md | 核心链路 Mermaid sequenceDiagram + 分支走查叙事 |
| `evidence-index.md` | evidence-ledger.json | 按文件分组的证据路径索引 |
| `context-budget.md` | context-budget.json | 已读文件清单 + 覆盖度自评表格 |
| `knowledge-candidates.md` | constraints.md + 探索中发现的信号 | 禁区/包袱/术语候选清单 |

### 条件产出（基于 coverage-matrix.json 判断）

| 文件 | 触发条件 |
|------|----------|
| `details/entrypoints.md` | `entrypoints.length > 2` |
| `details/data-model.md` | `data.length > 3` |
| `details/api-contracts.md` | `side_effects` 中有 `type == "external_call"` |
| `details/data-flow.md` | `links.length > 5` 或有 `type == "async"` |

## 重试模式

如果 TASK 中包含 `retry_reason`，说明 Writer 上次产出不完整。此时只补充缺失文件，不重写已有文件。
