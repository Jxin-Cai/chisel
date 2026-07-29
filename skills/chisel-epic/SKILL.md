---
description: 大型需求/initiative 分解为多个独立 idea 并行执行。当需求范围跨越多个模块、涉及多阶段交付、或复杂度远超单 idea 承载时使用。
user_invocable: true
---

# /chisel-epic

将大型 initiative 分解为 3-7 个可独立执行的 idea，管理跨 idea 依赖，逐个调度 `/chisel` 执行。

## 触发条件

用户输入 `/chisel-epic <initiative-description>` 或当 `/chisel` 评估需求后建议使用 epic 模式。

## 流程

### 1. 接收 Initiative

```
{EPIC_DIR} = .chisel/epic-<kebab-case-name>/
```

创建 `initiative.md`，包含完整的高层需求描述。

### 2. 分解

将 initiative 拆分为 3-7 个 idea，每个 idea：
- 范围独立可交付
- 复杂度不超过 standard
- 有明确的输入/输出接口

产出：
- `.chisel/epic-<name>/ideas/<idea-id>.md` — 每个子 idea 的 requirement
- `.chisel/epic-<name>/dependency-graph.json` — 依赖关系图
- `.chisel/epic-<name>/epic-state.json` — 状态追踪

### 3. 用户确认

向用户展示分解结果和依赖图（Mermaid），等待确认。

### 4. 依次执行

按依赖排序，对每个 ready idea 调用 `/chisel <idea-id>`：
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/epic-decompose.mjs {EPIC_DIR} --next
```

每个 idea 完成后更新状态：
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/epic-decompose.mjs {EPIC_DIR} --update <idea-id> done
```

### 5. Epic 完成

所有 idea status = done 时，生成 epic 总结。

## 脚本接口

```bash
# 查看状态
node ${CLAUDE_PLUGIN_ROOT}/scripts/epic-decompose.mjs <epic-dir> --status

# 获取下一个可执行的 idea
node ${CLAUDE_PLUGIN_ROOT}/scripts/epic-decompose.mjs <epic-dir> --next

# 更新 idea 状态
node ${CLAUDE_PLUGIN_ROOT}/scripts/epic-decompose.mjs <epic-dir> --update <idea-id> <done|in_progress|blocked>
```

## 约束

- 单个 idea 范围不超过 7 个 task
- 循环依赖不允许（DAG only）
- 用户必须确认分解方案后才能开始执行
