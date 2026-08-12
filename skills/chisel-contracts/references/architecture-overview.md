# Chisel 架构详细说明

## 设计原则

所有执法机制均派生自 5 条不可违反的设计原则（详见 `chisel-contracts/references/protocols/iron-rules.md`）：

- **P1 穷举枚举**：有限域路由表必须覆盖全部变体，新增变体原子更新所有消费者
- **P2 状态转移完整性**：状态变更经唯一正规函数，附带全部副作用
- **P3 边界快速失败**：外部输入在入口点即校验
- **P4 副作用一致性**：修改可观测状态时更新所有下游消费者
- **P5 唯一正规来源**：同一知识只定义一次，其他处导入

原则到执法机制的完整映射见 `chisel-contracts/references/protocols/principle-enforcement-map.md`。

## 架构要点

- 单一插件 `chisel`，主入口 skill 是 `/chisel`。
- 运行态产物写入 `control-plane.mjs` locator 解析的持久 control root `.chisel/<idea-name>/`；外层 workspace 可以非 Git，locator 会从外层、原 repo 或 linked worktree 读取 registry，恢复 workspace_root、各 repo/worktree、branch、base/default ref 和 lifecycle，也可用 `CHISEL_CONTROL_ROOT` 覆盖。
- `skills/chisel-contracts/workflow-definition.json` 是 step/phase/gate/complexity path 的唯一机器定义；脚本通过 `workflow-definition.mjs` 加载，不再复制枚举。
- `scripts/orchestration-status.mjs` 是严格只读的恢复点计算器；`orchestration-runner.mjs` 持久化 runner 租约、iteration 和最后决策，恢复事务后驱动显式 transition。
- `scripts/orchestration-transition.mjs` 是 workflow step 的唯一写入口：校验权威 resume step 与 expected revision，持有 transition lock，记录 `events.ndjson`，再更新任务与耗时报告投影。
- `scripts/workflow-status.mjs` 和 `scripts/workflow-lib.mjs` 管理 task 状态机；task state 与 provenance 通过 durable file transaction 原子提交。
- `scripts/task-provenance.mjs` 为每个 task/attempt 记录 `run_id`、owner、lease/heartbeat、执行前基线和执行后结果指纹；过期 lease 会留下 abandoned 审计记录，旧 run 不能提交。
- `scripts/verify-run.mjs` 将验证结果绑定到显式 `verification-contract.json` 以及当前 Git/workspace 指纹。
- `scripts/review-budget.mjs` 从 `review-policy.json` 生成有界 review batches、targeted skeptic 数量和并发上限；多维 findings 先全局汇总，再按风险选择性核验。
- `scripts/gate-check.mjs` 管理每步 postcondition。
- `plan:adversarial-review` 位于 `plan:design` 与 `plan:confirm` 之间：fresh reviewer 直接对照 requirement、clarification、as-is 和全部 to-be 结构化产物，写入 `to-be/adversarial-review.json`/`.md`；`to-be-adversarial-approved` gate 以机器规则阻断不完整方案，并在 findings 时回到 plan 修复循环。
- `scripts/scope-check.mjs` 阻止明确禁区，并把 starting_points 外扩展和异常 diff 范围作为 reviewer 风险信号；不再把计划文件列表当作修改边界。
- `scripts/multi-repo-worktree.mjs` 多仓 worktree 检测/创建/状态/清理（支持非 git 工作空间下的多 git 仓库场景）。
- `scripts/branch-merge.mjs` 在独立 integration worktree 中合并、验证、commit/push 和冲突现场管理，不切换已有主仓 checkout。
- `scripts/review-selector.mjs` 基于实际 diff/path/content 选择 review 风险与维度；spec 永远必跑，旧 D2-D9 通过 skipped/auto-pass projection 兼容。
- `scripts/repo-map.mjs` 产出语言统计、目录结构和前端框架/路由检测（无 LLM 依赖），explorer 探索前自动运行。
- `scripts/debt-scan.mjs` 纯静态技术债务扫描器（无 LLM 依赖），explorer 探索前自动运行，产出 proposed 候选。
- `scripts/repo-map.mjs` 同时输出 `project_mode`。当 `source_files=0` 时标记为 `greenfield`，`scripts/greenfield-as-is.mjs` 一次生成 N/A 基线并跳过 Explore/Analyst/Writer；交付复杂度和后续审查强度不因此降低。
- `scripts/as-is-score.mjs` AS_IS 产物多维质量评分（覆盖度/证据/不确定性/图表/结构/风险）；greenfield 的无历史代码维度按 N/A 处理，不要求伪造入口、调用链或 0/0 行覆盖率。
- `scripts/quick-dev-init.mjs` trivial 快速通道自动生成单 task + worktree-decision + traceability-matrix。
- `scripts/traceability-check.mjs` 需求→task 可追溯性验证，拒绝缺失/空 final matrix，精确检查 AC/VC 与 task refs 双向映射，并在 final 阶段前确认所有 AC 被覆盖实现。
- `scripts/cr-prepare.mjs` CR 预计算——Spec 通过后一次性收集 diff/scope-check 数据写入 `cr-context.json`，D2-D9 agent 共用。
- `scripts/merge-review.mjs` 在自动 CR/返修和 final summary 之后生成内部合并审阅快照，renderer 将当前实现、base/head、逐文件 diff 统计、验证命令、CR finding/observation、风险和 task 覆盖并入统一 CR 报告；人工批准绑定 Git HEAD、working-tree fingerprint、final summary 和报告内容，任一变化都会使批准失效。
- `scripts/reports.mjs` 生成五份自包含 HTML：As-Is、To-Be、单测覆盖率、CR、任务与耗时报告。每份报告独立承载内容。
- `scripts/session-metrics.mjs` 使用 schema v2 同时记录步骤墙钟时间与可测量 span，将 `human_wait`、`active_workflow`、`verification`、`report_generation`、`control_plane` 和 Agent 调用次数分开归因；任务与耗时报告直接展示该分解。
- `scripts/checkpoint.mjs` 关键阶段保存 schema v2 快照，同时按数量（8）和总大小（25 MiB）双重上限清理，runner/events/transaction journal 不进入快照 payload。
- **理解阶段**（`chisel-understand`）仅在 `execution_profile=full` 时使用 Explore + Analyst 产出结构化数据；人类文档由 `document-render.mjs` 确定性生成。
- **规划阶段**（`chisel-plan`）两条分支均写入 tasks + traceability + impact-risk + design-notes，执行完整性自检，再由确定性 renderer 生成 implementation-plan.md。
- `document-job.mjs` 继续记录 renderer 的完整 required source、optional source/output 及 hash；receipt stale 时重新渲染，不启动 Writer agent。
- `requirement-classify.mjs` 在澄清完成后按 AC/VC、文件/模块边界、DB/API/迁移、显式风险与 risk tolerance 生成可重算的难度、执行档位和 subagent 预算；显式 moderate/standard/complex 是保守 floor。
- `requirement-context.mjs` 在澄清前冻结 `requirement-original.md`，维护追加式 `requirement-inputs.json`，并把用户确认绑定到完整 `requirement.md` 及所有输入证据的指纹。schema v2 澄清流程中，任一后续用户输入都会使确认、分类及依赖它的计划失效。
- `coder-prepare.mjs` 为当前 task 生成 schema v5 轻量 bootstrap，只保存带 hash 的 requirement/task/decision 引用、检索种子、已发现路径和硬边界，不复制需求或源码正文。`context-query.mjs` 提供有界的 task 字段、CP/AC、源码命中和行区间读取。
- `agent-chisel-coder` 只按已确认 task 实现，并在自身上下文内按“未知项 → 搜索 → 局部读取 → 停止条件”循环补齐证据，持续执行验证—修复循环并完成 diff 自检。trivial/standard 默认继承主编排器当前模型，complex 和返修升级通过 model override 使用 opus。
- `agent-chisel-oracle` 在编码前只读取用户确认的权威 `requirement.md` 与公开入口，冻结 3–8 条可执行黑盒断言；它不读取澄清问答、plan/task/report/diff，不拥有 skill、状态机或 HTML 产物。全量验证后执行同一份断言，失败只作为 Coder 返修信号。
- `agent-chisel-reviewer` 通用 CR agent（opus），从功能 diff 出发审查，每次加载一个维度定义。维度 batch 严格受 `review-policy.json` 限制；所有维度结束后先由 Opus 全局汇总，只对高风险、矛盾或不确定项执行有界独立 skeptic 核验，再由 Opus 综合证据完成最终真伪裁决、共同根因合并和返修策略，完成前禁止返修。

