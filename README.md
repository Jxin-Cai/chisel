# chisel

`chisel` 是一个 Claude Code plugin，用文件驱动的工作流帮助你在遗留系统上安全地增加功能：先理解 as-is，再确认 to-be 方案，然后拆 task、实现、架构师 CR、返修闭环，并把项目知识沉淀到可渐进加载的 wiki 中。

## 安装

### 第一步：添加插件市场

Claude Code 的第三方插件通过 marketplace 分发。首次使用需要先添加市场源：

```text
/plugin marketplace add Jxin-Cai/chisel
```

这会把 `Jxin-Cai/chisel` 仓库注册为你的插件市场。只需执行一次，后续升级不用重复。

### 第二步：安装 chisel 插件

从市场安装并激活：

```text
/plugin install chisel@chisel
/reload-plugins
```

验证安装成功：

```text
/plugin
/skills
```

你应该在输出中看到 `chisel` 插件和 `/chisel` 等技能。

### 第三步：使用

在你的**业务代码仓库**中启动 Claude Code，然后执行：

```text
/chisel <需求描述或需求文件路径>
```

> chisel 需要在目标代码仓库中运行，不是在 chisel 插件仓库中运行。

### 其他安装方式

**CLI 安装**（不进入交互模式）：

```bash
claude plugin install chisel@chisel --scope user
```

**本地开发加载**（直接从本地目录加载，不经过市场）：

```bash
claude --plugin-dir /absolute/path/to/chisel
```

## 快速使用

在你的业务代码仓库里启动 Claude Code，然后执行：

```text
/chisel 给用户创建流程增加手机号格式校验，保持旧接口响应兼容
```

或者传入需求文件路径：

```text
/chisel docs/requirements/user-phone-validation.md
```

`chisel` 会在业务仓库中创建运行态产物目录 `.chisel/<idea-name>/`，记录需求理解、确认结果、实施方案、task 状态、CR 结论和知识候选，方便中断后恢复，也方便人审查 AI 的每一步判断。

## 核心工作流

### 概览

```
接收需求 → 理解 as-is → 用户确认 → [生成 AI 输入] → 策略设计 → 用户确认策略
→ task 拆分 → 用户确认拆分 → 初始化 task → 编码 → 架构师 CR → [返修闭环]
→ [知识沉淀] → 最终总结 → 完成 → [worktree 合并]
```

方括号表示可能跳过的步骤（取决于复杂度分级）。

### 详细步骤

1. **接收需求**（`receive-requirement`）：解析用户输入，按模板保存 `requirement.md`。
2. **理解 as-is**（`understand:explore`）：explorer agent 只读扫描需求相关代码，产出面向人类理解的 as-is 文档（overview、core-walkthrough、evidence-index 等）。探索前自动运行 `repo-map.mjs`（生成代码地图和入口候选）和 `debt-scan.mjs`（技术债务扫描，按需求相关目录过滤），完成后运行 `as-is-score.mjs` 质量评分（含相关性调制，惩罚与需求无关的广撒网内容）。
3. **用户确认 as-is**（`understand:confirm`）：展示 3 分钟摘要、风险地图、常见误解点、用户确认清单和待澄清问题，用户逐项确认后写入 `clarifications.json`、`clarifications.md` 和 `confirmations/as-is.json`。对话中识别到禁区/包袱/术语等知识信号时会实时写入 `knowledge-candidates/`。
4. **生成 AI 输入版 as-is**（`understand:generate-ai-input`）：把人类版文档提炼为结构化 `as-is/ai-input/`，供 planner 使用。**trivial 模式跳过此步。**
5. **方案设计**（`plan:design`）：planner agent 一次性产出 `to-be/implementation-plan.md`（策略+任务拆分）、`to-be/tasks.json`、`to-be/traceability-matrix.json` 和 `to-be/impact-risk-report.json`。完成后执行变更完整性自检（伴生变更推断、Spec 覆盖率、CP-Task 一致性、依赖完备性、反向探测）。
6. **用户确认方案**（`plan:confirm`）：展示方案摘要和 task 拆分，用户确认后写入 `confirmations/to-be.json`。可要求调整后重新运行方案设计。
7. **知识提取**（`knowledge:extract`）：从 as-is 和方案确认中提取长期知识候选，用户确认后合入 wiki。**trivial 模式跳过此步。**
8. **初始化 task**（`tasks:init`）：从 `tasks.json` 生成 task 文件和 `task-workflow-state.yaml`。
9. **编码**（`implement:code`）：coder agent 按 confirmed task 编码，只改 expected files 范围内内容。
10. **架构师 CR**（`review:cr`）：reviewer agent 只读审查，逐项检查验收标准和行为不变式。
12. **返修闭环**（`repair:code`）：每个 task 最多返修 3 次（超过进入 blocked）。返修后的 CR 必须包含 Rework Verification 章节，逐项对照上次返修清单验证修复结果。
13. **知识沉淀**（`knowledge:extract`）：候选知识经用户确认后合入项目 wiki，并运行 health-check 检测过时引用。**trivial 模式跳过此步。**
14. **最终总结**（`final:summary`）：写入 `final-summary.md`，汇总变更、Scope Control、Knowledge Candidates、Wiki Updates 和 Wiki Hit Rate。
15. **完成与合并**（`done`）：如果在 worktree 中，提示合并分支（创建 PR 或直接 merge）。

