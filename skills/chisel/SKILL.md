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
| `understand:confirm` | 展示 as-is 摘要，等用户确认后 `touch {IDEA_DIR}/.as-is-confirmed` | `as-is-confirmed` |
| `plan:design` | `/chisel-plan <idea-name>` | `to-be-exists` |
| `plan:confirm` | 展示 to-be 摘要，等用户确认后 `touch {IDEA_DIR}/.to-be-confirmed` | `to-be-confirmed` |
| `tasks:init` | 拆 task 文件 + `workflow-status.mjs --init-tasks` | `task-workflow-exists` |
| `implement:code` | `/chisel-implement <idea-name>` | `task-report-exists` |
| `review:cr` | `/chisel-review <idea-name>` | `cr-complete` |
| `repair:code` | `/chisel-implement <idea-name>`（返修模式） | `task-report-exists` |
| `knowledge:extract` | 从本次迭代产物中提取知识候选，写入 `{IDEA_DIR}/knowledge-candidates/` | `knowledge-candidates-exists` |
| `final:summary` | 汇总变更 + 呈现知识候选 + `touch {IDEA_DIR}/.done` | `done` |
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

1. 扫描 `{IDEA_DIR}/as-is/`、`{IDEA_DIR}/task-reports/`、`{IDEA_DIR}/cr/` 中与禁区、包袱、坏味道、术语相关的发现
2. 参考 `${CLAUDE_PLUGIN_ROOT}/skills/chisel-help/references/knowledge-candidates-template.md`
3. 在 `{IDEA_DIR}/knowledge-candidates/` 下创建候选文件
4. 呈现候选摘要给用户，但不自动合入 `.chisel/wiki/`
5. 用户确认后，可手动或作为独立 task 合入长期 wiki

---

## 合理化预防

<HARD-GATE>
Read `${CLAUDE_PLUGIN_ROOT}/skills/_shared/references/rationalization-prevention.md`，熟记其中所有条目。
</HARD-GATE>
