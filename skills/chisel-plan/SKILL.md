---
name: chisel-plan
description: 基于已确认的 as-is 文档和用户澄清，为遗留系统新增功能生成 to-be 实现方案。支持 strategy（策略设计）和 decompose（任务拆分）两种模式。当 chisel 编排器进入 plan:strategy 或 plan:decompose 阶段时触发。
argument-hint: "<idea-name> [mode=strategy|decompose]"
---

# chisel-plan

计划阶段。只写 to-be 方案，不改业务代码。

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
</HARD-GATE>
