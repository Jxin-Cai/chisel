---
name: chisel-plan
description: 当 chisel 编排器进入 plan:design 阶段时触发。
argument-hint: "<idea-name>"
---

# chisel-plan

计划阶段。一次性产出策略和任务拆分，不改业务代码。

## 当前工作流状态

!`node ${CLAUDE_PLUGIN_ROOT}/hooks/workflow-snapshot.mjs 2>/dev/null || echo "无活跃工作流"`

## 参数

- `idea-name`：需求名称（必需）

## 执行

启动 `agent-chisel-planner`，传入 TASK：

```json
{
  "idea_dir": ".chisel/<idea-name>"
}
```

<HARD-GATE>
一次性产出完整方案，包含：
- `to-be/implementation-plan.md` — 实现策略 + Task 拆分建议
- `to-be/tasks.json` — task 拆分结果
- `to-be/traceability-matrix.json` — 需求到 task 的可追溯矩阵

不要创建 `confirmations/strategy.json`。
不要创建 `confirmations/to-be.json`；to-be 确认凭据只能由主编排器在用户明确确认后写入。

合理化预防表：

| 你的想法 | 现实 |
|---------|------|
| "方案很明显，不需要多选项" | 至少考虑一个替代方案 |
| "task 拆分太细浪费时间" | 粗粒度 task 导致 CR 困难和返修 |
| "先写代码再补方案" | 没有方案的代码无法 CR |
| "有几个设计点不确定，先提出来问用户" | 必须在本次调用写完全部产物，不确定点写入风险清单 |
</HARD-GATE>
