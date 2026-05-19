---
task_id: task-001-example
status: confirmed
depends_on: []
description: 描述这个 task 完成的业务能力
expected_files: [] # 仓库相对路径，填本 task 预计修改或必须审查的文件
trace_refs: [] # 对应 to-be/traceability-matrix.json 的条目 ID
allowed_symbols: [] # 本 task 允许触碰的关键函数/类/接口名
forbidden_symbols: [] # 本 task 禁止触碰的关键函数/类/接口名
impact_surface: {"files":[],"symbols":[],"invariants":[],"shared_state":[]} # 并行调度使用的影响面
task_complexity: standard # trivial | standard | complex — 决定 coder agent 模型
---

# Task: task-001-example

## 背景

## 目标行为

## Scope

### Allowed Files / Areas

- 

### Forbidden Files / Areas

- 

### Safe-to-change Assumptions

- 

### Allowed Symbols

- 

### Forbidden Symbols

- 

## Impact Surface

- files：[]
- symbols：[]
- invariants：[]
- shared_state：[]

## Exports

- <本 task 产出的、可被其他 task 引用的符号或文件>

## Imports

- <本 task 依赖的、由其他 task 产出的符号或文件，标注来源 task_id>

## Context to Load

- as-is：
- to-be：
- wiki：
- module map：
- ADR：
- tests：

## 实现要求

## Traceability

- REQ-001

## Behavior Invariants

- [ ] 需要保持的旧行为、接口契约或包袱

## Acceptance Criteria

- [ ] 

## Verification

```bash
# 填写本 task 的验证命令；没有自动化验证时写明人工验证方式
```

## Rollback Point

## Risk Level

low / medium / high

## Notes for Coder Agent

## Modification Hints

## Verification Expected Output

## Notes for Reviewer Agent
