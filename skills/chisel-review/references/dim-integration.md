# 维度 Integration：跨 Task 集成审查

## 审查目标

验证多个 task 的组合变更在系统级别是一致且正确的。逐 task 审查可能遗漏的跨 task 交互问题在此阶段捕获。

**激活条件**：`task_count > 1` 且需求复杂度为 standard/complex。

## 检查清单

### 1. 命名一致性

- 多个 task 引入的新函数/变量/类型/常量命名是否一致？
- 相似概念是否使用相同术语（不同 task 没有各自发明术语）？
- 命名风格是否与仓库现有约定一致？

### 2. Import/Export 对齐

- Task A 的 `## Exports` 导出的符号是否被依赖它的 task 正确引用？
- 导出签名（参数类型、返回值）是否与消费方预期一致？
- 是否存在循环依赖？

### 3. 共享状态一致性

- 多个 task 修改的共享状态（DB 表字段、全局变量、配置项、缓存 key）有无冲突？
- 对同一字段的并发修改是否有竞态风险？
- 事务边界是否正确——跨 task 的操作是否需要原子性保证？

### 4. 逻辑去重（跨 task）

- 不同 task 是否独立实现了相似/重复逻辑？
- 是否应提取为共享模块/工具方法？
- D3 per-task 审查只看单 task 内部去重，此处看跨 task 间的重复。

### 5. 系统级不变量

- 组合变更是否违反 `invariants.jsonl` 中的系统级不变量？
- 变更组合后的整体行为是否仍满足 requirement 的全局约束？
- 数据流端到端是否连通（A 产出 → B 消费 → C 持久化）？

### 6. 错误处理一致性

- 各 task 对同类错误的处理方式是否一致？（如超时、重试、降级策略）
- 错误传播路径是否完整——一个 task 的异常是否能被下游 task 的代码正确捕获？

## 审查方式

1. 读取所有 task 的 report（changed_files、Exports/Imports 章节）
2. 获取完整功能 diff（全量，不限单 task）
3. 重点检查 task 间的交互边界（import 语句、共享文件修改、接口调用）
4. 参照 `invariants.jsonl` 验证系统级约束

## CR 产物格式

### Frontmatter

```yaml
---
dimension: integration
result: pass | fail
affected_tasks: [task-001, task-002]
rework_count: 0
---
```

### 正文模板

```markdown
# Integration CR: 跨 Task 集成审查

## 结论

PASS | FAIL

<简要说明理由>

## Task 交互矩阵

| Task A | Task B | 交互点 | 状态 |
|--------|--------|--------|------|
| task-001 | task-002 | 共享 XxxService | OK / 问题 |

## 问题详情

（FAIL 项逐条展开）

### 问题 1

- 涉及 tasks：task-001, task-002
- 类型：命名一致性 / Import-Export / 共享状态 / 逻辑去重 / 系统不变量 / 错误处理
- 描述：<具体问题>
- 位置：<file:line (task-001)> ↔ <file:line (task-002)>
- 建议：<修复方案>
- 严重度：high/medium/low
- 置信度：80-100

## Rework Items

| ID | affected_task_id | 问题描述 | 修复建议 | 严重度 | 置信度 |
|----|------------------|---------|---------|--------|--------|
| CR-INT-001 | task-001,task-002 | <描述> | <建议> | high/medium | 80-100 |

## Observations (non-blocking)

| ID | 描述 | 置信度 |
|----|------|--------|
| OBS-INT-001 | <描述> | 60-79 |
```

## 不要标记

- 单 task 内部的问题（已由 D2-D8 覆盖）
- 变更前就已存在的跨模块问题（pre-existing）
- 架构级改进建议（超出当前需求范围）
- task 间的风格微差异（已由 D5 覆盖）
