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
6. 执行路线图初始化（见下方 §路线图协议）
7. 进入步骤执行循环。每步完成后先 TaskUpdate 标记对应 task 为 `completed`，再调用 `--next`；长耗时操作前调用 `--heartbeat`；compaction/会话恢复后调用 `--resume`

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

将 stdout **原样输出到对话**，不得修改、截断或重新拼接路径。脚本输出已使用绝对路径 Markdown 链接，必须逐文件展示；不得只输出目录、只说”已生成”、不得自行用 `{IDEA_DIR}` 等变量拼接路径替代脚本输出，也不得把链接留到最终总结才集中展示。

当 `orchestration-runner.mjs` 返回非空 `completed_step_delivery` 时，优先原样输出其中的 `markdown` 字段。报告分为非阻塞交付物和决策门禁：

- `understand:explore` 完成后运行 `reports.mjs {IDEA_DIR} --reports as-is`，从 JSON stdout 的 `generated[0].path`（绝对路径）构造链接并输出 SHA-256；As-Is 不单独停顿，随 To-Be 一起审阅。
- `plan:design` 与对抗审查完成后，运行 `reports.mjs {IDEA_DIR} --reports to-be`，从 JSON stdout 的 `generated[0].path`（绝对路径）构造链接并输出 SHA-256 后停止等待用户确认；确认后写入哈希凭据，再运行
  `phase-artifacts.mjs {IDEA_DIR} plan:design`，将 stdout 原样输出；提问
  `plan:confirm` 前必须交付报告绝对路径链接。
- `test:unit`、`review:cr-report`、`final:summary` 必须生成并输出各自 HTML 的绝对路径链接与 SHA-256（路径取自 `generated[0].path`），但不等待确认；报告新鲜性 gate 通过后自动推进。
- `review:merge` 必须先生成结构化合并审阅快照，把“当前代码做了什么”、精确 diff/验证/风险/决策
  合并进同一份 `reports/cr-report.html`，再询问 Approve / Request changes / Comment；不得另交付一份 Merge Review 报告。

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
4. To-Be 方案确认和最终 merge 快照确认不可跳过；其余报告是非阻塞交付物
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
  classify [label="classify:requirement\n(difficulty/profile/budget)"];
  quickdev [label="quick-dev:init\n(trivial only)"];
  design [label="plan:design"];
  adversarial [label="plan:adversarial-review\n(machine completeness gate)"];
  p_confirm [label="plan:confirm"];
  worktree [label="worktree:setup\nregistry + locator"];
  tasks [label="tasks:init"];
  implement [label="implement:code"];
  unittest [label="test:unit\ncoverage + anomaly repair + report"];
  review [label="review:cr\ndynamic dimensions"];
  review_light [label="review:cr-light\nspec + compatibility projection"];
  integration [label="review:integration\n(multi-task standard/complex)"];
  cr_report [label="review:cr-report\nafter all CR rework"];
  repair [label="repair:code"];
  final [label="final:summary"];
  merge_review [label="review:merge\ncurrent change report + HIL"];
  done [label="done"];

  receive -> clarify [label="all non-hotfix"];
  receive -> quickdev [label="bounded low-risk hotfix"];
  clarify -> classify;
  classify -> quickdev [label="minor/trivial direct"];
  classify -> design [label="moderate lightweight"];
  classify -> explore [label="standard/complex full"];
  explore -> u_confirm -> design;
  quickdev -> implement;
  design -> adversarial;
  adversarial -> p_confirm [label="pass"];
  adversarial -> design [label="findings / repair"];
  p_confirm -> worktree;
  worktree -> tasks;
  tasks -> implement -> unittest -> review;
  unittest -> review_light [label="trivial"];
  review -> repair [label="needs_rework"];
  review_light -> repair [label="needs_rework"];
  repair -> unittest [label="fresh unit tests + coverage"];
  review -> integration [label="multi-task all approved"];
  integration -> cr_report [label="pass"];
  review -> cr_report [label="single-task all approved"];
  review_light -> cr_report [label="all approved"];
  cr_report -> final [label="user confirmed final CR report"];
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
**独立 HTML 报告协议**：五类报告各自承载内容，不存在聚合页面。As-Is、Test、CR、Task-time 执行“生成 → 校验 source fingerprint → 输出链接 → 自动推进”；To-Be 执行“生成 → 输出链接 → 等用户明确确认 → 写入哈希凭据”。最终 merge approval 继续绑定当前 Git HEAD、working-tree fingerprint 和更新后的 CR HTML。

