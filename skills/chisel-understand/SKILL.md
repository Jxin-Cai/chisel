---
name: chisel-understand
description: 当 chisel 编排器进入 understand:explore 阶段时触发。
argument-hint: "<idea-name>"
---

# chisel-understand

理解阶段。只产出 as-is，不做方案，不改业务代码。

## 当前工作流状态

!`node ${CLAUDE_PLUGIN_ROOT}/hooks/workflow-snapshot.mjs 2>/dev/null || echo "无活跃工作流"`

## 执行

启动 `agent-chisel-explorer`，传入 TASK：

```json
{
  "idea_dir": ".chisel/<idea-name>",
  "requirement_path": ".chisel/<idea-name>/requirement.md"
}
```

### 重试（产物不完整时）

如果 orchestration-status 返回 `resume_step: understand:explore` 且 `phase_detail` 中包含 `gate_reason`，说明 explorer 上一次产出不完整。重新启动 explorer 时在 TASK 中附加 `gate_reason` 字段：

```json
{
  "idea_dir": ".chisel/<idea-name>",
  "requirement_path": ".chisel/<idea-name>/requirement.md",
  "gate_reason": "<gate-check 返回的具体失败原因>"
}
```

explorer 收到 `gate_reason` 后只需补充缺失部分，不需要从头重新探索。

<HARD-GATE>
explorer 必须产出以下主干 as-is 文件（repo-map.json 和 quality-score.json 由脚本生成，其余 7 个由 explorer 写入）：

| 文件 | 来源 |
|------|------|
| `as-is/repo-map.json` | Phase 0 脚本生成 |
| `as-is/overview.md` | explorer 写入 |
| `as-is/core-walkthrough.md` | explorer 写入 |
| `as-is/evidence-index.md` | explorer 写入 |
| `as-is/evidence-ledger.json` | explorer 写入 |
| `as-is/coverage-matrix.json` | explorer 写入 |
| `as-is/knowledge-candidates.md` | explorer 写入 |
| `as-is/context-budget.md` | explorer 写入 |
| `as-is/quality-score.json` | Phase 结束脚本生成 |

枝干文件（details/）由 explorer 根据 coverage-matrix 触发条件按需产出。

如果 explorer 返回的主干产物不完整，先运行 gate-check 获取具体失败原因：
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/gate-check.mjs .chisel/<idea-name> as-is-complete
```
将 gate-check 输出的 `reason` 作为 `gate_reason` 传入 explorer 的 TASK，重新启动补充缺失文件，不要自行补写。

合理化预防表：

| 你的想法 | 现实 |
|---------|------|
| "这个模块我已经理解了" | 理解必须体现在文档中，不是记忆中 |
| "只改一个文件，不需要全局理解" | 变更影响面可能超出预期 |
| "代码注释已经很清楚了" | 注释可能过时，以运行行为为准 |
</HARD-GATE>