## As-Is 分层结构

- **结构化产物**（Analyst Phase 2 产出）：`evidence-ledger.json`、`coverage-matrix.json`、`context-budget.json`、`ai-input/*.md`（facts/call-graph/data-schema/api-surface/constraints/change-surface/field-flow）
- **脚本产物**：`repo-map.json`（Phase 0）、`quality-score.json`（Phase 4）
- **人类文档**（renderer 产出）：`overview.md`、`core-walkthrough.md`、`evidence-index.md`、`context-budget.md`
- **枝干文件**（Writer 按需产出）：`details/entrypoints.md`、`details/data-model.md`、`details/api-contracts.md`、`details/data-flow.md`
- 结构化产物是核心数据源（供 Planner 和 gate 使用），人类文档由 renderer 二次生成（供用户阅读和独立 HTML 报告展示）。


## 并行开发

- Worktree 粒度为 per-requirement：一个需求对应一组 worktree（用户在 `worktree:setup` 选择），内部 task 串行/并行执行。
- **多仓支持**：工作空间可能是非 git 的目录，下包含多个独立 Git 仓库。一个需求可能跨多个仓库改动。`worktree:setup` 阶段通过 `multi-repo-worktree.mjs --detect` 扫描仓库，在每个涉及的仓库中创建同名逻辑分支和独立 worktree；`worktree-decision.json` 与 registry 使用 v3，兼容 v1/v2。
- locator 从 `git worktree list --porcelain` 验证/恢复记录路径，不拼接固定路径；每个仓库都有 delivery receipt，部分成功显式保留。
- Worktree 决策在方案确认后（`plan:confirm` 之后、`tasks:init` 之前）由用户选择。
- 用户选 `current-branch` 时，所有 task 串行执行，**不使用 Agent worktree 隔离**。
- 用户选 `worktree` 时，`getNextTasks()` 返回多个 task 且文件/符号/不变量/共享资源均无冲突时，使用 `Agent(isolation: "worktree")` 并行编码（这是 Agent 工具的临时隔离，task 级，用完即弃），合并后统一更新状态。
- 并行调度不再是全有或全无：`planParallelTaskBatches()` 对冲突图做稳定着色，自动生成尽可能早的安全执行波次；`workflow-status.mjs --prepare-task-batch` 在一次原子事务中领取首批所有 task 并返回各自 `run_id`，替代查询、冲突检测和逐 task 启动的多次控制面往返。
- 路径目录和 glob 交叉会保守判定为冲突；共享资源用 `impact_surface.reads/writes` 建模，read/read 可并行，任一 write 冲突。旧 `shared_state` 等价于 write lock。返修 task 始终串行。
- `chisel-review` 在所有 task 编码完成后进行动态 CR：spec 永远是门槛；小型低风险 diff 使用 lite，auth/payment/migration/concurrency/external boundary/verification mechanism 信号强制升级，其余维度按实际内容选择，输出理由与 batches。未选的旧 D2-D9 文件投影为 skipped/auto-pass，返修后从 spec 重新开始。
- 自动 CR 通过后进入 `review:merge`，在同一份 CR 报告中完成最终人工审阅：用户可 Approve / Request changes / Comment-hold；只有 Approve 且所有仓库快照未变化时 `merge-review-confirmed` gate 才通过。
- 需求完成后（`done` 阶段），多仓场景对每个仓库分别创建 PR 或 merge。

