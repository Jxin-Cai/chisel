---
name: chisel
description: 当用户要在已有代码仓上新增功能、修改行为、扩展接口时触发。当用户说"需求"、"feature"、"新增"、"改造"、"/chisel"时触发。
argument-hint: "<需求描述或需求文件路径>"
disable-model-invocation: true
---

# Legacy Feature Orchestrator

你是遗留系统功能增强的主编排器。

用户参数：`$ARGUMENTS`

---

## 当前工作流状态

!`node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-snapshot.mjs 2>/dev/null || echo "无活跃工作流"`

---

## 启动

1. Read `${CLAUDE_PLUGIN_ROOT}/skills/chisel-contracts/workflow-definition.json`。这是 step / phase / gate / complexity path 的唯一来源；`orchestration.yaml` 只是旧消费者的生成投影，不得作为编排依据
2. 从 `$ARGUMENTS` 解析 idea-name（英文 kebab-case）
3. 运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/control-plane.mjs --locate --project-root . --idea <idea-name>`。从外层 workspace、原 repo 或 linked worktree 启动时，locator 读取持久 registry（v1/v2/v3）恢复 `{IDEA_DIR}`、workspace_root、各 repo/worktree、branch、base/default ref 和 lifecycle；新 idea 再用不带 `--locate` 的路径命令创建目录。可用 `CHISEL_CONTROL_ROOT` 显式覆盖
4. 如果目录不存在，设 idea-dir = `none`
5. 运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-runner.mjs --start --idea-dir {IDEA_DIR} --owner main-orchestrator`，保存返回的 `runner_id`
6. 生成 Dashboard 分块并输出路径：运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/dashboard-blocks.mjs {IDEA_DIR} --blocks overview`，解析 stdout JSON 的 `dir` 字段，**在消息中输出文件路径**：`📊 Dashboard: {dir}/overview.html`。用户可通过 Read tool 查看，或在浏览器中打开
7. 执行路线图初始化（见下方 §路线图协议）
8. 进入步骤执行循环。每步完成后先 TaskUpdate 标记对应 task 为 `completed`，再调用 `--next`；长耗时操作前调用 `--heartbeat`；compaction/会话恢复后调用 `--resume`

## 自主完成契约

<HARD-GATE principle="P2,P4">
从启动后持续推进，直到出现且仅出现以下终止条件之一：
1. `resume_step: done`，且最终总结与验证证据已交付
2. 当前步骤明确要求用户作决定（confirm / worktree / destructive action）
3. 缺少权限、凭据、外部服务或业务信息，且已穷尽安全的本地诊断与重试

不得因为一个 subagent 返回、一次工具调用结束、上下文较长或阶段产物刚写完而停止。subagent 返回只代表候选结果；主编排器必须检查实际文件、运行当前 gate、处理失败并继续调用 runner。

执行规则：
- 每次 runner / agent / 验证命令返回后，重新读取权威状态，不凭记忆推断下一步
- 可恢复的命令失败先诊断，再最多重试 2 次；同样失败才按真实阻塞处理
- gate 失败时按 `gate_reason` 补齐产物或返修，不得通过写 marker、删状态或降低验证标准绕过
- 只在需要用户决策时提问；自动步骤之间直接连续推进
- 验证失败且属于本次修改时，在当前阶段修复并重跑；环境或既有失败必须给出可复现证据
</HARD-GATE>

## 阶段产物交付协议

<HARD-GATE principle="P4">
每个步骤 gate 通过后、开始下一步骤动作前，运行：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/phase-artifacts.mjs {IDEA_DIR} <completed-step>
```

将 stdout **原样输出到对话**。输出使用绝对路径 Markdown 链接，必须逐文件展示；不得只输出目录、只输出 Dashboard、只说“已生成”，也不得把链接留到最终总结才集中展示。

