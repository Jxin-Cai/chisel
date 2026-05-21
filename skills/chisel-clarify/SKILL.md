---
name: chisel-clarify
description: 当 chisel 编排器进入 clarify:requirement 阶段时触发。
argument-hint: "<idea-name>"
---

# chisel-clarify

需求澄清阶段。基于已确认的 as-is 和原始需求，多维度让用户明确真实诉求。不做方案设计，不改业务代码。

## 当前工作流状态

!`node ${CLAUDE_PLUGIN_ROOT}/hooks/workflow-snapshot.mjs 2>/dev/null || echo "无活跃工作流"`

## 输入

| 来源 | 读取 |
|------|------|
| `{IDEA_DIR}/requirement.md` | 原始需求目标和初步验收标准 |
| `{IDEA_DIR}/as-is/overview.md` | 当前系统能力边界、风险地图 |
| `{IDEA_DIR}/clarifications.json` | understand:confirm 阶段的 as-is 澄清结论 |
| `{IDEA_DIR}/as-is/ai-input/`（如存在） | 结构化事实、约束、变更面 |

## 七个澄清维度

| 维度 | 关注点 | 举例 |
|------|--------|------|
| 功能范围 | 精确的 IN/OUT 边界 | "这个需求包不包括 XXX？" |
| 影响分析 | 基于 as-is 发现的关联系统/接口确认 | "改这里会影响到 YYY，是否可接受？" |
| 兼容性约束 | 必须保持的旧行为、接口契约、数据格式 | "旧客户端会不会受影响？" |
| 非功能需求 | 性能、并发、安全、可观测性 | "有没有并发要求？需不需要加监控？" |
| 优先级排序 | 可拆分时哪些是 P0/P1/P2 | "如果时间不够，哪些可以先不做？" |
| 验收标准细化 | 将初步标准细化为可验证条件 | "怎么算通过？需不需要边界测试？" |
| 风险容忍度 | 对不确定因素的态度 | "不确定的地方偏保守还是激进？" |

## Complexity-Aware 维度选择

| 复杂度 | 必须覆盖的维度 |
|--------|--------------|
| trivial | 功能范围、验收标准细化（2 维度） |
| standard / complex | 全部 7 维度 |

复杂度由 `requirement.md` 自动判定（显式标注 `## 复杂度: trivial/standard/complex`，或基于涉及范围条目数推断）。

## 执行流程

1. Read `{IDEA_DIR}/requirement.md`
2. Read `{IDEA_DIR}/as-is/overview.md`
3. Read `{IDEA_DIR}/clarifications.json`（如存在）
4. 如存在 `{IDEA_DIR}/as-is/ai-input/`，按需 Read `constraints.md` 和 `change-surface.md`
5. 基于以上内容，为每个维度生成 1-3 个针对性问题
6. 使用 `AskUserQuestion` 向用户提问（可分批，每批不超过 4 个问题）
7. Read `${CLAUDE_PLUGIN_ROOT}/skills/chisel-clarify/references/requirement-clarification-template.md`
8. 将用户回答写入 `{IDEA_DIR}/requirement-clarification.json`（权威机器可读记录）
9. 将人类可读镜像写入 `{IDEA_DIR}/requirement-clarification.md`
10. 运行 gate 验证：`node ${CLAUDE_PLUGIN_ROOT}/scripts/gate-check.mjs {IDEA_DIR} clarification-complete`

<HARD-GATE>
此步骤澄清的是需求本身的诉求和边界，不是 as-is 理解的正确性（那是 understand:confirm 的职责）。
必须按复杂度覆盖对应维度（trivial=2，standard/complex=7），即使某些维度用户回答"无特殊要求"也要记录。
不能代替用户回答——每个维度必须由用户明确确认。
问题要基于 as-is 中实际发现的事实来提，不要泛泛而问。

合理化预防表：

| 你的想法 | 现实 |
|---------|------|
| "需求描述已经很清楚，不需要澄清" | 即便清楚也需要确认边界和优先级 |
| "用户肯定没有非功能需求" | 必须问过才能确认 |
| "影响分析等做方案时再说" | 方案设计依赖这些约束，提前澄清减少返工 |
| "这些问题用户会觉得烦" | 前期多问几个问题远好过后期推翻重来 |
</HARD-GATE>
