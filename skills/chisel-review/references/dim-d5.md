# 维度 D5：风格一致性

## 审查目标

检查新增代码的风格是否与项目现有风格一致。

遗留系统的风格往往不完美但已形成约定——新代码必须融入而非另起一套。

## 检查清单

### 1. 命名规范

- 变量、函数、类的命名是否与项目已有风格一致？
- 大小写约定（camelCase、snake_case、PascalCase）是否统一？
- 缩写和术语使用是否与项目一致？

### 2. 代码组织

- 文件结构是否与同目录下的已有文件一致？
- import 顺序是否与项目约定一致？
- 函数/方法的排列顺序是否遵循项目惯例？

### 3. 错误处理风格

- 错误处理方式是否与项目一致（异常 vs 返回码 vs Result 类型）？
- 错误消息的格式和粒度是否一致？
- 日志级别的使用是否与项目惯例一致？

### 4. 注释风格

- 注释的密度和风格是否与项目一致？
- 是否有不必要的注释（解释显而易见的代码）？
- 是否遵循项目的文档注释格式（JSDoc、docstring 等）？

### 5. 判定标准

风格审查的参照物是"项目已有风格"，不是"理想风格"：
- **应标 FAIL**：明显与周围代码风格不一致，读者会感到突兀
- **不应标 FAIL**：项目已有风格本身不完美，但新代码遵循了它

## CR 产物格式

### Frontmatter

```yaml
---
dimension: d5
result: pass | fail
affected_tasks: [task-001]
rework_count: 0
---
```

### 正文模板

```markdown
# D5 CR: 风格一致性

## 结论

PASS | FAIL

<简要说明理由>

## 检查结果

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 命名规范 | PASS/FAIL | <说明> |
| 代码组织 | PASS/FAIL | <说明> |
| 错误处理风格 | PASS/FAIL | <说明> |
| 注释风格 | PASS/FAIL | <说明> |

## 风格参照

对照的已有代码：
- <文件:行号> — 作为命名风格参照
- <文件:行号> — 作为代码组织参照

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
- 不一致之处：
- 项目已有风格：<参照文件:行号>
- 修复建议：

## Rework Items

| ID | affected_task_id | 问题描述 | 修复建议 | 严重度 |
|----|------------------|---------|---------|--------|
| CR-001 [D5] | task-001 | <描述> | <建议> | high/medium/low |

## Rework Verification

（仅 rework_count > 0 时填写）

| CR Item | 上次问题 | 修复结果 | 状态 |
|---------|----------|----------|------|
| CR-001 [D5] | <问题描述> | <实际修复情况及代码证据> | fixed / not_fixed / partial |
```