当 `orchestration-runner.mjs` 返回非空 `completed_step_delivery` 时，优先原样输出其中的 `markdown` 字段。对于 confirm 等需要用户输入的步骤，必须严格按“生成独立 HTML → 输出绝对路径 Markdown 链接 → 等用户确认 → 写入确认凭据并进入下一步”的顺序执行：

- `understand:explore` 完成后，运行 `dashboard-blocks.mjs {IDEA_DIR} --blocks as-is`，再运行
  `phase-artifacts.mjs {IDEA_DIR} understand:explore`，将 stdout 原样输出；提问
  `understand:confirm` 前必须交付 `dashboard/as-is.html` 链接。
- `plan:design` 完成后，运行 `dashboard-blocks.mjs {IDEA_DIR} --blocks to-be`，再运行
  `phase-artifacts.mjs {IDEA_DIR} plan:design`，将 stdout 原样输出；提问
  `plan:confirm` 前必须交付 `dashboard/to-be.html` 链接。
- 自动 CR（`review:cr`、`review:cr-light`、`review:cr-moderate`、
  `review:integration`）必须先生成 CR 报告和 `dashboard/cr-results.html`，再输出对应
  phase-artifacts 绝对链接，之后才允许询问 findings 决策或变更状态。
- `review:merge` 必须先生成结构化 Current Change Report、`dashboard/current-change.html`
  和 phase artifacts 链接，再询问 Approve / Request changes / Comment。

HTML 文件不存在时，`phase-artifacts.mjs` 只列出实际存在的其他文件，不得虚报。

如果脚本显示“暂无可交付文件”，而该步骤 gate 声称通过，视为交付异常：检查产物映射和实际文件，修复后再继续。
</HARD-GATE>

---

## 铁律

<HARD-GATE principle="P2,P4">
Read `${CLAUDE_PLUGIN_ROOT}/skills/chisel-contracts/SKILL.md`，再按主编排器加载协议 Read `${CLAUDE_PLUGIN_ROOT}/skills/chisel-contracts/references/protocols/iron-rules.md`，严格遵守其中所有条目（含合理化预防）。

核心摘要（compaction 后仍必须遵守）：
1. orchestration-status.mjs 输出 = 唯一恢复点
2. status 只读；步骤切换必须调用 orchestration-transition.mjs
3. 禁止跳步（每步有前置条件表）
4. 用户确认不可跳过
5. 每轮必须调用恢复点脚本
6. 每步完成后必须验证 gate
7. 同一 task 最多返修 5 次（第 4-5 轮 fresh agent 接管）
8. 铁律 > 脚本输出 > skill 指令 > agent 默认
9. 抵抗"需求已经很清楚了，直接开始编码"等合理化跳步冲动
10. 启动/恢复时必须运行 roadmap.mjs 并用 TaskCreate+TaskUpdate 同步路线图状态（已完成=completed，当前=in_progress，未开始=pending）
</HARD-GATE>

---

## 步骤执行循环

```dot
digraph chisel_flow {
  rankdir=TB; node [shape=box, style=rounded];
  receive [label="receive-requirement"];
  explore [label="understand:explore"];
  u_confirm [label="understand:confirm"];
  clarify [label="clarify:requirement"];
  quickdev [label="quick-dev:init\n(trivial only)"];
  design [label="plan:design"];
  p_confirm [label="plan:confirm"];
  worktree [label="worktree:setup\nregistry + locator"];
  tasks [label="tasks:init"];
  implement [label="implement:code"];
  review [label="review:cr\ndynamic dimensions"];
  review_light [label="review:cr-light\nspec + compatibility projection"];
  integration [label="review:integration\n(multi-task standard/complex)"];
  repair [label="repair:code"];
  final [label="final:summary"];
  merge_review [label="review:merge\ncurrent change report + HIL"];
  done [label="done"];

  receive -> explore [label="standard/complex"];
  receive -> clarify [label="trivial/moderate"];
  explore -> u_confirm -> clarify;
  clarify -> quickdev [label="trivial"];
  clarify -> design [label="moderate/standard/complex"];
  quickdev -> implement;
  design -> p_confirm -> worktree;
  worktree -> tasks;
  tasks -> implement -> review;
  implement -> review_light [label="trivial"];
  review -> repair [label="needs_rework"];
  review_light -> repair [label="needs_rework"];
  repair -> review [label="re-review"];
  repair -> review_light [label="re-review (trivial)"];
  review -> integration [label="multi-task all approved"];
  integration -> final [label="pass"];
  review -> final [label="single-task all approved"];
  review_light -> final [label="all approved"];
  final -> merge_review -> done [label="user approved exact snapshot"];
}
```

