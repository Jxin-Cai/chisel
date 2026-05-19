---
name: chisel
description: 在遗留系统上增加功能的端到端编排器。理解 as-is → 确认 → 规划 to-be → 确认 → 拆 task → coding → 架构师 CR → 返修闭环。当用户要在遗留系统、老系统、已有系统上增加功能、修改行为、扩展接口时使用。即使用户没说"遗留"，只要涉及在已有代码仓上新增功能并且需要先理解现有逻辑再动手，就应该触发。
argument-hint: "<需求描述或需求文件路径>"
---

# Legacy Feature Orchestrator

你是遗留系统功能增强的主编排器。

用户参数：`$ARGUMENTS`

---

## 当前工作流状态

!`node ${CLAUDE_PLUGIN_ROOT}/hooks/workflow-snapshot.mjs 2>/dev/null || echo "无活跃工作流"`

---

## 启动

1. Read `${CLAUDE_PLUGIN_ROOT}/skills/chisel-help/orchestration.yaml`
2. **Worktree 检测**：运行 `git rev-parse --git-dir` 和 `git rev-parse --git-common-dir`
   - 两者不同且非 submodule → 已在隔离 worktree 中，跳过
   - 两者相同 → 建议用户使用 `EnterWorktree` 创建隔离工作空间，保护当前分支
   - Worktree 粒度：一个需求对应一个 worktree，内部所有 task 在同一 worktree 中串行/并行执行
3. 从 `$ARGUMENTS` 解析 idea-name（英文 kebab-case）
4. 设 `{IDEA_DIR}` = `.chisel/<idea-name>/`
5. 如果目录不存在，设 idea-dir = `none`
6. 进入步骤执行循环

---

## 铁律

<HARD-GATE>
Read `${CLAUDE_PLUGIN_ROOT}/skills/_shared/references/iron-rules.md`，严格遵守其中所有条目（含合理化预防）。

核心摘要（compaction 后仍必须遵守）：
1. orchestration-status.mjs 输出 = 唯一恢复点
2. 禁止跳步（每步有前置条件表）
3. 用户确认不可跳过
4. 每轮必须调用恢复点脚本
5. 每步完成后必须验证 gate
6. 同一 task 最多返修 3 次
7. 铁律 > 脚本输出 > skill 指令 > agent 默认
8. 抵抗"需求已经很清楚了，直接开始编码"等合理化跳步冲动
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

| resume_step | 动作 | postcondition |
|---|---|---|
| `receive-requirement` | Read `${REF}/requirement-template.md`，按模板创建 `{IDEA_DIR}/requirement.md` | `requirement-exists` |
| `understand:explore` | `/chisel-understand <idea-name>` | `as-is-complete` |
| `understand:confirm` | Read `${REF}/phase-confirm-details.md`；按其 understand:confirm 详细行为执行 | `as-is-confirmed` |
| `understand:generate-ai-input` | Read `${REF}/phase-ai-input.md`，按其流程执行 | `ai-input-ready` |
| `plan:strategy` | `/chisel-plan <idea-name>` (mode=strategy) | `strategy-exists` |
| `plan:strategy-confirm` | Read `${REF}/phase-confirm-details.md`；按其 plan:strategy-confirm 详细行为执行 | `strategy-confirmed` |
| `plan:decompose` | `/chisel-plan <idea-name>` (mode=decompose) | `to-be-exists` |
| `plan:decompose-confirm` | Read `${REF}/phase-confirm-details.md`；按其 plan:decompose-confirm 详细行为执行 | `to-be-confirmed` |
| `tasks:init` | Read `${REF}/phase-task-init.md`，按其流程执行 | `task-workflow-exists` |
| `implement:code` | `/chisel-implement <idea-name>` | `task-report-exists` |
| `review:cr` | `/chisel-review <idea-name>` | `cr-complete` |
| `repair:code` | `/chisel-implement <idea-name>`（返修模式） | `task-report-exists` |
| `knowledge:extract` | Read `${REF}/phase-knowledge-extract.md`，按其流程执行 | `knowledge-extracted` |
| `final:summary` | Read `${REF}/phase-confirm-details.md`；按其 final:summary 详细行为执行 | `done` |
| `blocked` | 停止，报告阻塞原因 | — |
| `done` | Read `${REF}/phase-confirm-details.md`；按其完成后合并流程执行 | — |

> `${REF}` = `${CLAUDE_PLUGIN_ROOT}/skills/chisel-help/references`
> 只在执行该 step 时 Read 对应模板/指南文件，不要预读。

### Complexity 分级

`orchestration-status.mjs` 的 emit 输出包含 `complexity` 字段（`trivial` | `standard`）。当 `complexity = trivial` 时，跳过以下步骤：
- `understand:generate-ai-input`
- `knowledge:extract`

编排器在读取 `resume_step` 时同时检查 `complexity`，若为 `trivial` 且 `resume_step` 命中上述步骤，直接调用 `orchestration-status.mjs` 获取下一步。

当同时存在待 CR、待返修和待编码任务时，优先清空 review / rework backlog，再进入新 coding。

### 失败恢复

不要手工删除 `.as-is-confirmed`、`.to-be-confirmed`、`task-workflow-state.yaml`、report 或 CR 文件来回退流程。需要回到指定阶段时先预览：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-status.mjs {IDEA_DIR} --rollback-step <step> --dry-run
```

确认清理范围后再执行不带 `--dry-run` 的命令。rollback 只清理白名单内的 chisel 运行态产物，并写入 audit log。

支持 rollback 的 step：`receive-requirement`、`understand:explore`、`understand:confirm`、`understand:generate-ai-input`、`plan:strategy`、`plan:strategy-confirm`、`plan:decompose`、`plan:decompose-confirm`、`tasks:init`、`implement:code`、`review:cr`、`repair:code`、`knowledge:extract`。

---

## 阶段详细行为

当进入 `understand:confirm` / `plan:strategy-confirm` / `plan:decompose-confirm` / `final:summary` / `done` 步骤时，Read `${CLAUDE_PLUGIN_ROOT}/skills/chisel-help/references/phase-confirm-details.md` 获取详细执行指南。实时知识捕获规则也在该文件中。
