# To-Be 实现方案模板

确认目标行为、边界、验证和回滚。不夹带未经确认的大重构。

## 目标行为

## 非目标行为

## 方案总览

## 允许修改范围

| 范围 | 原因 | 备注 |
|---|---|---|
| | | |

## 禁止修改范围

| 范围 | 原因 | 触碰条件 |
|---|---|---|
| | | |

## 需要保留的历史行为

## Context to Load

- as-is：
- wiki：
- module map：
- ADR：
- tests：

## 方案详情

按需填写以下维度（有涉及则展开，无涉及则跳过）：接口层改动、业务逻辑改动、持久化/数据模型改动、API 契约变更、数据迁移或兼容方案、并发安全与幂等性、事务边界与数据一致性、错误处理。

## 测试策略

## Verification Surface

## 回滚方案

## 风险清单

| 风险 | 等级 | 缓解方式 |
|---|---|---|
| | low / medium / high | |

## 知识候选处理策略

## Task 拆分建议

同时写入 `to-be/traceability-matrix.json`：

```json
{
  "items": [
    {
      "id": "REQ-001",
      "type": "goal",
      "source": "requirement.md",
      "description": "用户创建时拒绝空名称",
      "covered_by_tasks": ["task-001"],
      "verification": ["node --test tests/user.test.mjs"]
    }
  ]
}
```

同时写入 `to-be/tasks.json`（task-init.mjs 做 schema 校验）：

```json
{
  "tasks": [
    {
      "task_id": "task-001",
      "depends_on": [],
      "title": "实现某个业务能力",
      "goal": "本 task 完成的目标行为",
      "allowed_files": ["src/a.ts"],
      "forbidden_files": [],
      "expected_files": ["src/a.ts"],
      "trace_refs": ["REQ-001"],
      "acceptance_criteria": ["满足某个可验证行为"],
      "verification": ["npm test"],
      "risk_level": "low",
      "rollback": "回退本 task 修改的文件"
    }
  ]
}
```

可选字段：`allowed_symbols`、`forbidden_symbols`、`behavior_invariants`、`impact_surface`、`context_to_load`、`exports`、`imports`、`modification_hints`、`verification_expected_output`。

- `exports`：本 task 产出的、可被其他 task 引用的符号或文件（如新增的函数、类型、配置）。
- `imports`：本 task 依赖的、由其他 task 产出的符号或文件（引用 `exports` 的 task_id）。
- `modification_hints`：string[] — 给 coder 的修改提示（如"在 X 函数后添加 Y 调用"），降低上手成本。
- `verification_expected_output`：string — 预期验证输出描述（如"运行 npm test 应看到 all tests passed"），帮助 coder 判断验证是否通过。
- `task_complexity`："trivial" | "standard" | "complex"（可选，默认 "standard"）— 决定 coder agent 模型选择：trivial→haiku, standard→sonnet, complex→opus。
