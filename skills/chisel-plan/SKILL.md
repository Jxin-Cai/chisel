---
name: chisel-plan
description: 基于已确认的 as-is 文档和用户澄清，为遗留系统新增功能生成 to-be 实现方案。当 chisel 编排器进入 plan:design 阶段时触发。
argument-hint: "<idea-name>"
---

# chisel-plan

计划阶段。只写 to-be 方案，不改业务代码。

## 执行

启动 `agent-chisel-planner`，传入 TASK：

```json
{
  "idea_dir": ".chisel/<idea-name>"
}
```

<HARD-GATE>
planner 必须产出 to-be/implementation-plan.md。
方案中必须包含 task 拆分建议。
不要创建 `.to-be-confirmed`，也不要创建 `confirmations/to-be.json`；to-be 确认凭据只能由主编排器在用户明确确认后写入。
</HARD-GATE>