To-Be 用户明确确认后运行：
```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/report-confirm.mjs {IDEA_DIR} to-be --confirm --expected-sha <刚才输出的 sha256>
node ${CLAUDE_PLUGIN_ROOT}/scripts/report-confirm.mjs {IDEA_DIR} to-be
```

阶段规则：
- `understand:explore` 完成 → 生成 `as-is` 并校验报告源指纹，不单独等待确认。
- `plan:design` 与对抗审查完成 → 生成 `to-be`，输出报告绝对路径链接（取自 `generated[0].path`），等待确认；同时完成方案详细确认后，由 `to-be-report-confirmed` gate 校验报告哈希。
- 首轮 `test:unit` → 运行完整单测与覆盖率；返修轮运行受影响测试；全部 CR 通过后在最终 HEAD 上再运行一次完整测试与覆盖率封板。每轮报告生成后自动推进。
- `review:cr*` 只执行多维审查和返修闭环；全部 findings 修复并复审通过后进入 `review:cr-report`，生成 `cr` 后自动推进。
- `final:summary` 完成 → 生成 `task-time` 并自动进入 merge review。
- `review:merge` → 生成内部合并审阅快照后重新生成统一的 `cr` 报告，输出同一链接并等待 Approve / Request changes / Comment；`merge-review.mjs --confirm` 会把决定绑定到该 HTML 报告哈希。
- 用户主动要求全量报告时可按 As-Is → To-Be → 单测 → CR → 任务与耗时的顺序批量生成；只有 To-Be 决策仍需确认。

