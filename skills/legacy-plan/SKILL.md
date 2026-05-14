---
name: legacy-plan
description: 基于已确认的 as-is 文档和用户澄清，为遗留系统新增功能生成 to-be 实现方案。当 legacy 编排器进入 plan:design 阶段时触发。
argument-hint: "<idea-name>"
---

# legacy-plan

计划阶段。只写 to-be 方案，不改业务代码。

## 执行

启动 `agent-legacy-planner`，传入 TASK：

```json
{
  "idea_dir": ".legacy-feature/<idea-name>"
}
```

<HARD-GATE>
planner 必须产出 to-be/implementation-plan.md。
方案中必须包含 task 拆分建议。
不要创建 `.to-be-confirmed`。
</HARD-GATE>
