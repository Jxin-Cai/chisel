---
name: chisel-plan
description: 当 chisel 编排器进入 plan:strategy 或 plan:decompose 阶段时触发。
argument-hint: "<idea-name> [mode=strategy|decompose]"
---

# chisel-plan

计划阶段。只写 to-be 方案，不改业务代码。

## 当前工作流状态

!`node ${CLAUDE_PLUGIN_ROOT}/hooks/workflow-snapshot.mjs 2>/dev/null || echo "无活跃工作流"`

## 参数

- `idea-name`：需求名称（必需）
- `mode`：运行模式（必需），取值：
  - `strategy` — 产出实现策略（设计方向、修改范围、关键决策）
  - `decompose` — 基于已确认策略，产出 task 拆分和可追溯矩阵

## 执行

### mode=strategy

启动 `agent-chisel-planner`，传入 TASK：

```json
{
  "idea_dir": ".chisel/<idea-name>",
  "mode": "strategy"
}
```

<HARD-GATE>
strategy 模式必须产出 `to-be/implementation-plan.md`，内容聚焦实现策略：设计方向、关键技术决策、允许/禁止修改范围、风险评估。
不要包含 task 拆分细节（task 拆分在 decompose 模式中完成）。
不要创建 `confirmations/strategy.json`；策略确认凭据只能由主编排器在用户明确确认后写入。
</HARD-GATE>

### mode=decompose

启动 `agent-chisel-planner`，传入 TASK：

```json
{
  "idea_dir": ".chisel/<idea-name>",
  "mode": "decompose"
}
```

<HARD-GATE>
decompose 模式基于已确认的 `to-be/implementation-plan.md` 和 `confirmations/strategy.json`，产出：
- `to-be/tasks.json` — task 拆分结果
- `to-be/traceability-matrix.json` — 需求到 task 的可追溯矩阵

方案中必须包含 task 拆分建议。
不要创建 `.to-be-confirmed`，也不要创建 `confirmations/to-be.json`；to-be 确认凭据只能由主编排器在用户明确确认后写入。

合理化预防表：

| 你的想法 | 现实 |
|---------|------|
| "方案很明显，不需要多选项" | 至少考虑一个替代方案 |
| "task 拆分太细浪费时间" | 粗粒度 task 导致 CR 困难和返修 |
| "先写代码再补方案" | 没有方案的代码无法 CR |
</HARD-GATE>