所有报告缺失或 source fingerprint 过期时必须停留在当前阶段并重新生成；只有 To-Be 缺少用户确认时需要停顿。
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
| `receive-requirement` | Read `${CLAUDE_PLUGIN_ROOT}/skills/chisel/references/requirement-template.md`，按模板创建临时 `{IDEA_DIR}/requirement.md`；澄清阶段会先将它冻结为 `requirement-original.md`，再以用户确认的完整需求覆盖。若用户输入包含图片路径（.png/.jpg/.jpeg/.webp），用 Read tool 加载图片提取 UI 布局描述，写入 `{IDEA_DIR}/as-is/ui-snapshot.md` 作为需求补充上下文 | `requirement-exists` |
| `understand:explore` | `/chisel-understand <idea-name>`；repo-map 识别 `source_files=0` 时走 greenfield 确定性快路径，不启动侦察 agent | `as-is-complete` |
| `understand:confirm` | 自动生成并交付 As-Is HTML；未决事项并入 To-Be 方案确认，不单独等待用户 | `as-is-report-confirmed` |
| `clarify:requirement` | `/chisel-clarify <idea-name>`；模型自主识别实质缺口，持久化追加输入，生成完整 `requirement.md` 并按 hash 获取用户确认 | `clarification-complete` |
| `classify:requirement` | 运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/requirement-classify.mjs {IDEA_DIR} .`，先生成有界仓库证据，再按真实候选文件/模块、风险与不确定性选路；展示 difficulty、execution_profile、reasons 和 subagent_budget | `requirement-classified` |
| `quick-dev:init` | 先执行轻量只读 discovery，写入非空 `quick-dev-scope.json`（`scope_mode=explicit`，含 `allowed_files`、`expected_files`、禁区和 AC）；超过 2 文件/2 模块、含宽泛 glob 或非低风险时写 `scope-escalation.json` 并回到 `classify:requirement`，不得继续实现。随后运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/quick-dev-init.mjs {IDEA_DIR}` | `quick-dev-ready` |
| `plan:design` | `/chisel-plan <idea-name>` | `to-be-exists` |
| `plan:adversarial-review` | 运行 fresh reviewer 对照 requirement/clarification/as-is 与全部 to-be 结构化产物；后台 reviewer 必须在当前 turn 用 `TaskOutput(task_id, block: true)` join，禁止只报告等待后停止；按实际结论写入 `to-be/adversarial-review.json`/`.md`。`fail` 必须修复 tasks/traceability/impact/implementation plan 后重跑，达到上限进入 `blocked` | `to-be-adversarial-approved` |
| `plan:confirm` | Read `${REF}/phase-confirm-details.md`；按其 plan:confirm 详细行为执行 | `to-be-report-confirmed` |
| `worktree:setup` | 多仓 worktree 设置：先运行 `multi-repo-worktree.mjs --detect <workspace-root>`，由用户确认仓库列表和隔离策略；yes → `--create <idea-name> --workspace <workspace-root> --repos ...`，创建每仓同逻辑分支并写入持久 v3 registry；no → 仍需显式记录 current-branch 决策。恢复时必须先运行 `--locate/--resume`，读取 decision/registry 并用 `git worktree list --porcelain` 验证路径；旧 v1/v2 decision 继续接受 | `worktree-decided` |
| `tasks:init` | Read `${REF}/phase-task-init.md`，按其流程执行 | `task-workflow-exists` |
| `implement:code` | quick route 必须先通过 `quick-dev-ready`；否则禁止启动 coder。其余路径运行 `/chisel-implement <idea-name>` | `implementation-verified` |
| `test:unit` | 首轮或最终封板运行 `verify-run.mjs --full`；返修轮运行 `verify-run.mjs --incremental`。每个本次需求测试 case 必须以需求 trace ref + Given/When/Then + 可捕获的业务 failure mode 描述，并由 fresh command 的 exit 0、唯一 PASS 输出片段和测试文件 hash 固化证据；修改/新增的每个测试文件至少有一个 case 证据。汇总后生成 test HTML，报告新鲜后自动推进 | `unit-test-report-confirmed` |
| `review:cr` | `/chisel-review <idea-name>`；先运行 `review-selector.mjs`，spec 必跑，再按实际 diff/path/content 选择维度和 Dynamic Workflow batches；findings 直接进入返修闭环，不提前生成最终 CR 报告。 | `cr-complete` |
| `review:cr-moderate` | `/chisel-review <idea-name>`（默认 moderate 维度由 selector 决定；高风险信号会升级） | `cr-complete` |
| `review:cr-light` | `/chisel-review <idea-name>`（仅小型低风险 diff 使用；spec 必跑并记录 lite 理由） | `cr-complete` |
| `review:integration` | `/chisel-review <idea-name>`（standard/complex 且多 task：验证跨 task 组合一致性） | `integration-cr-complete` |
| `review:cr-report` | 所有 findings 修复并复审通过、且最终全量验证绑定当前 HEAD 后，运行 `cr-report.mjs` 和 `reports.mjs --reports cr`；交付链接后自动推进 | `cr-report-confirmed` |
| `repair:code` | `/chisel-implement <idea-name>`（返修模式） | `implementation-verified` |
| `final:summary` | 生成最终总结与任务耗时报告，交付链接后自动推进 | `task-time-report-confirmed` |
| `review:merge` | Read `${REF}/merge-review-guide.md`；把绑定当前 Git HEAD + working-tree fingerprint 的合并审阅章节并入 CR 报告，讲清当前代码实现，等待用户 Approve / Request changes / Comment。只有明确 Approve 才写入确认凭据 | `merge-review-confirmed` |
| `blocked` | 停止，报告阻塞原因 | — |
| `done` | Read `${REF}/phase-confirm-details.md`；按其完成后合并流程执行 | — |

