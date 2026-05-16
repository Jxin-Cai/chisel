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
| `understand:confirm` | 展示 as-is 摘要（重点呈现 overview 的待澄清问题），等用户回答后将澄清写入 `{IDEA_DIR}/clarifications.md`（无需澄清则创建空文件），用户确认后 `touch {IDEA_DIR}/.as-is-confirmed`；对话中执行实时知识捕获协议 | `as-is-confirmed` |
| `understand:generate-ai-input` | 基于已确认的 as-is 人类学习版，生成 `{IDEA_DIR}/as-is/ai-input/` 下 6 个结构化文件（参考 `${CLAUDE_PLUGIN_ROOT}/skills/chisel-help/references/ai-input-template.md`）。数据来源：overview.md、core-walkthrough.md、details/*（如有）、clarifications.md | `ai-input-ready` |
| `plan:design` | `/chisel-plan <idea-name>` | `to-be-exists` |
| `plan:confirm` | 展示 to-be 摘要，等用户确认后 `touch {IDEA_DIR}/.to-be-confirmed`；对话中执行实时知识捕获协议 | `to-be-confirmed` |
| `tasks:init` | 拆 task 文件 + `workflow-status.mjs --init-tasks` | `task-workflow-exists` |
| `implement:code` | `/chisel-implement <idea-name>` | `task-report-exists` |
| `review:cr` | `/chisel-review <idea-name>` | `cr-complete` |
| `repair:code` | `/chisel-implement <idea-name>`（返修模式） | `task-report-exists` |
| `knowledge:extract` | 从本次迭代产物和实时捕获中提取知识候选，去重后写入 `{IDEA_DIR}/knowledge-candidates/`；用户确认后调用 `wiki-manage.mjs --merge` 合入 wiki，再调用 `wiki-rule-inject.mjs` 激活 rule；完成后 `touch {IDEA_DIR}/.knowledge-extracted` | `knowledge-extracted` |
| `final:summary` | 汇总变更 + 呈现知识候选 + wiki 更新情况 + `touch {IDEA_DIR}/.done` | `done` |
| `blocked` | 停止，报告阻塞原因 | — |
| `done` | 报告完成 | — |

当同时存在待 CR、待返修和待编码任务时，优先清空 review / rework backlog，再进入新 coding。

---

## Task 初始化

当 `resume_step` = `tasks:init`：

1. Read `{IDEA_DIR}/to-be/implementation-plan.md` 中的 task 拆分建议
2. 在 `{IDEA_DIR}/tasks/` 下创建 task 文件（参考 `${CLAUDE_PLUGIN_ROOT}/skills/chisel-help/references/task-template.md`）
3. 调用 `workflow-status.mjs {IDEA_DIR} --init-tasks <idea-name> "task-001:dep1,dep2:描述:tasks/task-001.md:src/a.ts,src/b.ts" ...`；最后一段是该 task 的 expected_files，可为空但不应省略已知修改范围。

---

## Wiki 感知

如果 `.chisel/wiki/index.md` 存在，说明项目已有长期知识沉淀。

- as-is 阶段：explorer 应参考 wiki 中的禁区、包袱、坏味道、术语，但以代码事实为准。
- to-be 阶段：planner 应在方案中引用 wiki 的禁区和包袱，明确允许/禁止修改范围。
- task 创建时：填写 `Context to Load` 引用 wiki 相关文件。
- CR 阶段：reviewer 应检查是否触碰了 wiki 中登记的禁区或包袱。

不要一次性加载整个 wiki。按需读取当前阶段相关的文件。

---

## Knowledge Candidate 提取

当 `resume_step` = `knowledge:extract`：

1. 扫描 `{IDEA_DIR}/as-is/knowledge-candidates.md`、`{IDEA_DIR}/task-reports/`、`{IDEA_DIR}/cr/` 中与禁区、包袱、坏味道、术语相关的发现
2. 扫描 `{IDEA_DIR}/knowledge-candidates/` 目录下所有独立候选文件（`fz-*.md`、`wbi-*.md`、`dnr-*.md`、`term-*.md`）——这些来自实时捕获和 agent 发现
3. 去重：不同来源的候选可能重叠，按 name/scope 去重
4. 参考以下模板（按需 Read，不要一次全加载）：
   - `${CLAUDE_PLUGIN_ROOT}/skills/chisel-help/references/knowledge-candidates-template.md` — 候选文件结构
   - `${CLAUDE_PLUGIN_ROOT}/skills/chisel-help/references/forbidden-zones-template.md` — 禁区格式
   - `${CLAUDE_PLUGIN_ROOT}/skills/chisel-help/references/weird-but-intentional-template.md` — 包袱格式
   - `${CLAUDE_PLUGIN_ROOT}/skills/chisel-help/references/do-not-refactor-yet-template.md` — 坏味道格式
   - `${CLAUDE_PLUGIN_ROOT}/skills/chisel-help/references/glossary-template.md` — 术语格式
5. 在 `{IDEA_DIR}/knowledge-candidates/` 下补充或更新候选文件
6. 呈现合并后的候选摘要给用户，逐条确认
7. 用户确认的候选，为每条创建单独的 JSON 文件（含 `category` 和 `content` 字段），然后调用 `node ${CLAUDE_PLUGIN_ROOT}/scripts/wiki-manage.mjs --merge . <candidate.json>` 合入 wiki
8. 合入完成后调用 `node ${CLAUDE_PLUGIN_ROOT}/scripts/wiki-rule-inject.mjs .` 确保 rule 激活
9. 如果 `.chisel/wiki/` 还不存在且候选内容足够，先调用 `node ${CLAUDE_PLUGIN_ROOT}/scripts/wiki-manage.mjs --init .` 初始化 wiki
10. 完成后 `touch {IDEA_DIR}/.knowledge-extracted`

---

## 实时知识捕获协议

在 `understand:confirm` 和 `plan:confirm` 与用户对话过程中，主动监听以下知识信号并即时捕获：

| 信号类型 | 触发模式 | 动作 |
|---------|---------|------|
| 禁区 | "不能动"、"别改"、"不要碰"、"需要确认才能改" | 写入 `{IDEA_DIR}/knowledge-candidates/fz-*.md` |
| 包袱 | "历史原因"、"不得不这样"、"看起来奇怪但是对的" | 写入 `{IDEA_DIR}/knowledge-candidates/wbi-*.md` |
| 坏味道 | "以后再改"、"先不处理"、"知道不好但现在不动" | 写入 `{IDEA_DIR}/knowledge-candidates/dnr-*.md` |
| 术语映射 | 用户解释业务概念与系统/代码概念的对应关系 | 写入 `{IDEA_DIR}/knowledge-candidates/term-*.md` |

每个候选文件使用 `knowledge-candidates-template.md` 格式。标注 `source_step` 和 `confirmed: false`。

候选文件由 `knowledge:extract` 阶段统一扫描和去重，不需要在对话中调用脚本。

---

## AI 输入版生成

当 `resume_step` = `understand:generate-ai-input`：

1. Read `${CLAUDE_PLUGIN_ROOT}/skills/chisel-help/references/ai-input-template.md`
2. 基于 `{IDEA_DIR}/as-is/` 下已确认的人类学习版文档，提取结构化信息
3. 在 `{IDEA_DIR}/as-is/ai-input/` 下生成 6 个文件：
   - `facts.md` — 从 overview 核心事实 + core-walkthrough 提取已确认事实清单
   - `call-graph.md` — 从 core-walkthrough 时序图提取结构化调用关系表
   - `data-schema.md` — 从 details/data-model（或 core-walkthrough 内联数据部分）提取表/字段/关系
   - `api-surface.md` — 从 details/api-contracts（或 core-walkthrough 内联接口部分）提取接口签名
   - `constraints.md` — 从 overview 禁区/包袱/坏味道 + clarifications.md 提取约束
   - `change-surface.md` — 从 core-walkthrough safe-to-change area 提取可修改范围
4. 运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/gate-check.mjs {IDEA_DIR} ai-input-ready` 验证

---

## 合理化预防

<HARD-GATE>
Read `${CLAUDE_PLUGIN_ROOT}/skills/_shared/references/rationalization-prevention.md`，熟记其中所有条目。
</HARD-GATE>
