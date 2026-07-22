# 维度 D7：无效代码清除（三环孤儿检测）

## 审查目标

识别**因本次变更而变死**的代码，不只是 diff 内的死代码。

遗留系统本身就有大量历史包袱，新增代码不应再引入新的死代码，更不应制造新的孤儿——被删除/重构的代码曾经调用的 helper、validator、converter 可能已经没有任何 caller 了。

**核心区分**：
- D7 问 "依赖代码还**有人用**吗？"（存亡判定）
- D8 问 "依赖代码还**能正常工作**吗？"（兼容性判定）

## 三环模型

```
Ring 3: 连锁效应 — 只为已死的 Ring 2 代码服务的工具/模块
  Ring 2: 一阶导数 — 直接服务于变更代码的 helper、validator、converter
    Ring 1: 目标 — diff 内的死代码
```

**三个环都必须分析。** 只做 Ring 1 就下结论是不完整的。

## 检查清单

### Ring 1：diff 内的死代码

- 是否有声明但未使用的变量？赋值但从未读取的变量？
- 是否有定义但未被调用的函数/方法？被注释掉的函数？
- 是否有 import 了但未使用的模块/包？
- 是否有 return/throw 之后的不可达代码？条件永远为 false 的分支？

### Ring 2：一阶导数孤儿扫描（主要价值区）

对 diff 中**每个被删除/重构的函数或类型**：

1. 列出它原来调用的所有 callee（helper、validator、converter、常量）
2. 对每个 callee，`grep -rn "<callee名>" --include="*.{语言扩展名}"` 全仓搜索
3. 从结果中排除 diff 已删除/修改的 caller
4. 剩余 caller 数 = 0 → 标记为 **ORPHAN**

重点关注：
- helper 函数（只被重构代码调用的工具方法）
- 验证/转换函数（为特定场景编写的 validator/converter）
- 错误类型/常量（只被删除代码引用的 error type）
- 测试 helper（只为已删除代码服务的测试工具）

### Ring 3：连锁级联检测

对 Ring 2 中发现的每个孤儿，重复 Ring 2 的步骤：

1. 列出孤儿的 callee
2. grep 全仓搜索 caller
3. 扣除孤儿本身
4. 剩余 caller 数 = 0 → 标记为 **CASCADE ORPHAN**

### Root Set 豁免

以下代码即使 grep 找不到显式 caller，也**不应标为孤儿**：

| 类别 | 示例 | 原因 |
|------|------|------|
| 入口点 | `main()`、`init()`、`Test*()`、HTTP handler | 框架/运行时调用 |
| 接口实现 | 满足 interface 的方法 | 隐式满足 |
| 导出 API | 库包中的导出函数 | 外部调用者 |
| 反射调用 | 带 `json:`、`db:`、`yaml:` tag 的字段 | 反射访问 |
| 生成代码 | `// Code generated` 头部的文件 | 重新生成会更新引用 |
| wiki 豁免 | wiki `weird-but-intentional.md` 记录的保留代码 | 已知的有意保留 |

**误将 Root Set 标为孤儿 = 误报。标记前必须验证。**

### Phantom Safety（幽灵安全）

孤儿化的**验证逻辑或安全检查**特别危险：维护者看到代码存在，以为它还在运行，实际上已经没有 caller 了。标记为 **high 严重度**。

示例：一个 `validateTransactionAmount()` 函数，重构后内联了验证逻辑，原函数仍留在文件中但 caller 为零。下一个读代码的人会误以为它仍在生效。

## 孤儿追踪协议（必须执行）

对每个被删除/重命名/重构的函数或类型：

```markdown
### 孤儿追踪：[Symbol] at file.go:123

**发生了什么**：diff 删除/重构了 `[CallerSymbol]` at `changed_file:45`，它是 [Symbol] 的调用方

**Caller 计数**：
- 变更前：[N] 个 caller
- diff 移除：[M] 个
- 剩余：[N-M] 个
- Root Set 匹配：YES/NO

**环**：[1 | 2 | 3]
**状态**：ORPHANED | ALIVE
**严重度**：high / medium / low

**级联检查**：
| # | 孤儿的 Callee | 位置 | 剩余 Caller 数 | 状态 |
|---|--------------|------|--------------|------|
| 1 | formatError | helper.go:78 | 0 | ORPHANED (→ Ring 3) |
| 2 | validationRegex | helper.go:12 | 3 | ALIVE |
```

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

### Ring 1：diff 内死代码

| 类型 | 位置 | 说明 |
|------|------|------|
| 未使用变量 | <文件:行号> | <变量名> |
| 未使用函数 | <文件:行号> | <函数名> |
| 未使用 import | <文件:行号> | <模块名> |
| 不可达代码 | <文件:行号> | <说明> |

（无则标注"Ring 1 无死代码"）

### Ring 2：一阶导数孤儿

（对每个发现的孤儿填写孤儿追踪协议模板）

（无则标注"Ring 2 未发现孤儿"）

### Ring 3：连锁级联

（Ring 2 孤儿的 callee 级联检测结果）

（无则标注"Ring 3 无级联孤儿"）

### 三环汇总

| 环 | 发现孤儿数 |
|---|----------|
| Ring 1（目标） | [N] |
| Ring 2（一阶导数） | [N] |
| Ring 3（连锁） | [N] |
| **合计** | **[N]** |

## 问题详情

（FAIL 项逐条展开）

### 问题 1

- 位置：<文件:行号>
- 环：Ring 1 / Ring 2 / Ring 3
- 类型：未使用变量 / 孤儿函数 / 级联孤儿 / 幽灵安全
- 内容：<代码片段>
- 确认方式：<grep 命令 + 结果摘要>
- Root Set 检查：已排除 / 不适用

> 📎 Read `dim-shared-footer.md` 获取 CR 产物格式模板（Scope/Wiki、Rework Items / Observations / Rework Verification 表格格式）
```

## 不要标记

- Root Set 中的元素（入口点、接口实现、导出 API、反射调用、生成代码）
- wiki 中标记为有意保留的代码
- grep 结果中出现在注释/字符串/文档中的引用（不算有效 caller）
- 测试文件中的 helper 只要有测试在用