> `${REF}` = `${CLAUDE_PLUGIN_ROOT}/skills/chisel-contracts/references`
> 只在执行该 step 时 Read 对应模板/指南文件，不要预读。
> 可用 gate（仅限以下值）：`requirement-exists` | `clarification-complete` | `requirement-classified` | `as-is-complete` | `as-is-human-docs-ready` | `as-is-confirmed` | `as-is-report-confirmed` | `quick-dev-ready` | `to-be-exists` | `to-be-human-docs-ready` | `to-be-adversarial-approved` | `to-be-confirmed` | `to-be-report-confirmed` | `worktree-decided` | `tasks-exist` | `task-workflow-exists` | `task-integrity` | `task-report-exists` | `implementation-verified` | `unit-test-complete` | `incremental-verification-complete` | `verification-ready-for-review` | `unit-test-report-confirmed` | `cr-complete` | `cr-report-confirmed` | `integration-cr-complete` | `integration-cr-report-confirmed` | `rework-limit` | `all-approved` | `traceability-complete` | `final-summary-complete` | `task-time-report-confirmed` | `merge-review-report-exists` | `merge-review-confirmed` | `done`。不要发明其他 gate 名称。

### Complexity 分级

`orchestration-status.mjs` 的 emit 输出同时包含 `delivery_complexity`、`risk_level`、`uncertainty_level` 和用于选路的 `complexity`。三条评估轴不得混为一个“大小”：高风险或高不确定性至少走 standard，medium risk 至少走 moderate，即使代码改动很小也不得降级。

| complexity | 路径 | 判定条件 |
|---|---|---|
| `hotfix` | `receive-requirement` → `quick-dev:init` → `implement:code` → `test:unit` → `review:cr-light` → `review:cr-report` → `final:summary` → `review:merge` → `done` | 显式标记 `## 复杂度: hotfix` |
| `minor` | `receive-requirement` → `clarify:requirement` → `classify:requirement` → `quick-dev:init` → `implement:code` → `test:unit` → `review:cr-light` → `review:cr-report` → `final:summary` → `review:merge` → `done` | 澄清后 direct；≤2 文件/2 模块且低风险 |
| `trivial` | `receive-requirement` → `clarify:requirement` → `classify:requirement` → `quick-dev:init` → `implement:code` → `test:unit` → `review:cr-light` → `review:cr-report` → `final:summary` → `review:merge` → `done` | 澄清后 direct；超 scope gate 自动升级 |
| `moderate` | `receive-requirement` → `clarify:requirement` → `classify:requirement` → `plan:design` → `plan:adversarial-review` → `plan:confirm` → `worktree:setup` → `tasks:init` → `implement:code` → `test:unit` → `review:cr-moderate` → `review:cr-report` → `final:summary` → `review:merge` → `done` | lightweight，不依赖 as-is |
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

支持 rollback 的 step：`receive-requirement`、`understand:explore`、`understand:confirm`、`clarify:requirement`、`plan:design`、`plan:confirm`、`worktree:setup`、`tasks:init`、`implement:code`、`test:unit`、`review:cr`、`review:cr-report`、`repair:code`、`final:summary`、`review:merge`。

---

## 阶段详细行为

当进入 `understand:confirm` / `plan:confirm` / `final:summary` / `done` 步骤时，Read `${CLAUDE_PLUGIN_ROOT}/skills/chisel-contracts/references/phase-confirm-details.md` 获取详细执行指南。进入 `review:merge` 时 Read `${CLAUDE_PLUGIN_ROOT}/skills/chisel-contracts/references/merge-review-guide.md`。
