# Compact Encoding 规范

内部结构化数据在 agent 间流转时，使用紧凑格式降低 token 消耗。仅对机器消费的中间产物使用；人类可读文档（as-is overview、implementation-plan.md）保持散文体。

## 适用场景

- `cr-context.json` 中的 task 摘要（当总量 > 50KB）
- evidence-ledger 摘要
- task-workflow-state 快照

## 格式定义

### 1. Pipe-Table 格式

```
ID|Status|Files|Rework|Risk
task-001|coded|3|0|low
task-002|reviewing|5|1|medium
```

- 第一行为表头
- 字段用 `|` 分隔
- 无空格填充
- 值为空时留空（连续 `||`）

### 2. 状态缩写

| 全称 | 缩写 |
|------|------|
| pending | P |
| confirmed | C |
| coding | CG |
| coded | CD |
| reviewing | R |
| approved | A |
| needs_rework | NR |
| repairing | RP |
| blocked | B |
| failed | F |

### 3. CR 结果缩写

| 全称 | 缩写 |
|------|------|
| pass | P |
| fail | F |
| pass-cached | PC |
| pass (auto-skip) | PS |

### 4. 维度缩写

`spec`, `d2`-`d8`（保持不变，已经足够紧凑）

### 5. 紧凑 diff 摘要

当 unified_diff 超过 20KB 时：
```
+++ file1.ts (14 hunks, +82/-31)
+++ file2.mjs (3 hunks, +12/-5)
```

仅保留文件名 + hunk 数 + 增减统计。完整 diff 仍在 cr-context.json 中按需读取。

## cr-prepare.mjs --compact 行为

当 `--compact` flag 存在或 context 总量 > 50KB 时：
- `tasks[id].task_content` → 只保留 frontmatter（`---` 之间的内容）
- `tasks[id].report_content` → 只保留 frontmatter + "## Completion Status" 段
- `unified_diff` → 超过 20KB 时替换为紧凑摘要
- `wiki_query.matches` → 只保留 `id` + `score` + `category`
- 新增 `mode: "compact"` 标记

## 解码规则

Agent 收到 `mode: "compact"` 的 cr-context.json 时：
- 需展开细节 → 读取 task 文件或 report 原文
- 需看完整 diff → 使用 `git diff {base_ref}...HEAD -- <file>`
- 表格/缩写按本文档解码
