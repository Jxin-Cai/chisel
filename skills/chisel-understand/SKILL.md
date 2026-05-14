---
name: chisel-understand
description: 只读理解遗留系统当前 as-is 逻辑，生成中文业务语义调用链、核心逻辑、ER 图、接口契约、变更点和证据索引。当 chisel 编排器进入 understand:explore 阶段时触发。
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
explorer 必须产出完整的七个 as-is 文件。
如果 explorer 返回的产物不完整，重新启动补充，不要自行补写。
</HARD-GATE>
