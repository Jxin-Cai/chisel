# 维度：Spec 合规检查

## 审查目标

验证代码实现是否满足 task 规格要求——"做对了吗？"

这是门槛维度：不合规的代码没有资格进入质量审查。

## 检查清单

### 1. Acceptance Criteria 覆盖

- Read task 文件的 `## Acceptance Criteria` 章节
- Read task report 的 `## Acceptance Criteria Result` 章节
- 逐条对照：每个 AC 是否在 report 中标记为通过，且有实际证据支持

### 2. Expected Files 覆盖

- Read task 文件 frontmatter 的 `expected_files`
- Read task report frontmatter 的 `changed_files`
- 检查 expected_files 是否全部出现在 changed_files 中

### 3. Scope Check

- 运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/scope-check.mjs {idea_dir} {task_id}`
- 结果必须为 `pass=true`
- 记录完整的 Scope Check Proof

### 4. Forbidden Files / Symbols

- Read task 文件的 `Forbidden Files / Areas` 和 `Forbidden Symbols` 章节
- 对照 task report 的 changed_files，检查是否触碰禁区

### 5. Behavior Invariants

- Read task 文件的 `## Behavior Invariants` 章节
- 逐项验证每个不变量是否被保持
- 必须有实际验证证据（文件路径 + 行号或行为描述）

### 6. 需求可追溯性

- 运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/traceability-check.mjs {idea_dir}`
- 验证每个 task 的 `trace_refs` 在 `to-be/traceability-matrix.json` 中有映射
- 验证每个 acceptance_criteria 至少被一个 traceability item 覆盖
- 如果 traceability-matrix.json 不存在，此项跳过（不报 fail）
- 结果记录在 CR 报告的 "## Traceability Coverage" 章节

### 7. 伴生产物完整性（Companion Artifact Check）

从代码 diff 推断必须存在的伴生变更，验证它们是否被实现：

### 8. 全链路字段透传验证（Field Passthrough Check）

当 diff 中新增了 DB 字段或 DTO/VO 字段时，验证该字段的全链路透传：

1. 从 `as-is/ai-input/field-flow.md`（如有）读取已知的字段流转表
2. 对新增字段，验证 DB→Entity→Service→DTO→API Response→Frontend Type→UI Render 各层是否都有对应变更
3. 如果某层已有（field-flow.md 中记录为存在）但本次 diff 未修改 → 检查该层是否无需修改（字段自动透传）还是遗漏
4. 缺失关键层级（DTO 未透传、前端未适配）→ 标 FAIL（confidence 85，severity high）
5. 缺失非关键层级（如 State/Store 层可能直接从 API response 使用）→ 标 WARN（severity medium）
6. `field-flow.md` 不存在时此项跳过（不报 fail）

**推断规则**（检测到 diff 中的模式 → 验证伴生产物存在）：

**后端规则**：

| diff 中的变更模式 | 必须存在的伴生产物 | 验证方式 |
|-----------------|-------------------|---------|
| model/entity 新增字段（ORM annotation / schema 定义） | DB migration 文件（DDL） | 检查 migration 目录下有对应变更文件 |
| 新增 controller/handler method | 路由注册 + DTO 定义 | 检查路由配置 + 类型定义文件 |
| 代码引用新的 config key / env var | 配置模板中有该 key | grep `.env.example` / `application.yml` 等 |
| 修改了序列化字段名或结构 | 版本兼容处理或 schema 文件更新 | 检查 schema 文件或兼容代码 |
| 新增 DB 表 / 外键 | 完整 DDL + 索引 + 关联查询适配 | 检查 migration 文件内容 |
| 删除/重命名公共 API | 所有内部 caller 已适配（与 D8 互补） | grep 旧符号名确认无残留引用 |

**前端规则**（当项目有前端代码时适用）：

| diff 中的变更模式 | 必须存在的伴生产物 | 验证方式 |
|-----------------|-------------------|---------|
| 后端 DTO/VO/Response 新增字段 | 前端类型定义文件有对应字段 | grep 前端 types/interfaces 目录 |
| 新增后端 API endpoint | 前端有对应的 API 调用函数 | 检查前端 api/ 或 services/ 目录 |
| 后端接口响应字段变更 | 前端使用处已适配新字段 | grep 前端中引用该接口数据的组件 |
| 新增 DB 字段且 DTO 已透传到 API | 前端渲染层有展示或处理该字段 | 检查前端对应页面组件 |

**执行方式**：
1. 扫描 diff 中每个变更文件，判断是否触发上述规则
2. 对触发的规则，验证伴生产物是否存在于本次变更（changed_files）或已有代码中
3. 缺失伴生产物 → 标 FAIL（confidence 90+，严重度 high）

## CR 产物格式

### Frontmatter

```yaml
---
dimension: spec
result: pass | fail
affected_tasks: [task-001]
rework_count: 0
---
```

### 正文模板

```markdown
# Spec CR: {task_ids}

## 结论

pass | fail

## Acceptance Criteria 覆盖

| AC | Task 要求 | Report 证据 | 结果 |
|----|----------|-------------|------|
| AC-1 | ... | ... | pass / fail |

## Expected Files 覆盖

- expected_files：
- changed_files：
- 未覆盖：（无 / 列出缺失文件）
- 结果：pass / fail

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

## Forbidden Files / Symbols 检查

- 禁区列表：
- 触碰情况：（无 / 列出触碰文件）
- 结果：pass / fail

## Behavior Invariants

#### Invariant Proofs

| Invariant | Proof | Result |
|---|---|---|
| <不变量描述> | <验证证据> | pass / fail |

必须逐项覆盖 task `Behavior Invariants`；`Proof` 必须填写实际验证证据，不得为空或占位；`Result` 只能是 `pass` 或 `fail`。

## Wiki Entries Loaded

| Entry | File | Why Loaded | Used For |
|---|---|---|---|

## Progressive Load Proof

- Query command：
- Query summary：
- category/min-score：
- load_plan：
- None matched：

## 伴生产物完整性

| 触发模式 | 检测到的变更 | 必须的伴生产物 | 实际存在 | 结果 |
|---------|------------|--------------|---------|------|
| <规则名> | <文件:变更内容> | <应有的产物> | ✅ / ❌ <路径或说明> | pass / fail |

- 未触发任何规则：「无适用规则，跳过」
- 触发但全部通过：pass
- 任一缺失：fail

## 全链路字段透传验证

| 字段 | DB | Entity | Service | DTO | API | Frontend Type | State | UI | 结果 |
|------|:--:|:------:|:-------:|:---:|:---:|:------------:|:-----:|:--:|------|
| <字段名> | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | — | ✅ | pass |

- field-flow.md 不存在：「无 field-flow.md，跳过」
- 无新增字段：「无新增字段，跳过」
- 有字段但全部透传：pass
- 关键层级缺失：fail

## 不合规项汇总

result 为 fail 时，列出所有不合规项：

| ID | 检查项 | affected_task_id | 问题描述 | 严重度 |
|----|--------|------------------|---------|--------|
| SPEC-001 | AC 覆盖 | task-001 | <具体不合规描述> | high/medium/low |

## Rework Verification

（仅 rework_count > 0 时填写）

| Item | 上次问题 | 修复结果 | 状态 |
|------|----------|----------|------|
| SPEC-001 | <问题描述> | <实际修复情况及代码证据> | fixed / not_fixed / partial |
```
