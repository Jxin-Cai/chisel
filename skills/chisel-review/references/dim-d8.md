# 维度 D8：影响面追踪（涟漪效应）

## 审查目标

追踪代码变更如何**向外传播**——找到 diff 之外的断裂调用方、违反的契约、下游故障。

其他维度看的是变更代码本身，D8 从变更代码**向外看**：谁依赖了我改的东西？它们还能正常工作吗？

**核心区分**：
- D7 问 "依赖代码还**有人用**吗？"（存亡判定）
- D8 问 "依赖代码还**能正常工作**吗？"（兼容性判定）
- D4 看设计原则（SRP/OCP），D8 看运行时影响（caller 会不会 crash）

## 关注领域

### 1. 调用链影响

变更了函数签名、返回值、行为或副作用后，所有 caller 是否仍能正确工作？

- 变更了参数列表 → 所有 caller 是否传入了正确的参数？
- 变更了返回类型 → 所有 caller 是否正确处理了新的返回类型？
- 变更了错误条件 → 所有 caller 是否正确捕获了新的错误？
- 删除了导出 → 是否还有其他地方在 import？

### 2. 消费者契约完整性

变更了类型、接口、数据结构后，所有消费者的假设是否仍成立？

- 接口实现是否仍满足变更后的接口？
- 嵌入/继承该结构体的代码是否处理了新增/删除的字段？
- API 消费者是否处理了响应变化？
- 序列化/反序列化是否仍兼容？

### 3. 共享状态与配置

变更了配置键、环境变量、全局状态后，其他读取者是否受影响？

- 变更的 config key 在其他地方是否仍被正确读取？
- 环境变量变更是否反映在所有部署配置中？
- 全局状态修改是否影响并发读取者？

### 4. 错误处理链

变更了错误类型、错误包装方式后，上游 handler 是否仍能正确捕获？

- 新的错误类型是否被所有上游 handler 处理？
- 变更的错误包装是否仍能被正确 unwrap？
- 重试逻辑是否仍在正确的错误条件下触发？

### 5. 数据库/Schema 连锁

变更了查询、模型、迁移后，其他数据读取者是否受影响？

- 变更的 model 字段是否反映在所有相关查询中？
- 迁移变更是否破坏已有数据读取者？
- 外键变更是否孤立了关联记录？

## Impact Trace 协议（必须执行）

对 diff 中**每个变更了签名/行为/返回值的函数、类型、接口**：

1. 确认变更了什么（签名、行为、返回值、错误条件、副作用）
2. `grep -rn "<符号名>" --include="*.{语言扩展名}"` 搜索全仓所有 caller / consumer
3. 逐个 Read caller/consumer 代码，验证其在新行为下是否仍正确
4. 标注：SAFE / AT_RISK / BROKEN

```markdown
### Impact Trace：[ChangedSymbol] at file:123

**变更内容**：
- 变更前：[原行为/签名]
- 变更后：[新行为/签名]

**发现的依赖者**：[N] 个，跨 [M] 个文件

| # | 依赖者 | 位置 | 关系 | 影响 | 状态 |
|---|-------|------|------|------|------|
| 1 | HandleRequest | api/handler.go:45 | 调用 | 直接使用返回值 | SAFE |
| 2 | ProcessBatch | batch/runner.go:89 | 调用 | 假定旧的错误类型 | AT_RISK |
| 3 | MigrateData | migration/v2.go:34 | 调用 | 已删除的参数 | BROKEN |

**判定**：[N] SAFE | [N] AT_RISK | [N] BROKEN

**搜索模式**：`grep -rn "ChangedSymbol" --include="*.go"`
```

## 严重度

| 级别 | 示例 |
|------|------|
| **high** | caller 会 panic/crash、删除的导出仍被 import、schema 变更导致数据损坏 |
| **high** | caller 使用了变更后的错误类型但静默失败、旧返回值假设不再成立 |
| **medium** | caller 功能降级但不 crash（缺少新增的可选字段）、测试需要更新 |
| **low** | 文档引用旧行为、注释引用旧签名 |

## 阻断条件

| 情况 | 处理 |
|------|------|
| 无法判断代码是否属于公共 API | STOP。报告歧义。 |
| 发现 BROKEN caller 会导致运行时错误 | 标 high。不得延后。 |

## CR 产物格式

### Frontmatter

```yaml
---
dimension: d8
result: pass | fail
affected_tasks: [task-001]
rework_count: 0
---
```

### 正文模板

```markdown
# D8 CR: 影响面追踪

## 结论

PASS | FAIL

<简要说明理由>

## Impact Trace 分析

（对每个变更了签名/行为的符号填写 Impact Trace 协议模板）

（无外部影响则标注"无外部依赖者受影响"）

## 调用链评估

**BROKEN 调用者**：❌
- [Caller at file:line] — [为什么会 break]

**AT_RISK 调用者**：⚠️
- [Caller at file:line] — [什么情况下可能 break]

**SAFE 调用者**：✅ [数量] 个已验证安全

（无 BROKEN/AT_RISK 则标注"所有调用者验证通过"）

## 消费者契约评估

**违反的契约**：❌
- [Consumer at file:line] — [哪个契约被违反]

**风险契约**：⚠️
- [Consumer at file:line] — [哪个假设可能不再成立]

**完好的契约**：✅ [数量] 个已验证安全

（无契约问题则标注"所有消费者契约完好"）

## 检查结果

| 检查项 | 结果 | 说明 |
|--------|------|------|
| 调用链影响 | PASS/FAIL/N/A | <说明> |
| 消费者契约 | PASS/FAIL/N/A | <说明> |
| 共享状态 | PASS/FAIL/N/A | <说明> |
| 错误处理链 | PASS/FAIL/N/A | <说明> |
| 数据库/Schema | PASS/FAIL/N/A | <说明> |

## 问题详情

（FAIL 项逐条展开）

### 问题 1

- 位置：<文件:行号>
- 类型：BROKEN 调用者 / 违反契约 / 共享状态冲突 / 错误链断裂 / Schema 连锁
- 变更的符号：<符号名 at 变更位置>
- 影响描述：
- 确认方式：<grep 命令 + Read 验证>

> 📎 Read `dim-shared-footer.md` 获取 CR 产物格式模板（Scope/Wiki、Rework Items / Observations / Rework Verification 表格格式）
```

## 不要标记

- 仅内部使用的私有函数签名变更（无外部 caller）
- 类型变更但有向后兼容的序列化/反序列化处理
- 变更前就已经 broken 的 caller（pre-existing 问题）
- 测试代码中对新签名的适配（测试更新是正常流程不是问题）
