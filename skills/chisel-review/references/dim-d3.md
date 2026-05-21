# 维度 D3：代码去重

## 审查目标

识别重复逻辑，判断是否应提取为公共方法/模块。

遗留系统中 copy-paste 是技术债的主要来源：修一处漏一处，行为逐渐分化。

## 检查清单

### 1. 跨 task 重复

- 不同 task 的变更中是否有结构相似的代码段？
- 是否可以提取为共享的 utility 函数或基类？

### 2. 同 task 内重复

- 同一 task 的变更文件中是否有重复逻辑？
- 循环体、条件分支中是否有可提取的公共部分？

### 3. 与已有代码重复

- 新增代码是否与仓库中已有代码存在功能重叠？
- 是否有已存在的 utility/helper 可以复用而非重写？

### 4. 重复的判定标准

不是所有相似代码都需要去重：
- **应去重**：完全相同的业务逻辑、仅参数不同的重复代码块
- **不应去重**：看起来相似但业务语义不同的代码、过度抽象反而降低可读性的场景

## CR 产物格式

### Frontmatter

```yaml
---
dimension: d3
result: pass | fail
affected_tasks: [task-001]
rework_count: 0
---
```

### 正文模板

```markdown
# D3 CR: 代码去重

## 结论

PASS | FAIL

<简要说明理由>

## 重复模式分析

| 重复模式 | 位置 | 行数 | 建议 |
|----------|------|------|------|
| <描述重复逻辑> | <文件1:行号, 文件2:行号> | <重复行数> | <提取为公共方法/模块> |

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

- 位置 A：<文件:行号>
- 位置 B：<文件:行号>
- 重复内容：<简述>
- 建议提取为：<函数名/模块名>
- 严重度：high/medium/low

## Rework Items

| ID | affected_task_id | 问题描述 | 修复建议 | 严重度 |
|----|------------------|---------|---------|--------|
| CR-001 [D3] | task-001 | <描述> | <建议> | high/medium/low |

## Rework Verification

（仅 rework_count > 0 时填写）

| CR Item | 上次问题 | 修复结果 | 状态 |
|---------|----------|----------|------|
| CR-001 [D3] | <问题描述> | <实际修复情况及代码证据> | fixed / not_fixed / partial |
```
