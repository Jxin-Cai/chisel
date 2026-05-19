# chisel

`chisel` 是一个 Claude Code plugin，用文件驱动的工作流帮助你在遗留系统上安全地增加功能：先理解 as-is，再确认 to-be 方案，然后拆 task、实现、架构师 CR、返修闭环，并把项目知识沉淀到可渐进加载的 wiki 中。

## 安装

### 从 GitHub 安装

在 Claude Code 中运行：

```text
/plugin marketplace add Jxin-Cai/chisel
/plugin install chisel@chisel
/reload-plugins
```

安装后可以查看插件和技能是否加载成功：

```text
/plugin
/skills
```

然后在目标项目中使用：

```text
/chisel <需求描述或需求文件路径>
```

### 本地开发加载

如果你正在本地开发或调试这个插件，可以不安装到插件列表，直接用插件目录启动 Claude Code：

```bash
claude --plugin-dir /absolute/path/to/chisel
```

### CLI 安装方式

也可以用 Claude Code CLI 安装到用户级 scope：

```bash
claude plugin install chisel@chisel --scope user
```

常用验证命令：

```bash
claude --version
claude plugin list
claude plugin details chisel@chisel
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
2. **理解 as-is**（`understand:explore`）：explorer agent 只读扫描需求相关代码，产出面向人类理解的 as-is 文档（overview、core-walkthrough、evidence-index 等）。
3. **用户确认 as-is**（`understand:confirm`）：展示 3 分钟摘要、风险地图、常见误解点、用户确认清单和待澄清问题，用户逐项确认后写入 `clarifications.json`、`clarifications.md` 和 `confirmations/as-is.json`。对话中识别到禁区/包袱/术语等知识信号时会实时写入 `knowledge-candidates/`。
4. **生成 AI 输入版 as-is**（`understand:generate-ai-input`）：把人类版文档提炼为结构化 `as-is/ai-input/`，供 planner 使用。**trivial 模式跳过此步。**
5. **策略设计**（`plan:strategy`）：planner agent 产出 `to-be/implementation-plan.md`，聚焦实现方向、设计决策、允许/禁止修改范围和测试策略。
6. **用户确认策略**（`plan:strategy-confirm`）：展示策略摘要，用户确认方向正确后写入 `confirmations/strategy.json`。可要求调整后重新运行策略设计。
7. **Task 拆分**（`plan:decompose`）：planner 基于已确认策略产出 `to-be/tasks.json` 和 `to-be/traceability-matrix.json`。
8. **用户确认拆分**（`plan:decompose-confirm`）：确认 task 拆分、依赖关系和验证方案，写入 `confirmations/to-be.json`。
9. **初始化 task**（`tasks:init`）：从 `tasks.json` 生成 task 文件和 `task-workflow-state.yaml`。
10. **编码**（`implement:code`）：coder agent 按 confirmed task 编码，只改 expected files 范围内内容。
11. **架构师 CR**（`review:cr`）：reviewer agent 只读审查，复跑验证命令，逐项检查验收标准和行为不变式。
12. **返修闭环**（`repair:code`）：每个 task 最多返修 3 次（超过进入 blocked）。返修后的 CR 必须包含 Rework Verification 章节，逐项对照上次返修清单验证修复结果。
13. **知识沉淀**（`knowledge:extract`）：候选知识经用户确认后合入项目 wiki，并运行 health-check 检测过时引用。**trivial 模式跳过此步。**
14. **最终总结**（`final:summary`）：写入 `final-summary.md`，汇总变更、验证、Scope Control、Knowledge Candidates、Wiki Updates 和 Wiki Hit Rate。
15. **完成与合并**（`done`）：如果在 worktree 中，提示合并分支（创建 PR 或直接 merge）。

### 复杂度分级

`chisel` 自动判定需求复杂度，用户也可以在 `requirement.md` 中用 `## 复杂度` 字段覆盖：

| 复杂度 | 判定条件 | 影响 |
|---|---|---|
| `trivial` | 涉及范围 ≤ 2 文件，无新增表/接口 | 跳过 AI 输入生成和知识沉淀 |
| `standard` | 默认 | 完整流程 |

### 确认与澄清

每个确认阶段都会产出结构化凭据：