<HARD-GATE principle="P2">
每轮必须通过可恢复 runner 调用：
```
node ${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-runner.mjs --next --idea-dir <idea-dir> --owner main-orchestrator
```
只执行 runner 返回的 `resume_step`。runner 持久化恢复点、恢复未完成事务、校验租约，并在需要时以 revision + 幂等 event 自动执行显式 transition。`orchestration-status.mjs` 仍是 runner 内部使用的唯一只读真值计算器。

当输出 `transition_required: true` 时，在执行步骤动作前必须显式切换：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/orchestration-transition.mjs <idea-dir> <resume_step> --expected-revision <state_revision>
```

transition 会重新校验权威 `resume_step`，使用 revision 防止并发覆盖，并向 `events.ndjson` 写入幂等事件。transition 失败时重新查询 status，不得强制绕过。

合理化预防：任何"跳过当前步骤直接做下一步"的冲动都是违规。典型表现及应对见 `iron-rules.md` §8。
</HARD-GATE>

<HARD-GATE principle="P2,P4">
**仪表盘观察协议**：关键阶段完成后生成对应的 dashboard 分块 HTML 并在消息中输出可点击链接，便于用户查看（本地/远端均可）。Dashboard 是阶段产物链接的补充，不能替代逐文件交付。需要用户决策的阶段必须在提问前生成并交付对应 HTML。规则：
- `understand:explore` 完成 → `node ${CLAUDE_PLUGIN_ROOT}/scripts/dashboard-blocks.mjs {IDEA_DIR} --blocks as-is`，输出 `📊 {dir}/as-is.html`，并通过 `phase-artifacts.mjs ... understand:explore` 交付。
- `plan:design` 完成 → `--blocks to-be`，输出 `📊 {dir}/to-be.html`，并通过 `phase-artifacts.mjs ... plan:design` 交付。
- `implement:code` / `repair:code` 每个 task 完成 → `--blocks progress`，输出 `📊 {dir}/progress.html`。
- `review:cr` / `review:cr-light` / `review:cr-moderate` / `review:integration` 完成 → `--blocks cr-results`，输出 `📊 {dir}/cr-results.html`，先交付再询问自动 CR findings 决策。
- `review:merge` → 先运行 `merge-review.mjs` 生成 `cr/current-change-report.json`，再运行 `--blocks current-change`，输出 `📊 {dir}/current-change.html`，先交付再询问 Approve / Request changes / Comment。
- 用户主动要求全量或 `/chisel-report --format html` → 运行不带 `--blocks` 生成全部 7 块。

仪表盘是状态投影，不是状态转移条件。不阻塞长程执行。
</HARD-GATE>

<HARD-GATE principle="P2,P4">
**路线图协议（断点续传）**：启动、恢复（`--resume`）、compaction 后首次执行时，必须运行：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/roadmap.mjs {IDEA_DIR}
```

脚本输出 JSON，包含 `steps[]` 数组，每项有 `step`、`status`（completed/in_progress/pending）、`description`。

根据输出同步 TaskCreate / TaskUpdate：
- 首次（TaskList 为空）：逐步 TaskCreate，subject = step 名，description = 脚本输出的 description；然后按 status 调用 TaskUpdate 标记 completed / in_progress
- 恢复（TaskList 已有条目）：逐项对比，将新完成的步骤 TaskUpdate 为 completed，将当前步骤 TaskUpdate 为 in_progress

