# 上下文裁剪指南

当 `resume_step` = `understand:generate-ai-input` 时加载本文件。

## 目的

从人类版 as-is 文档裁剪无关内容，降低 planner 阶段噪音。只保留设计方案所需的结构化数据。

## 流程

**转换原则**：从人类版提取数据时，去掉所有叙事文本、解释段落、Mermaid 图。只保留结构化表格行和证据引用。如果人类版用段落描述了一个事实，在 AI 版中只保留一行 `[F-xxx] 事实描述 | 证据: file:line`。

1. Read `${CLAUDE_PLUGIN_ROOT}/skills/chisel-help/references/ai-input-template.md`
2. 基于 `{IDEA_DIR}/as-is/` 下已确认的人类学习版，按转换原则提取结构化信息
3. 在 `{IDEA_DIR}/as-is/ai-input/` 下生成 6 个文件：

| 文件 | 数据来源 |
|------|---------|
| `facts.md` | overview 核心事实 + core-walkthrough 已确认事实 + as-is/evidence-ledger.json 中的 `F-xxx` |
| `call-graph.md` | core-walkthrough 时序图 → 结构化调用关系表 + coverage-matrix.json 的 `ui_entries`（如有）→ 前端→API 映射表 |
| `data-schema.md` | details/data-model 或 core-walkthrough 内联数据部分 |
| `api-surface.md` | details/api-contracts 或 core-walkthrough 内联接口部分 |
| `constraints.md` | overview 禁区/包袱/坏味道 + clarifications.json + confirmations/as-is.json |
| `change-surface.md` | core-walkthrough safe-to-change area + as-is/coverage-matrix.json |
| `field-flow.md`（可选） | coverage-matrix.json 的 `field_traces`（仅当该维度存在时生成） |

4. 运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/gate-check.mjs {IDEA_DIR} ai-input-ready` 验证