- `clarifications.json` / `clarifications.md` — as-is 确认时的逐项决策记录
- `confirmations/as-is.json` — as-is 确认凭据
- `confirmations/strategy.json` — 策略方向确认凭据
- `confirmations/to-be.json` — task 拆分确认凭据

确认对话中会实时捕获知识信号（"不能动"/"历史原因"/"以后再改"/业务术语映射），自动写入 `knowledge-candidates/`。

### Worktree 隔离

`chisel` 启动时会检测是否在 worktree 中：

- **未在 worktree 中** → 建议使用 `EnterWorktree` 创建隔离工作空间，保护当前分支
- **已在 worktree 中** → 继续工作

Worktree 粒度为 **per-requirement**：一个需求对应一个 worktree，内部所有 task 在同一 worktree 中执行。

完成后（`done` 阶段），如果在 worktree 中，`chisel` 会：
1. 展示本次需求的所有 commit
2. 提供两种合并选项：
   - **创建 PR**：push 分支并协助创建 Pull Request
   - **直接合并**：提醒先 `ExitWorktree` 回到主分支再 merge

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

`receive-requirement`、`understand:explore`、`understand:confirm`、`understand:generate-ai-input`、`plan:strategy`、`plan:strategy-confirm`、`plan:decompose`、`plan:decompose-confirm`、`tasks:init`、`implement:code`、`review:cr`、`repair:code`、`knowledge:extract`

rollback 只清理白名单内运行态产物，不删除业务源码、长期 wiki 或 `knowledge-candidates/` 内容，并会写入 audit log。

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
  constraints.md    # 禁区、包袱、坏味道、兼容约束
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

- 做了什么、改了什么、验证结果
- `Wiki Entries Loaded` 和 `Progressive Load Proof`
- `Scope Check Proof` / `Scope Check Re-run`
- CR 的 `Verification Re-run`
- `needs_rework` 时的稳定 `CR-xxx` 返修项
- 返修后 CR 的 `Rework Verification` 章节（逐项验证修复结果）

最终收尾写入 `.chisel/<idea-name>/final-summary.md`，包含变更摘要、验证结果、Scope Control Summary、Knowledge Candidates、Wiki Updates 和 Wiki Hit Rate。

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

不启动 `/chisel` 主流程，也可以独立管理知识：

```text
/chisel-wiki init                           # 初始化 wiki 目录
/chisel-wiki feed forbidden_zone <描述>     # 手动喂入一条知识
/chisel-wiki query <关键词>                 # 查询 wiki
/chisel-wiki health                         # 检测过时文件引用
/chisel-wiki list                           # 列出所有条目
/chisel-wiki import <file>                  # 从文件批量导入
```

`feed` 子命令支持交互式创建候选 → 用户确认 → 冲突检测 → 合入 wiki 的完整流程。

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
| `low` | Acceptance Criteria、Verification |
| `medium` | + Behavior Invariants、Forbidden Files |
| `high` | 全字段强制填实 |

### 验证命令预检

task 初始化时会检查 verification 命令中引用的 binary 是否存在于 PATH 中，结果记录在 task 文件的 `verification_pre_check` frontmatter 字段。

### Scope Check

coder 完成编码后，`scope-check.mjs` 验证变更文件是否越界或触碰禁区。CR 阶段 reviewer 会再次运行 scope check。

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
| `agent-chisel-architect-reviewer` | 架构师 CR，只读审查不修改代码 |

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
| `scope-check.mjs` | 变更范围校验（文件越界和禁区检测） |
| `audit-log.mjs` | 全链路审计日志（step 流转、gate 结果、task 状态、知识加载） |
| `cr-parse.mjs` | CR 结果解析 |
| `task-metrics.mjs` | task 度量统计 |

## 开发与测试

运行全部测试：

```bash
node --test tests/*.mjs
```

当前测试覆盖：

- gate 校验（含 strategy gate、risk-level 分级、coverage-matrix depth）
- task 初始化（含 exports/imports、verification 预检）
- wiki 查询（含同义词扩展、module 过滤、health-check）
- CR 结果解析（含 rework verification）
- task 状态机（含 rollback-task、stale 检测）
- workflow rollback（含 plan 四步回退）
- requirement → as-is → ai-input → strategy → decompose → task-init → report → CR 的端到端产物流

## License

MIT
