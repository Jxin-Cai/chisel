# 维度 D2：并发与分布式安全

## 审查目标

识别并发和分布式环境下的安全隐患——竞态条件、死锁、数据不一致。

遗留系统中新增的并发代码特别危险：原有单线程假设可能被无意打破。

## 检查清单

### 1. 竞态条件

- 共享可变状态是否有适当的同步机制？
- 读写操作的原子性是否有保障？
- Check-then-act 模式是否存在 TOCTOU 漏洞？

### 2. 锁与线程安全

- 锁的粒度是否合适（太粗影响性能，太细容易遗漏）？
- 是否存在死锁风险（多锁场景的获取顺序是否一致）？
- 是否正确使用了线程安全的数据结构？

### 3. 分布式状态一致性

- 跨服务/跨节点的状态同步机制是否可靠？
- 网络分区、超时、重试场景下数据是否一致？
- 缓存与数据源之间的一致性保证？

### 4. 事务边界

- 数据库事务的范围是否合理？
- 长事务是否会造成锁表或连接耗尽？
- 事务失败时的回滚逻辑是否完整？

### 5. 幂等性

- 重复请求是否产生相同结果？
- 消息重复消费是否安全？
- 重试机制是否考虑了副作用？

## CR 产物格式

### Frontmatter

```yaml
---
dimension: d2
result: pass | fail
affected_tasks: [task-001]
rework_count: 0
---
```

### 正文模板

```markdown
# D2 CR: 并发与分布式安全

## 结论

PASS | FAIL | N/A

<简要说明理由>

## 检查结果

| 检查项 | Task | 结果 | 说明 |
|--------|------|------|------|
| 竞态条件 | task-001 | PASS/FAIL/N/A | <说明> |
| 锁与线程安全 | task-001 | PASS/FAIL/N/A | <说明> |
| 分布式状态一致性 | task-001 | PASS/FAIL/N/A | <说明> |
| 事务边界 | task-001 | PASS/FAIL/N/A | <说明> |
| 幂等性 | task-001 | PASS/FAIL/N/A | <说明> |

## Scope Check Proof

- Command：`node ${CLAUDE_PLUGIN_ROOT}/scripts/scope-check.mjs {idea_dir} {task_id}`
- Result：pass | fail
- schema_version：3
- changed_files_count：
- violations_count：
- forbidden_symbol_hits_count：

#### Scope Check JSON Summary

粘贴 scope-check.mjs 的完整 JSON 输出。

#### Hit Proofs Reviewed

| File | Expected proof | Forbidden proof | Symbol proof | Status |
|---|---|---|---|---|
| | | | | |

#### Invariant Proofs

| Invariant | Proof | Result |
|---|---|---|
| <不变量描述> | <验证证据> | pass / fail |

必须逐项覆盖 task `Behavior Invariants`；`Proof` 必须填写实际验证证据，不得为空或占位；`Result` 只能是 `pass` 或 `fail`。

## Wiki Entries Loaded

| Entry | File | Why Loaded | Used For |
|---|---|---|---|
| | | | |

## Progressive Load Proof

- Query command：
- Query summary：
- category/min-score：
- load_plan：
- None matched：

N/A 只用于正文检查项；frontmatter `result` 仍只能是 `pass | fail`。`pass` 表示该维度无阻塞问题，不表示所有检查项都适用。

## 问题详情

（FAIL 项逐条展开）

### 问题 1

- 位置：<文件:行号>
- 描述：
- 风险等级：high/medium/low
- 修复建议：

## Rework Items

| ID | affected_task_id | 问题描述 | 修复建议 | 严重度 |
|----|------------------|---------|---------|--------|
| CR-001 [D2] | task-001 | <描述> | <建议> | high/medium/low |

## Rework Verification

（仅 rework_count > 0 时填写）

| CR Item | 上次问题 | 修复结果 | 状态 |
|---------|----------|----------|------|
| CR-001 [D2] | <问题描述> | <实际修复情况及代码证据> | fixed / not_fixed / partial |
```
