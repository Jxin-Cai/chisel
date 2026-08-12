---
name: chisel-clarify
description: 当 chisel 编排器进入 clarify:requirement 阶段时触发。
argument-hint: "<idea-name>"
user-invocable: false
---

# chisel-clarify

需求澄清阶段。把用户初始输入、后续追加消息和澄清回答综合为一份开发就绪、由用户明确确认的
`requirement.md`。后续所有阶段把这份文档视为唯一权威需求；原始输入和逐轮回答只作为追溯证据。
as-is 已存在时作为增强证据，但不得把深度代码分析作为澄清前置条件。不做方案设计，不改业务代码。

## 当前工作流状态

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-snapshot.mjs 2>/dev/null || echo "无活跃工作流"`

## 输入

| 来源 | 读取 |
|------|------|
| `{IDEA_DIR}/requirement-original.md` | 用户最初输入的不可变快照；首次进入本阶段时由脚本创建 |
| `{IDEA_DIR}/requirement-inputs.json` | 初始输入、澄清回答、Codex steer/queued 追加消息及 NEEDS_CONTEXT 回答的追加式账本 |
| `{IDEA_DIR}/requirement.md` | 澄清前是临时草稿；用户确认后是所有下游阶段的权威需求 |
| `{IDEA_DIR}/as-is/overview.md`（如存在） | 当前系统能力边界、风险地图 |
| `{IDEA_DIR}/clarifications.json` | understand:confirm 阶段的 as-is 澄清结论 |
| `{IDEA_DIR}/as-is/ai-input/`（如存在） | 必读 facts.md + constraints.md；按维度按需读 call-graph/data-schema/api-surface/change-surface |

## 开发就绪度模型

以下维度是模型的检查清单，不是机械问卷。模型先判断哪些信息会改变实现或验收，只追问真实缺口：

- 目标与业务结果
- IN/OUT scope、用户可见行为与主路径
- 边界、异常和失败行为
- 兼容性、不变量、接口和数据约束
- 权限、安全、隐私、性能、并发和可观测性（仅在相关时）
- 优先级、允许推迟项和风险容忍度
- 可执行的 AC/VC
- 假设、非目标和未决问题

模型拥有问题选择权和措辞权。已有信息足够时不要为了覆盖维度而提问；低风险实现细节可以提出推荐默认值，
写入最终需求供用户一次确认。以下内容不得由模型静默决定：业务语义、兼容性破坏、数据迁移、权限与安全、
不可逆操作、范围冲突以及无法验证的验收标准。

每轮优先提出 1-4 个最高信息增益的问题。用户回答后重新做完整 gap analysis，而不是只处理上一轮问题。
直到未决问题为空、AC/VC 可验证且高风险决策已有用户答案，再生成最终需求草稿。

## 执行流程

1. 运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/requirement-context.mjs {IDEA_DIR} --init`。必须在重写
   `requirement.md` 前执行，以冻结 `requirement-original.md` 并初始化 `requirement-inputs.json`
2. Read `requirement-original.md`、`requirement-inputs.json` 和当前 `requirement.md`
3. 如存在则 Read `{IDEA_DIR}/as-is/overview.md`；不存在时从需求本身分析缺口，不启动 Explore/Analyst 补齐
4. Read `{IDEA_DIR}/clarifications.json`（如存在）
5. 如存在 `{IDEA_DIR}/as-is/ai-input/`：
   - 必读：`facts.md`（事实锚点）+ `constraints.md`
   - 按维度按需读：
     - 影响分析 → `call-graph.md` + `change-surface.md`
     - 兼容性约束 → `api-surface.md` + `data-schema.md`
     - 非功能需求 → `change-surface.md`
6. 对开发就绪度做 gap analysis；仅针对会改变实现或验收的缺口使用 `AskUserQuestion`，每批不超过 4 个
7. 每次收到用户回答、steer/queued 追加消息或恢复自 NEEDS_CONTEXT 的答案时，把原文追加到
   `requirement-inputs.json`；不得只保留在对话上下文。若使用脚本，先把原文写入临时文件，再运行
   `requirement-context.mjs {IDEA_DIR} --append-file <file> --kind <clarification_answer|user_addition|needs_context> --source-step <step>`
8. 重新分析所有输入；必要时继续追问，直到开发就绪
9. Read `${CLAUDE_PLUGIN_ROOT}/skills/chisel-clarify/references/requirement-clarification-template.md` 和
   `${CLAUDE_PLUGIN_ROOT}/skills/chisel-clarify/references/canonical-requirement-template.md`
10. 写入 schema v2 的 `{IDEA_DIR}/requirement-clarification.json` 和人类可读审计镜像
11. 综合所有有效输入，按模板覆盖写入 `{IDEA_DIR}/requirement.md`。不得只追加答案，也不得留下“初步”、
    TBD、待确认或相互冲突的描述
12. 将 `requirement.md` 的完整内容和 sha256 返回给用户审阅，明确说明这是后续开发的唯一需求基线，然后结束当前 turn
13. 用户要求修改时，先记录追加输入，重新生成完整文档并再次展示；用户明确确认当前 hash 后运行：
    `node ${CLAUDE_PLUGIN_ROOT}/scripts/requirement-context.mjs {IDEA_DIR} --confirm --expected-sha <sha256>`
14. 运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/gate-check.mjs {IDEA_DIR} clarification-complete`
15. gate 通过后调用权威 runner 推进到 `classify:requirement`。分级产物绑定权威需求、澄清证据和确认凭据；不得沿用 stale 结果

<HARD-GATE principle="P1,P2">
此步骤澄清的是需求本身的诉求和边界，不是 as-is 理解的正确性（那是 understand:confirm 的职责）。
不要用固定问题数量代替判断。模型应主动发现缺口、合并重复问题并提供低风险默认建议；最终由用户对完整
`requirement.md` 一次性确认。确认凭据绑定原始输入、追加输入、澄清记录和最终需求，任一变化都会失效。
有 as-is 时，问题要基于实际发现的事实并追溯到 facts.md 的 F-xxx、constraints.md 的 FZ/WBI/DNR 或具体文件位置。没有 as-is 时，问题必须追溯到 requirement.md 的章节/AC，禁止伪造 F-xxx 或为了引用证据而启动 Explore/Analyst。

合理化预防表：

| 你的想法 | 现实 |
|---------|------|
| "每个维度都问一遍最稳妥" | 机械问卷制造噪音；只问会改变结果的缺口，最后确认完整需求 |
| "这条追加消息只和当前 agent 有关" | 用户输入必须先落盘，再决定是局部提示还是需求变更 |
| "影响分析等做方案时再说" | 方案设计依赖这些约束，提前澄清减少返工 |
| "最终 MD 可以由 clarification JSON 代替" | JSON 是追溯证据；用户确认的 requirement.md 才是下游语义源 |
</HARD-GATE>
