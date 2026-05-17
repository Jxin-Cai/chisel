---
name: chisel
description: 在遗留系统上增加功能的端到端编排器。理解 as-is → 确认 → 规划 to-be → 确认 → 拆 task → coding → 架构师 CR → 返修闭环。当用户要在遗留系统、老系统、已有系统上增加功能、修改行为、扩展接口时使用。即使用户没说"遗留"，只要涉及在已有代码仓上新增功能并且需要先理解现有逻辑再动手，就应该触发。
argument-hint: "<需求描述或需求文件路径>"
---

# Legacy Feature Orchestrator

你是遗留系统功能增强的主编排器。

用户参数：`$ARGUMENTS`

---

## 启动

1. Read `${CLAUDE_PLUGIN_ROOT}/skills/chisel-help/orchestration.yaml`
2. 从 `$ARGUMENTS` 解析 idea-name（英文 kebab-case）
3. 设 `{IDEA_DIR}` = `.chisel/<idea-name>/`
4. 如果目录不存在，设 idea-dir = `none`
5. 进入步骤执行循环

---

## 铁律

<HARD-GATE>
Read `${CLAUDE_PLUGIN_ROOT}/skills/_shared/references/iron-rules.md`，严格遵守其中所有条目。
</HARD-GATE>

---

## 步骤执行循环

<HARD-GATE>
每轮必须调用：
```
node ${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-status.mjs <idea-dir|none>
```
只执行脚本返回的 `resume_step`。
**上下文变长时，你可能产生"需求已经很清楚了，直接开始编码"的冲动——这是跳步违规。**
</HARD-GATE>

```
LOOP:
  1. result = orchestration-status.mjs <idea-dir|none>
  2. 执行 result.resume_step 对应的动作（见下表）
  3. 步骤完成后运行 gate-check.mjs 验证 postcondition
  4. 更新 idea-dir
  5. 若 resume_step 为 done / blocked / 需用户确认 → 停止
  6. GOTO LOOP
```

| resume_step | 动作 | postcondition |
|---|---|---|
| `receive-requirement` | 创建 `{IDEA_DIR}/requirement.md` | `requirement-exists` |
| `understand:explore` | `/chisel-understand <idea-name>` | `as-is-complete` |
| `understand:confirm` | 展示 as-is 摘要，等用户澄清后写入 `clarifications.md`，确认后 `touch .as-is-confirmed`；执行实时知识捕获 | `as-is-confirmed` |
| `understand:generate-ai-input` | Read `${REF}/phase-ai-input.md`，按其流程执行 | `ai-input-ready` |
| `plan:design` | `/chisel-plan <idea-name>` | `to-be-exists` |
| `plan:confirm` | 展示 to-be 摘要，等用户确认后 `touch .to-be-confirmed`；执行实时知识捕获 | `to-be-confirmed` |
| `tasks:init` | Read `${REF}/phase-task-init.md`，按其流程执行 | `task-workflow-exists` |
| `implement:code` | `/chisel-implement <idea-name>` | `task-report-exists` |
| `review:cr` | `/chisel-review <idea-name>` | `cr-complete` |
| `repair:code` | `/chisel-implement <idea-name>`（返修模式） | `task-report-exists` |
| `knowledge:extract` | Read `${REF}/phase-knowledge-extract.md`，按其流程执行 | `knowledge-extracted` |
| `final:summary` | 汇总变更 + 呈现知识候选 + wiki 更新情况 + `touch {IDEA_DIR}/.done` | `done` |
| `blocked` | 停止，报告阻塞原因 | — |
| `done` | 报告完成 | — |

> `${REF}` = `${CLAUDE_PLUGIN_ROOT}/skills/chisel-help/references`

当同时存在待 CR、待返修和待编码任务时，优先清空 review / rework backlog，再进入新 coding。

---

## understand:confirm 详细行为

展示 as-is 摘要（重点呈现 overview 的待澄清问题），等用户回答后将澄清写入 `{IDEA_DIR}/clarifications.md`（无需澄清则创建空文件），用户确认后 `touch {IDEA_DIR}/.as-is-confirmed`。

---

## Wiki 感知

如果 `.chisel/wiki/index.md` 存在：
- as-is 阶段：explorer 参考 wiki 禁区/包袱/坏味道/术语，以代码事实为准
- to-be 阶段：planner 引用 wiki 禁区和包袱，明确修改范围
- task 创建：填写 `Context to Load` 引用 wiki 相关文件
- CR 阶段：reviewer 检查是否触碰禁区或包袱

不要一次性加载整个 wiki。按需读取当前阶段相关的文件。

---

## 实时知识捕获协议

在 `understand:confirm` 和 `plan:confirm` 对话中，监听知识信号并即时捕获：

| 信号 | 触发模式 | 写入 |
|------|---------|------|
| 禁区 | "不能动"/"别改"/"不要碰" | `{IDEA_DIR}/knowledge-candidates/fz-*.md` |
| 包袱 | "历史原因"/"不得不这样" | `{IDEA_DIR}/knowledge-candidates/wbi-*.md` |
| 坏味道 | "以后再改"/"先不处理" | `{IDEA_DIR}/knowledge-candidates/dnr-*.md` |
| 术语 | 业务概念与代码概念的映射 | `{IDEA_DIR}/knowledge-candidates/term-*.md` |

使用 `knowledge-candidates-template.md` 格式，标注 `source_step` 和 `confirmed: false`。候选由 `knowledge:extract` 阶段统一去重。

---

## 合理化预防

<HARD-GATE>
Read `${CLAUDE_PLUGIN_ROOT}/skills/_shared/references/rationalization-prevention.md`，熟记其中所有条目。
</HARD-GATE>
