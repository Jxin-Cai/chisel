# 维度 D7：无效代码清除

## 审查目标

识别变更中引入或遗留的无效代码——它们增加认知负担且可能隐藏 bug。

遗留系统本身就有大量历史包袱，新增代码不应再引入新的死代码。

## 检查清单

### 1. 未使用的变量

- 是否有声明但未使用的变量？
- 是否有赋值但从未读取的变量？
- 是否有仅在 debug 时使用但未清理的变量？

### 2. 未使用的函数

- 是否有定义但未被调用的函数/方法？
- 是否有被注释掉的函数仍保留在代码中？
- 是否有 export 但无任何 import 方引用的函数？

### 3. 未使用的 import

- 是否有 import 了但未使用的模块/包？
- 是否有 import 了整个模块但只用了其中一个成员？

### 4. 不可达代码

- 是否有 return/throw 之后的代码？
- 是否有条件永远为 false 的分支？
- 是否有被功能开关永久关闭的代码路径？

### 5. 判定标准

区分"真正的死代码"和"看起来没用但有意义的代码"：
- **应标 FAIL**：IDE 已标黄的 import、return 后的代码、从未被调用的 private 方法
- **不应标 FAIL**：被 wiki `weird-but-intentional.md` 记录的保留代码、框架约定的 hook 方法、预留的扩展接口

## CR 产物格式

### Frontmatter

```yaml
---
dimension: d7
result: pass | fail
affected_tasks: [task-001]
rework_count: 0
---
```

### 正文模板

```markdown
# D7 CR: 无效代码清除

## 结论

PASS | FAIL

<简要说明理由>

## 检查结果

| 类型 | 位置 | 说明 |
|------|------|------|
| 未使用变量 | <文件:行号> | <变量名> |
| 未使用函数 | <文件:行号> | <函数名> |
| 未使用 import | <文件:行号> | <模块名> |
| 不可达代码 | <文件:行号> | <说明> |

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
- 类型：未使用变量 / 未使用函数 / 未使用 import / 不可达代码
- 内容：<代码片段>
- 确认方式：<grep 结果 / 调用链分析>

## Rework Items

| ID | affected_task_id | 问题描述 | 修复建议 | 严重度 |
|----|------------------|---------|---------|--------|
| CR-001 [D7] | task-001 | <描述> | <建议> | high/medium/low |

## Rework Verification

（仅 rework_count > 0 时填写）

| CR Item | 上次问题 | 修复结果 | 状态 |
|---------|----------|----------|------|
| CR-001 [D7] | <问题描述> | <实际修复情况及代码证据> | fixed / not_fixed / partial |
```