### 复杂度分级

`chisel` 自动判定需求复杂度，用户也可以在 `requirement.md` 中用 `## 复杂度` 字段覆盖：

| 复杂度 | 判定条件 | 影响 |
|---|---|---|
| `trivial` | 涉及范围 ≤ 2 文件，无新增表/接口，且跨模块目录 < 3 | 跳过 AI 输入生成和知识沉淀 |
| `standard` | 默认 | 完整流程 |

### 确认与澄清

chisel 有 3 个人工确认环节，每个都会暂停流程等待用户逐项确认，确认通过后才能进入下一阶段。

#### 1. As-Is 确认（`understand:confirm`）

explorer 完成 as-is 文档后，chisel 向用户展示：

- **3 分钟摘要**：一句话目标、当前主链路、最可能改动点、最大风险
- **风险地图**：与本次需求相关的理解和修改风险
- **常见误解点**：防止误读遗留行为的关键事实
- **用户确认清单**：每个 `C-xxx` 待确认项，用户逐条回答
- **待澄清问题**：需要用户补充的业务背景

用户逐项确认或补充后，chisel 将结果写入：

- `clarifications.json` — 每个 `C-xxx` 的 `id/question/decision/rationale/status`，状态为 `confirmed/defaulted/deferred`
- `clarifications.md` — 人类可读的决策记录镜像
- `confirmations/as-is.json` — 结构化确认凭据

如果用户对 as-is 理解有异议，可以在此阶段要求 explorer 补充调研。未通过确认前，流程不会进入规划阶段。

#### 2. 方案确认（`plan:confirm`）

planner 一次性产出策略和 task 拆分后，chisel 向用户展示实现策略方向、设计决策、允许/禁止修改范围、task 拆分和依赖关系。用户确认后写入 `confirmations/to-be.json`。如果用户对方案有异议，可以要求调整后重新运行 `plan:design`。

#### 实时知识捕获

在所有确认对话中，chisel 会监听知识信号（"不能动"/"历史原因"/"以后再改"/业务术语映射），识别到时即时写入 `knowledge-candidates/` 目录。这些候选会在后续 `knowledge:extract` 阶段统一去重和合入。

### Worktree 隔离

遗留系统改动风险高，chisel 强烈建议在隔离的 worktree 中工作，避免直接在主分支上修改。

#### 启动时

chisel 启动时会自动检测 worktree 状态：

- **已在 worktree 中** → 直接继续，无需额外操作
- **未在 worktree 中** → 提示用户创建隔离空间：

```text
建议使用 EnterWorktree 创建隔离工作空间，保护当前分支。
```

用户在 Claude Code 中执行 `EnterWorktree` 即可创建。Worktree 粒度为 **per-requirement**：一个需求对应一个 worktree，内部所有 task 在同一 worktree 中执行。

#### 完成后合并

当需求完成（`done` 阶段）且处于 worktree 中时，chisel 会：

1. 运行 `git log --oneline main..HEAD` 展示本次需求所有 commit
2. 提供两种合并方式供用户选择：

**方式一：创建 PR（推荐）**

```text
chisel: 需求 user-phone-validation 已完成，当前在 worktree 分支 claude/worktree-xxx 中。
       是否创建 PR 合入主分支？
```

chisel 会协助 `git push -u origin <branch>` 并创建 Pull Request。

**方式二：直接合并**

```text
chisel: 如需直接合并，请先执行 ExitWorktree 回到主分支，再 git merge <branch>。
```

#### 不在 worktree 中

如果用户选择不使用 worktree（直接在主分支工作），chisel 也能正常运行，完成后直接报告完成，不触发合并流程。

### 并行开发

当 `getNextTasks()` 返回多个 task 时：

- **无文件重叠** → 使用 `Agent(isolation: "worktree")` 并行编码
- **有文件重叠或 exports/imports 依赖** → 串行执行
- **返修 task** → 始终串行
- **CR 审查** → 多 coded task 可并行派发 reviewer（reviewer 只读，无需 worktree）

