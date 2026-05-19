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

<HARD-GATE>
explorer 必须产出四个主干 as-is 文件（overview、core-walkthrough、evidence-index、knowledge-candidates）。
枝干文件（details/）由 explorer 根据需求复杂度按需产出。
如果 explorer 返回的主干产物不完整，重新启动补充，不要自行补写。

合理化预防表：

| 你的想法 | 现实 |
|---------|------|
| "这个模块我已经理解了" | 理解必须体现在文档中，不是记忆中 |
| "只改一个文件，不需要全局理解" | 变更影响面可能超出预期 |
| "代码注释已经很清楚了" | 注释可能过时，以运行行为为准 |
</HARD-GATE>
