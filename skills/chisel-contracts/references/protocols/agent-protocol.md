# Chisel Agent 公共协议

所有负责分析、写作或审查的 Chisel agent 在开始工作前必须通过 `skills/chisel-contracts/SKILL.md` 的角色加载协议 Read 本文件。Coder 不加载本协议；其唯一契约位于 `chisel-implement/references/coder-instructions.md`。

## 1. Scope Proof 格式

**Scope Check Proof** 必须记录：

- Command（exact）、Result、schema_version、changed_files_count、violations_count、forbidden_symbol_hits_count
- Scope Check JSON Summary（完整 JSON）
- Hit Proofs 表（File / Expected proof / Forbidden proof / Symbol proof / Status）
- Invariant Proofs 表（Invariant / Proof / Result）

Invariant Proofs 必须逐项覆盖 task `Behavior Invariants`；`Proof` 必须填写实际验证证据，不得为空或占位；`Result` 只能是 `pass` 或 `fail`；approved CR 必须全部为 `pass`。

**CR 维度 Proof 去重规则**：Scope Check 只在 spec 维度完整执行。D2-D9 维度的 CR 产物中写 `## Scope / Invariant Proof: 见 cr/dim-spec-cr.md` 即可，不重复执行。

## 2. 模板优先

写产物前先 Read 对应模板文件，按模板结构填充。不凭记忆写格式。

## 3. 非 Coder 上下文隔离纪律

### 禁止累积摘要注入

编排器向分析、写作和审查 agent 传递最小的当前阶段上下文。Coder 接收 `coder-prepare.mjs` 生成的有界混合 bootstrap：规范化需求、原始输入、当前 task、3–8 个高相关源码/测试文件以及带 hash 的扩展引用；再通过 `context-query.mjs` 循环检索未解决证据。

绝不传递：
- 无关阶段的累积摘要
- 其他 task 的 coder-context
- 累积的“到目前为止已完成的 task 列表”叙述

### 理由

前序 task 信息通过文件系统可查（coder 可自行 Read），但主动注入会：
- 膨胀 prompt 占用推理 budget
- 引发"对齐前序风格"的过度一致化
- 在 context compaction 后成为幻觉源