### 局部回退

如果某个阶段产物需要重做，先预览回退影响：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-status.mjs .chisel/<idea-name> --rollback-step <step> --dry-run
```

确认后去掉 `--dry-run` 执行。支持回退的步骤：

`receive-requirement`、`understand:explore`、`understand:confirm`、`understand:generate-ai-input`、`clarify:requirement`、`plan:design`、`plan:confirm`、`worktree:setup`、`tasks:init`、`implement:code`、`review:cr`、`repair:code`、`knowledge:extract`

rollback 只清理白名单内运行态产物，不删除业务源码、长期 wiki 或 `knowledge-candidates/` 内容。

#### 单 task 回退

也可以只回退某个 task（重置为 confirmed 状态，删除其 report 和 CR）：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-status.mjs .chisel/<idea-name> --rollback-task <task-id> --dry-run
```

## 主要产物

### 人类理解版 as-is

```text
.chisel/<idea-name>/as-is/
  overview.md          # 3分钟摘要、风险地图、误解点、确认清单、阅读充分性声明
  core-walkthrough.md  # 核心链路 sequence diagram
  evidence-index.md    # 证据索引表
  evidence-ledger.json # 结构化证据账本
  coverage-matrix.json # 入口/链路/数据/副作用覆盖（链路含 depth 标注）
  knowledge-candidates.md
  details/...          # 枝干文件（按量化规则按需生成）
```

### AI 输入版 as-is

```text
.chisel/<idea-name>/as-is/ai-input/
  facts.md          # 已确认事实
  call-graph.md     # 调用图
  data-schema.md    # 数据模型
  api-surface.md    # API 表面
  constraints.md    # 禁区、包袱、坏味道、兼容约束（各表含 Severity: hard/soft）
  change-surface.md # 可安全修改的区域
```

### To-be 与 task

```text
.chisel/<idea-name>/to-be/
  implementation-plan.md     # 策略方向和设计决策
  tasks.json                 # 机器可读 task 定义（含 exports/imports）
  traceability-matrix.json   # 需求到 task 的追溯
.chisel/<idea-name>/confirmations/
  as-is.json                 # as-is 确认凭据
  strategy.json              # 策略确认凭据
  to-be.json                 # task 拆分确认凭据
.chisel/<idea-name>/clarifications.json
.chisel/<idea-name>/clarifications.md
.chisel/<idea-name>/tasks/
  task-001.md                # task 文件（含 Exports/Imports 章节）
.chisel/<idea-name>/task-workflow-state.yaml
```

### Report 与 CR

```text
.chisel/<idea-name>/task-reports/
.chisel/<idea-name>/cr/
```

task report 和 CR 必须包含：

- 做了什么、改了什么
- `Wiki Entries Loaded` 和 `Progressive Load Proof`
- `Scope Check Proof` / `Scope Check Re-run`
- `needs_rework` 时的稳定 `CR-xxx` 返修项
- 返修后 CR 的 `Rework Verification` 章节（逐项验证修复结果）

最终收尾写入 `.chisel/<idea-name>/final-summary.md`，包含变更摘要、Scope Control Summary、Knowledge Candidates、Wiki Updates 和 Wiki Hit Rate。

## 项目知识系统

`chisel` 支持把长期项目知识沉淀到业务仓库的 `.chisel/wiki/{project-name}/`（project-name = git 仓库名）：

- **禁区**：哪些内容不能动
- **包袱**：哪些设计奇怪但有历史原因
- **坏味道**：哪些代码看起来该重构，但当前不要动
- **术语**：业务概念与系统/代码概念的映射
- **ADR / module map / hotspot**：辅助后续 task 按需加载上下文

### 知识流

```
实时捕获/手动喂入 → knowledge-candidates/*.json (proposed)
  → 用户确认 → wiki-manage.mjs --merge → wiki 条目 (merged)
  → SessionStart hook → settings rule 激活 → task 按需加载
```

每个知识候选有用户评定的 `relevance`（high/medium/low），影响查询时的排序权重。

### 独立使用 `/chisel-wiki`

知识管理不依赖 `/chisel` 主流程。你可以随时用 `/chisel-wiki` 直接管理项目知识，典型场景：

- **团队经验沉淀**：把 code review 中发现的禁区、历史包袱直接喂入 wiki
- **新人入职**：整理散落在各处的业务术语映射，统一录入
- **日常维护**：定期检查 wiki 引用的文件路径是否还存在