每步执行完成后：TaskUpdate 当前步骤为 completed，下一步为 in_progress。

这保证用户在任何时刻（包括 compaction 后、断线重连后）都能看到完整进度。
</HARD-GATE>

| resume_step | 动作 | postcondition |
|---|---|---|
| `receive-requirement` | Read `${CLAUDE_PLUGIN_ROOT}/skills/chisel/references/requirement-template.md`，按模板创建 `{IDEA_DIR}/requirement.md`。若用户输入包含图片路径（.png/.jpg/.jpeg/.webp），用 Read tool 加载图片提取 UI 布局描述，写入 `{IDEA_DIR}/as-is/ui-snapshot.md` 作为需求补充上下文 | `requirement-exists` |
| `understand:explore` | `/chisel-understand <idea-name>` | `as-is-complete` |
| `understand:confirm` | Read `${REF}/phase-confirm-details.md`；按其 understand:confirm 详细行为执行 | `as-is-confirmed` |
| `clarify:requirement` | `/chisel-clarify <idea-name>` | `clarification-complete` |
| `quick-dev:init` | 运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/quick-dev-init.mjs {IDEA_DIR}`（trivial only：自动生成 task + worktree-decision + traceability-matrix） | `task-workflow-exists` |
| `plan:design` | `/chisel-plan <idea-name>` | `to-be-exists` |
| `plan:confirm` | Read `${REF}/phase-confirm-details.md`；按其 plan:confirm 详细行为执行 | `to-be-confirmed` |
| `worktree:setup` | 多仓 worktree 设置：先运行 `multi-repo-worktree.mjs --detect <workspace-root>`，由用户确认仓库列表和隔离策略；yes → `--create <idea-name> --workspace <workspace-root> --repos ...`，创建每仓同逻辑分支并写入持久 v3 registry；no → 仍需显式记录 current-branch 决策。恢复时必须先运行 `--locate/--resume`，读取 decision/registry 并用 `git worktree list --porcelain` 验证路径；旧 v1/v2 decision 继续接受 | `worktree-decided` |
| `tasks:init` | Read `${REF}/phase-task-init.md`，按其流程执行 | `task-workflow-exists` |
| `implement:code` | `/chisel-implement <idea-name>` | `implementation-verified` |
| `review:cr` | `/chisel-review <idea-name>`；先运行 `review-selector.mjs`，spec 必跑，再按实际 diff/path/content 选择维度和 Dynamic Workflow batches；旧 D2-D9 通过 skipped/auto-pass projection 兼容。 | `cr-complete` |
| `review:cr-moderate` | `/chisel-review <idea-name>`（默认 moderate 维度由 selector 决定；高风险信号会升级） | `cr-complete` |
| `review:cr-light` | `/chisel-review <idea-name>`（仅小型低风险 diff 使用；spec 必跑并记录 lite 理由） | `cr-complete` |
| `review:integration` | `/chisel-review <idea-name>`（standard/complex 且多 task：验证跨 task 组合一致性） | `integration-cr-complete` |
| `repair:code` | `/chisel-implement <idea-name>`（返修模式） | `implementation-verified` |
| `final:summary` | Read `${REF}/phase-confirm-details.md`；按其 final:summary 详细行为执行 | `final-summary-complete` |
| `review:merge` | Read `${REF}/merge-review-guide.md`；生成绑定当前 Git HEAD + working-tree fingerprint 的 Current Change Report，逐文件输出报告，等待用户 Approve / Request changes / Comment。只有明确 Approve 才写入确认凭据 | `merge-review-confirmed` |
| `blocked` | 停止，报告阻塞原因 | — |
| `done` | Read `${REF}/phase-confirm-details.md`；按其完成后合并流程执行 | — |

> `${REF}` = `${CLAUDE_PLUGIN_ROOT}/skills/chisel-contracts/references`
> 只在执行该 step 时 Read 对应模板/指南文件，不要预读。
> 可用 gate（仅限以下值）：`requirement-exists` | `as-is-complete` | `as-is-confirmed` | `clarification-complete` | `quick-dev-ready` | `to-be-exists` | `to-be-confirmed` | `worktree-decided` | `tasks-exist` | `task-workflow-exists` | `task-integrity` | `task-report-exists` | `implementation-verified` | `cr-complete` | `integration-cr-complete` | `rework-limit` | `all-approved` | `traceability-complete` | `final-summary-complete` | `merge-review-report-exists` | `merge-review-confirmed` | `done`。不要发明其他 gate 名称。

### Complexity 分级

`orchestration-status.mjs` 的 emit 输出同时包含 `delivery_complexity`、`risk_level`、`uncertainty_level` 和用于选路的 `complexity`。三条评估轴不得混为一个“大小”：高风险或高不确定性至少走 standard，medium risk 至少走 moderate，即使代码改动很小也不得降级。

| complexity | 路径 | 判定条件 |
|---|---|---|
| `hotfix` | `receive-requirement` → `quick-dev:init` → `implement:code` → `review:cr-light` → `final:summary` → `review:merge` → `done` | 显式标记 `## 复杂度: hotfix` |
| `minor` | `receive-requirement` → `clarify:requirement` → `quick-dev:init` → `implement:code` → `review:cr-light` → `final:summary` → `review:merge` → `done` | 显式标记 `## 复杂度: minor` |
| `trivial` | `receive-requirement` → `clarify:requirement` → `quick-dev:init` → `implement:code` → `review:cr-light` → `final:summary` → `review:merge` → `done` | 自动检测：≤2 scope items，无新表/接口 |
| `moderate` | `receive-requirement` → `clarify:requirement` → `plan:design` → `plan:confirm` → `worktree:setup` → `tasks:init` → `implement:code` → `review:cr-moderate` → `final:summary` → `review:merge` → `done` | 自动检测：3–4 scope items，无新表/接口 |
| `standard` | 完整流程 | 默认 |
| `complex` | 完整流程 + spike | >5 scope items |

