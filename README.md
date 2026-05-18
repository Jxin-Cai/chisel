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

例如当前仓库路径：

```bash
claude --plugin-dir /Users/jxin/Desktop/Project/open-source/claude-code/plugins/chisel
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

`chisel` 会在业务仓库中创建运行态产物目录：

```text
.chisel/<idea-name>/
```

这些文件记录需求理解、确认结果、实施方案、task 状态、CR 结论和知识候选，方便中断后恢复，也方便人审查 AI 的每一步判断。

## 核心工作流

1. **接收需求**：保存 `requirement.md`。
2. **理解 as-is**：只读扫描需求相关代码，产出面向人类理解的 as-is 文档。
3. **用户确认 as-is**：展示 3 分钟摘要、风险地图、用户确认清单和待澄清问题，写入 `clarifications.json`、`clarifications.md` 和 `confirmations/as-is.json`。
4. **生成 AI 输入版 as-is**：把人类版文档提炼为结构化 `as-is/ai-input/`。
5. **设计 to-be 方案**：生成 `to-be/implementation-plan.md`、机器可读 `to-be/tasks.json` 和 `to-be/traceability-matrix.json`。
6. **用户确认 to-be**：确认目标行为、非目标行为、允许/禁止修改范围，写入 `confirmations/to-be.json`。
7. **初始化 task**：从 `tasks.json` 生成 task 文件和 `task-workflow-state.yaml`。
8. **实现 task**：coder agent 按 confirmed task 编码，只改 expected files 范围内内容。
9. **架构师 CR**：reviewer agent 只读审查，复跑验证或说明不可执行原因。
10. **返修闭环**：每个 task 最多返修 3 次，返修项使用稳定 `CR-xxx` ID 追踪。
11. **知识沉淀**：候选知识经用户确认后合入项目 wiki，后续按需渐进加载。
12. **最终总结**：写入 `final-summary.md`，汇总变更、验证、Scope Control、知识候选处理和 wiki 更新。

`chisel` 不允许跳过 as-is 和 to-be 确认；每一阶段都由 `scripts/orchestration-status.mjs` 判定恢复点，并由 `scripts/gate-check.mjs` 校验 postcondition。

## 主要产物

### 人类理解版 as-is

```text
.chisel/<idea-name>/as-is/
  overview.md
  core-walkthrough.md
  evidence-index.md
  evidence-ledger.json
  coverage-matrix.json
  knowledge-candidates.md
  details/...
```

重点帮助用户快速理解本次需求涉及的遗留系统上下文：

- `3分钟摘要`：目标、当前主链路、最可能改动点、最大风险。
- `读者导航`：不同阅读目标应该先看什么。
- `风险地图`：只列与本次需求相关的理解和修改风险。
- `常见误解点`：防止用户或 AI 误读遗留行为。
- `用户确认清单`：让 confirm 阶段可逐项确认。
- `coverage-matrix.json`：结构化记录入口、链路、数据和副作用覆盖；不涉及的维度必须说明原因。

### AI 输入版 as-is

```text
.chisel/<idea-name>/as-is/ai-input/
  facts.md
  call-graph.md
  data-schema.md
  api-surface.md
  constraints.md
  change-surface.md
```

这些文件给 planner 和 coder 使用，gate 会检查事实证据、约束章节、safe-to-change 区域和模板占位符，避免 AI 基于空壳文档继续规划。

### To-be 与 task

```text
.chisel/<idea-name>/to-be/
  implementation-plan.md
  tasks.json
  traceability-matrix.json
.chisel/<idea-name>/confirmations/
  as-is.json
  to-be.json
.chisel/<idea-name>/clarifications.json
.chisel/<idea-name>/tasks/
  task-001.md
.chisel/<idea-name>/task-workflow-state.yaml
```

`clarifications.json` 和 `confirmations/*.json` 是确认阶段的结构化凭据；旧 `.as-is-confirmed` / `.to-be-confirmed` marker 仅用于历史运行目录兼容。`tasks.json` 是机器可读 task 来源，`task-init.mjs` 会用它生成 task 文件和状态机，减少手工搬运导致的 scope、验收标准、验证命令丢失。

### Report 与 CR

```text
.chisel/<idea-name>/task-reports/
.chisel/<idea-name>/cr/
```

task report 和 CR 必须包含：

- 做了什么、改了什么、验证结果。
- `Wiki Entries Loaded`。
- `Progressive Load Proof`。
- `Scope Check Proof` / `Scope Check Re-run`。
- CR 的 `Verification Re-run`。
- `needs_rework` 时的稳定 `CR-xxx` 返修项。

最终收尾还会写入 `.chisel/<idea-name>/final-summary.md`，`done` gate 会检查它包含变更摘要、验证结果、Scope Control Summary、Knowledge Candidates 和 Wiki Updates，避免只靠 `.done` marker 结束流程。

## 项目知识系统

`chisel` 支持把长期项目知识沉淀到业务仓库的 `.chisel/wiki/{project-name}/`（project-name = git 仓库名）：

- **禁区**：哪些内容不能动。
- **包袱**：哪些设计奇怪但有历史原因。
- **坏味道**：哪些代码看起来该重构，但当前不要动。
- **术语**：业务概念与系统/代码概念的映射。
- **ADR / module map / hotspot**：辅助后续 task 按需加载上下文。

知识候选会先写入 `.chisel/<idea-name>/knowledge-candidates/*.json`，默认是 `status=proposed`、`confirmed=false`。`knowledge:extract` 阶段会让用户逐条选择收录 / 不收录 / 延期：

- 收录的候选先变成 `confirmed`，再由 `wiki-manage.mjs --merge` 合入 wiki 并回写为 `merged`。
- 不收录的候选变成 `rejected`。
- 证据不足或后续再看的候选变成 `deferred`。
- `knowledge-extracted` gate 会阻止仍处于 `proposed` 或 `confirmed` 的候选进入最终总结。

agent 不会一次性加载整个 wiki，而是通过 `wiki-manage.mjs --query` 按 task 目标和 scope 检索相关条目，并在 report / CR 中留下加载证明。

## 核心文件

- `skills/chisel/SKILL.md` — 主编排器 `/chisel`。
- `agents/agent-chisel-explorer.md` — as-is 探索 agent。
- `agents/agent-chisel-planner.md` — to-be 规划 agent。
- `agents/agent-chisel-coder.md` — task 实现 agent。
- `agents/agent-chisel-architect-reviewer.md` — 架构师 CR agent。
- `scripts/orchestration-status.mjs` — 恢复点判定。
- `scripts/gate-check.mjs` — 阶段 postcondition gate。
- `scripts/task-init.mjs` — 从 `to-be/tasks.json` 初始化 task。
- `scripts/workflow-lib.mjs` — task 状态机基础库。
- `scripts/wiki-manage.mjs` — wiki 初始化、合入、查询。

## 开发与测试

运行全部测试：

```bash
node --test tests/*.mjs
```

当前测试覆盖：

- gate 校验。
- task 初始化。
- wiki 查询。
- CR 结果解析。
- task 状态机。
- requirement → as-is → ai-input → to-be/tasks.json → task-init → report → CR 的端到端产物流。

## License

MIT
