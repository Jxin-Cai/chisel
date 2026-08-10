# 铁律

以下规则不可违反、不可变通、不可因"合理理由"跳过。

---

## 设计原则

所有操作规则均派生自以下 5 条设计原则。修复 bug 时必须先识别违反了哪条原则，再从原则层面加固。

| # | 原则 | 定义 | 违规信号 | 自诊断问句 |
|---|------|------|----------|-----------|
| P1 | 穷举枚举 | 有限域的每个路由表/switch/map 必须覆盖全部变体；新增变体时原子更新所有消费者 | 新值在某个 map/matcher 中缺失 | 「我新增了变体，是否 grep 并更新了所有消费处？」 |
| P2 | 状态转移完整性 | 状态变更必须经由唯一正规函数并原子附带全部副作用；不存在旁路 | 旁路函数/遗漏副作用/重复递增 | 「此状态变更是否经过正规函数？所有耦合字段是否一起更新？」 |
| P3 | 边界快速失败 | 外部输入（文件读/CLI 参数/JSON parse/属性访问）在入口点即校验，不向下透传 undefined/null | 属性可能 undefined 但无防御 | 「如果此值为 undefined/null/畸形会怎样？入口有无 guard？」 |
| P4 | 副作用一致性 | 修改可观测状态 X 时，必须更新或失效所有读取 X 的下游消费者 | 关联文件/显示/guard 变得过时 | 「谁还在读我刚改的数据？它们是否仍看到一致状态？」 |
| P5 | 唯一正规来源 | 同一知识（枚举值/算法/配置）只在一处定义，其他处通过导入引用；禁止复制后微调 | 两处相似逻辑因独立演化产生分歧 | 「这段逻辑是否已在别处定义？我是导入还是复制？」 |

---

## 操作规则

### 1. 状态文件是唯一真相 `[P2, P5]`

`orchestration-status.mjs` 的输出是唯一的恢复点判定，`orchestration-runner.mjs` 是正常长程执行入口。
`task-workflow-state.yaml` 是 task 状态的唯一权威来源。  
status 严格只读；runner 持久化租约/恢复点并通过 `orchestration-transition.mjs` 显式更新（受控 rollback 是唯一例外，并同样递增 revision）。
不要依据上下文记忆、对话长度或自身推断来决定下一步。

### 2. 禁止跳步 `[P2]`

| 阶段 | 前置条件 |
|------|---------|
| 需求澄清 | `requirement.md` 完整；as-is 仅为可选增强证据，不得作为前置 |
| 难度分级 | 需求澄清完成；`requirement-classification.json` 必须可由 requirement + clarification（及 scope escalation）纯函数重算 |
| to-be 方案和 task 拆分 | 需求澄清和难度分级完成；lightweight 不依赖 as-is，full 必须先完成 as-is |
| to-be 对抗完整性审查 | `plan:design` 已完成；`to-be/adversarial-review.json` 必须 `status=pass` 且 `to-be-adversarial-approved` gate 通过 |
| worktree 决策 | to-be 方案已确认（`confirmations/to-be.json` 通过 gate） |
| task 初始化 | worktree 决策已完成（`worktree-decision.json` 通过 gate） |
| coding | task 初始化且 `--next-tasks` 返回该 task；quick route 还必须通过 `quick-dev-ready` |
| 需求级 CR | 所有 task 编码完成（无待编码、无待返修 task） |
| 返修 | CR 结论为 `needs_rework` 且返修次数 < 5 |
| 最终总结 | 所有 task 已批准且需求追溯完整 |
| 合并前 CR | 最终总结完成；验证和自动 CR 均通过且与当前 Git/workspace 快照一致 |
| done / 合并 | 用户对 Current Change Report 明确 Approve，且批准后的 HEAD、工作区、总结和报告均未变化 |

### 3. 用户确认不可跳过 `[P2, P4]`

`understand:confirm`、`plan:confirm` 和 `review:merge` 必须等用户明确确认后才能创建结构化确认文件；`plan:confirm` 之前必须先通过机器强制的 `plan:adversarial-review`，审查失败不得让用户 review。
旧 `.as-is-confirmed` / `.to-be-confirmed` marker 仅用于历史运行目录兼容，新流程不得只创建 marker。  
classified 新流程的 `confirmations/to-be.json` 必须绑定统一 `plan_fingerprint`；tasks、traceability、risk、design-notes、对抗审查、implementation-plan 或 Writer receipt 任一变化都必须重新确认。快速 scope 超限时写 `scope-escalation.json` 并重新分类，禁止继续 coding。
不要因"需求描述很清楚"而绕过确认。

