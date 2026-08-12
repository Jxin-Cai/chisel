---
task_id: task-001-example
status: confirmed
depends_on: []
description: 描述这个 task 完成的业务能力
starting_points: [] # 仓库相对路径，仅作为 Coder 探索起点，不是修改边界
trace_refs: [] # 必须对应 to-be/traceability-matrix.json 的条目 ID；由后处理脚本和 reviewer 追溯
allowed_symbols: [] # 本 task 允许触碰的关键函数/类/接口名
forbidden_symbols: [] # 本 task 禁止触碰的关键函数/类/接口名
impact_surface: {"files":[],"symbols":[],"invariants":[],"shared_state":[],"reads":[],"writes":[]} # 并行调度使用；shared_state 兼容旧格式并视为 write lock
task_complexity: standard # trivial | standard | complex — 决定 coder agent 模型
---

# Task: task-001-example

## 背景

## 目标行为

## Scope

### Allowed Files / Areas

- 仅作导航建议；Coder 可依据源码证据扩展

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

## 实现要求

## Traceability

- REQ-001

每个 trace ref 必须来自 `to-be/traceability-matrix.json.items[].id`，最终由自动 diff inventory 和 reviewer 对照验证。

## Behavior Invariants

- [ ] 需要保持的旧行为、接口契约或包袱

## Acceptance Criteria

- [ ] 

## Rollback Point

## Risk Level

low / medium / high

## Notes for Coder Agent

task brief 是起点建议，不是事实边界。必须自己 grep caller、读测试、追依赖；需要修改 starting_points 外文件时直接改并在最终摘要说明理由。只有 Forbidden Files / Areas 是硬边界。

## Modification Hints

## Notes for Reviewer Agent