## Quick-dev 快速通道

- Quick-dev 覆盖 `hotfix`、`minor`、`trivial` 三种 direct complexity；都必须通过 `quick-dev-ready` 的低风险有界 scope。
- `hotfix` 路径：`receive → quick-dev:init → implement → review:cr-light → final → review:merge`，仅限显式、低风险、单文件范围；升级信号出现时必须回到澄清/分类。
- `minor/trivial` 路径：`receive → clarify(core scope+AC) → classify(direct) → quick-dev:init → implement → review:cr-light → final → review:merge`。
- 跳过：as-is 探索/确认、ai-input、plan、worktree 选择、D2-D9 CR。
- `quick-dev-init.mjs` 从 requirement-clarification.json 自动生成单 task + worktree-decision + traceability-matrix；超过 2 文件/2 模块、宽泛 scope 或非低风险时写 scope-escalation 并强制重新分类进入 plan，禁止 coder。

## 需求可追溯性

- `to-be/traceability-matrix.json` 记录每个 AC 由哪些 task 覆盖。
- `traceability-check.mjs` 验证覆盖链完整性：final 模式要求所有 covering tasks 为 approved。
- `gate-check.mjs` 的 `traceability-complete` gate 在 final:summary 前阻断未覆盖情况。
- 向后兼容：matrix 文件不存在时 gate 自动 pass。

## 独立 HTML 报告

- `scripts/report-model.mjs` 只负责数据采集、归一化和指标计算；`scripts/report-renderers.mjs` 只负责五类报告的内容片段；`scripts/reports.mjs` 将片段装入各自模板。
- As-Is 报告从 coverage matrix 生成 UML 时序或系统模型；To-Be 报告从 flow graph 同时生成目标 UML 模型和改造点全链路图。报告首屏只保留主干，目录锚点和可展开详情承载证据、CP、Task、风险与完整方案，改造节点可直接跳到对应 CP。
- `/chisel-report <idea-name> --format html` 按 As-Is、To-Be、CR、任务与耗时的顺序逐份生成；一次只允许一份。
- 每次生成后立即返回绝对路径和 SHA-256。As-Is/Test/CR/Task-time 新鲜即可自动推进；只有 To-Be 和最终 merge 快照等待用户明确确认。
- `as-is-report-confirmed`、`to-be-report-confirmed`、`cr-report-confirmed`、`integration-cr-report-confirmed`、`task-time-report-confirmed` 和 `merge-review-confirmed` 是推进门禁。
- 报告是自包含、响应式、可打印 HTML；`workflow-state.yaml.step_history` 为任务与耗时报告提供时间线数据。
