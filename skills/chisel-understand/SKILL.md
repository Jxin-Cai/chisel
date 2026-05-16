---
name: chisel-understand
description: 只读理解遗留系统当前 as-is 逻辑，生成中文业务语义入口、调用链、核心逻辑、数据流、ER 图、接口契约、测试现状、知识候选和证据索引。当 chisel 编排器进入 understand:explore 阶段时触发。
argument-hint: "<idea-name>"
---

# chisel-understand

理解阶段。只产出 as-is，不做方案，不改业务代码。

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
</HARD-GATE>