```text
# 初始化 wiki（首次使用）
/chisel-wiki init

# 手动喂入一条知识
/chisel-wiki feed forbidden_zone 支付模块的 PaymentGateway 类不能直接修改，必须通过 adapter 扩展
/chisel-wiki feed baggage OrderService.calculateTotal 中的折扣逻辑看起来该重构，但三个客户端依赖了它的返回格式
/chisel-wiki feed terminology "核销"在代码中对应 Redemption.consume()，不是 Voucher.use()

# 查询相关知识
/chisel-wiki query 支付
/chisel-wiki query 折扣 --module order

# 从文件批量导入（支持 JSON 数组和 Markdown 格式）
/chisel-wiki import docs/legacy-knowledge.json

# 检查 wiki 健康状态
/chisel-wiki health

# 列出所有条目
/chisel-wiki list
```

`feed` 子命令的完整流程：解析分类 → 收集内容 → 创建候选 → 用户确认 → 冲突检测 → 合入 wiki。全程交互式，不会跳过确认环节。

### Wiki Health Check

`health-check` 扫描所有 wiki 条目中引用的文件路径，检测：

- 文件已删除或已移动 → 标记为 stale
- 文件仍存在 → 标记为 healthy

在 `knowledge:extract` 阶段会自动运行 health-check，也可通过 `/chisel-wiki health` 手动执行。

## SDD 质量控制

### 风险分级

task 按 `risk_level`（low/medium/high）分级要求 SDD 内容：

| risk_level | 必填章节 |
|---|---|
| `low` | Acceptance Criteria |
| `medium` | + Behavior Invariants、Forbidden Files |
| `high` | 全字段强制填实 |

### Scope Check

coder 完成编码后，`scope-check.mjs` 验证变更文件是否越界或触碰禁区，同时检测 diff 中未在 task.exports 声明的新增公共导出（undeclared_new_export 警告）。CR 阶段 reviewer 会再次运行 scope check。

### 编码中断检测

如果某个 task 处于 coding/repairing 状态超过 30 分钟，orchestration-status 输出中会包含 stale warning。

## 核心文件

### Skills

| Skill | 说明 |
|---|---|
| `/chisel` | 主编排器，端到端驱动整个工作流 |
| `/chisel-understand` | 只读理解 as-is，生成文档和证据 |
| `/chisel-plan` | to-be 规划（strategy/decompose 双模式） |
| `/chisel-implement` | 编排 coding subagent 实现 task |
| `/chisel-review` | 架构师 CR 审查 |
| `/chisel-status` | 查看当前恢复点和 task 状态 |
| `/chisel-wiki` | 独立知识库管理（init/feed/query/health/list/import） |
| `chisel-help` | 共享契约和模板索引（不单独执行） |

### Agents

| Agent | 说明 |
|---|---|
| `agent-chisel-explorer` | as-is 探索，只读扫描代码生成理解文档 |
| `agent-chisel-planner` | to-be 规划（strategy 产出策略，decompose 产出 task 拆分） |
| `agent-chisel-coder` | 按 confirmed task 编码实现 |
| `agent-chisel-reviewer` | 通用 CR（opus），每次加载单维度定义执行深度审查 |

### Scripts

| 脚本 | 说明 |
|---|---|
| `orchestration-status.mjs` | 恢复点判定和复杂度检测 |
| `gate-check.mjs` | 阶段 postcondition gate 校验 |
| `task-init.mjs` | 从 `to-be/tasks.json` 初始化 task 文件和状态机 |
| `workflow-lib.mjs` | task 状态机基础库 |
| `workflow-status.mjs` | task 状态查询、回退命令、overlap 检测 |
| `wiki-manage.mjs` | wiki 初始化、合入、查询、health-check、同义词扩展 |
| `wiki-rule-inject.mjs` | SessionStart hook，自动向业务项目注入 wiki 加载 rule |
| `scope-check.mjs` | 变更范围校验（文件越界、禁区检测、未声明导出警告） |
| `repo-map.mjs` | 代码地图生成（语言统计、目录结构、入口候选推断） |
| `debt-scan.mjs` | 纯静态技术债务扫描（支持 `--scope-dirs` 目录过滤） |
| `as-is-score.mjs` | as-is 产物多维质量评分（含相关性调制） |
| `traceability-check.mjs` | 需求→task 可追溯性验证（支持 verification_conditions 细粒度校验） |
| `cr-prepare.mjs` | CR 预计算——收集 diff/scope-check/wiki 数据供 reviewer 共用 |
| `cr-parse.mjs` | CR 结果解析 |
| `task-metrics.mjs` | task 度量统计 |
| `dashboard.mjs` | 自包含 HTML 仪表板生成（进度/CR 雷达图/改造视图） |
| `quick-dev-init.mjs` | trivial 快速通道自动生成单 task |

## License

MIT
