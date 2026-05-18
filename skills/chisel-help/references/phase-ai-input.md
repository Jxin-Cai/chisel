# AI 输入版生成指南

当 `resume_step` = `understand:generate-ai-input` 时加载本文件。

## 流程

1. Read `${CLAUDE_PLUGIN_ROOT}/skills/chisel-help/references/ai-input-template.md`
2. 基于 `{IDEA_DIR}/as-is/` 下已确认的人类学习版，提取结构化信息
3. 在 `{IDEA_DIR}/as-is/ai-input/` 下生成 6 个文件：

| 文件 | 数据来源 |
|------|---------|
| `facts.md` | overview 核心事实 + core-walkthrough 已确认事实 + as-is/evidence-ledger.json 中的 `F-xxx` |
| `call-graph.md` | core-walkthrough 时序图 → 结构化调用关系表 |
| `data-schema.md` | details/data-model 或 core-walkthrough 内联数据部分 |
| `api-surface.md` | details/api-contracts 或 core-walkthrough 内联接口部分 |
| `constraints.md` | overview 禁区/包袱/坏味道 + clarifications.json + confirmations/as-is.json |
| `change-surface.md` | core-walkthrough safe-to-change area + as-is/coverage-matrix.json |

4. `facts.md`、`constraints.md`、`change-surface.md` 必须写 `## Source Coverage`，逐项说明覆盖了哪些 `F-xxx/C-xxx/E-xxx/L-xxx/D-xxx/S-xxx` 或遗漏原因；来源允许为 `as-is/evidence-ledger.json`、`as-is/coverage-matrix.json`、`clarifications.json`、`confirmations/as-is.json`
5. 运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/gate-check.mjs {IDEA_DIR} ai-input-ready` 验证