### 4. 每轮循环必须调用恢复点脚本 `[P2]`

```
node ${SCRIPTS}/orchestration-runner.mjs --next --idea-dir <idea-dir> --owner main-orchestrator
```

只执行 runner 返回的 `resume_step`。runner 会使用输出中的 `state_revision` 自动执行：

```
node ${SCRIPTS}/orchestration-transition.mjs <idea-dir> <resume_step> --expected-revision <state_revision>
```

revision 冲突或权威 resume_step 变化时必须重新查询，禁止覆盖。

### 5. 每步完成后必须验证 gate `[P4]`

```
node ${SCRIPTS}/gate-check.mjs {IDEA_DIR} <gate-id>
```

gate 不通过时不能继续。

### 6. 返修上限 `[P2]`

同一 task 最多返修 5 次。超过后脚本会标记为 `blocked`，不得继续重试。
- 第 1-3 轮：同一 coder agent 返修（保留上下文连续性）
- 第 4-5 轮：启动 **fresh coder agent**（新上下文，更高级模型），明确告知"前任实现者已尝试 N 轮未通过，你完全接管"

### 7. 冲突优先级 `[P5]`

当多个指令来源冲突时，优先级从高到低：

1. 铁律（本文件）
2. 脚本输出（orchestration-status / gate-check）
3. 当前 skill 指令
4. agent 默认行为

### 8. 合理化预防 `[P2, P4]`

长上下文下你可能产生以下"合理"冲动——全部是跳步违规：

- 跳 as-is / 用户确认 / AI 输入版 / 独立 CR / report / 状态机步骤
- 先 code 再补 task（task 文件是 coder 的输入契约）
- gate pass 后跨步插入额外工作
- 文件不写只靠上下文（compaction 会截断）
- 违规并行（只有 `--next-tasks` 返回的无依赖 task 才能并行）

### 9. 原则驱动修复 `[P1–P5]`

修 bug 前必须先回答：**这个 bug 违反了哪条设计原则？** 然后：

1. `grep` 该原则的全部违规实例（同类问题），不止修眼前这一个
2. 判断应在哪层加固（脚本 > hook > prompt）——优先选结构性不可能而非文本提醒
3. 如果是 P1 类（枚举遗漏），运行 `enum-coverage-check.mjs` 确认无其他遗漏

### 10. Red Flags 自检 `[P2, P4]`

如果你脑中出现以下想法，立即停止——你正在合理化跳步：

| Red Flag 想法 | 你实际在做什么 |
|--------------|--------------|
| "这个 gate 肯定能过，先往下走" | 跳过验证 → 违反规则 5 |
| "上下文已经有结果了，不用再跑脚本" | 依赖记忆 → 违反规则 1 |
| "这太简单了不需要走完整流程" | 跳步 → 违反规则 2 |
| "用户应该不在意这个确认步骤" | 替用户决策 → 违反规则 3 |
| "顺便把旁边的问题也修了吧" | scope 越界 → coder 最常见返修原因 |
| "CR 的这个发现不太对，应该是误报" | 需要走 skeptic 验证，不是你单方面否决 |
| "文件已经存在了，不用再读模板" | 违反模板优先 → 违反 agent-protocol 规则 4 |
| "差不多了，可以声称完成了" | 无证据完成 → 违反规则 11 |
| "这轮返修应该能过，不用那么仔细" | 惰性修复 → 导致第 N+1 轮返修 |

遇到 Red Flag 时的正确动作：执行对应的规则/脚本/gate-check，用**实际输出**推翻或确认你的想法。

### 11. 无证据不声称完成 `[P4]`

任何"已完成"、"全部通过"、"可以继续下一步"的声明，必须附带**当次执行**的证据：
- gate-check 的实际输出（pass/fail + reason）
- 测试/构建命令的 exit code 和关键输出行
- `workflow-status.mjs --summary` 的实际打印

绝不允许：
- 引用"之前已经跑过"的结果（compaction 后可能是幻觉）
- 用"应该没问题"替代实际执行
- 仅凭"文件已存在"推断内容正确（文件可能是空的/旧的/损坏的）

违反此条 = 违反 P4（副作用一致性：你声称的状态与实际不一致）。