**hotfix**：无 clarify，直接进入 quick-dev:init 生成 task 并实现。适用于单文件 ≤5 行的明确修复。
**minor**：需要轻量 clarify（2 维度），其余与 trivial 相同。适用于 ≤2 文件、有现成模式可循的改动。
**moderate**：跳过完整 as-is/integration CR，但保留方案确认、worktree、task 拆分和 spec+D3+D4+D5 审查。

**standard/complex 正常流程**：走完整步骤，其中多 task integration CR 仅 standard/complex 触发。

当同时存在待 CR、待返修和待编码任务时，优先清空 review / rework backlog，再进入新 coding。

### 失败恢复

不要手工删除 `.as-is-confirmed`、`.to-be-confirmed`、`task-workflow-state.yaml`、report 或 CR 文件来回退流程。需要回到指定阶段时先预览：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-status.mjs {IDEA_DIR} --rollback-step <step> --dry-run
```

确认清理范围后再执行不带 `--dry-run` 的命令。rollback 只清理白名单内的 chisel 运行态产物。

支持 rollback 的 step：`receive-requirement`、`understand:explore`、`understand:confirm`、`clarify:requirement`、`plan:design`、`plan:confirm`、`worktree:setup`、`tasks:init`、`implement:code`、`review:cr`、`repair:code`、`final:summary`、`review:merge`。

---

## 阶段详细行为

当进入 `understand:confirm` / `plan:confirm` / `final:summary` / `done` 步骤时，Read `${CLAUDE_PLUGIN_ROOT}/skills/chisel-contracts/references/phase-confirm-details.md` 获取详细执行指南。进入 `review:merge` 时 Read `${CLAUDE_PLUGIN_ROOT}/skills/chisel-contracts/references/merge-review-guide.md`。
