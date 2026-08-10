<div align="center">

# Chisel

**文件驱动的遗留系统功能增强工作流插件 — 基于 Claude Code。**

[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Plugin-D97757.svg)](https://github.com/anthropics/claude-code)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933.svg?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

[English](./README.md)&ensp;|&ensp;[中文文档](./README_zh.md)&ensp;|&ensp;[License](./LICENSE)

</div>

<br/>

Chisel 是一个 [Claude Code](https://github.com/anthropics/claude-code) 插件，用文件驱动的工作流帮助你在遗留系统上安全地增加功能：先理解 as-is，再设计 to-be，经过机器强制的对抗完整性审查后才允许用户确认方案，然后拆 task、实现、架构师 CR、返修闭环，最后审阅当前变更报告并批准交付。审查未通过会回到方案修复并循环，不能把不完整方案交给用户 review。

每一步都产出文件化产物，方便中断后恢复，也方便人审查 AI 的每一步判断。

<br/>

## 目录

- [为什么需要 Chisel](#为什么需要-chisel)
- [安装](#安装)
- [快速使用](#快速使用)
- [核心工作流](#核心工作流)
- [主要产物](#主要产物)
- [质量控制](#质量控制)
- [架构](#架构)
- [贡献](#贡献)
- [许可证](#许可证)

<br/>

## 为什么需要 Chisel

遗留系统承载着隐藏约束、未文档化的业务规则和脆弱的集成点。直接让 AI "加个功能 X" 会跳过理解阶段，容易破坏行为不变式。

Chisel 通过**门控驱动的工作流**解决这个问题：

| 阶段 | 作用 |
|---|---|
| **理解** | 只读探索相关代码路径，产出带证据的 as-is 文档 |
| **确认** | 三个人工关卡 — as-is 理解、完整 to-be 方案/task、合并前精确代码快照 |
| **实现** | 受限编码，文件边界强制执行，安全时并行 |
| **审查** | 多维度架构师 CR 自动返修，随后进行绑定代码快照的人工合并审查 |

不跳步。不凭记忆决策 — 编排器始终读取文件化的状态机。

<br/>

## 安装

### 第一步：添加插件市场

```text
/plugin marketplace add Jxin-Cai/chisel
```

把 `Jxin-Cai/chisel` 仓库注册为插件市场源。只需执行一次。

### 第二步：安装插件

```text
/plugin install chisel@chisel
/reload-plugins
```

执行 `/plugin` 和 `/skills` 验证 — 应该能看到 `chisel` 插件及其技能。

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

<br/>

## 快速使用

```text
/chisel 给用户创建流程增加手机号格式校验，保持旧接口响应兼容
```

或者传入需求文件路径：

```text
/chisel docs/requirements/user-phone-validation.md
```

chisel 将运行态产物写入 Git common root 下的 `.chisel/<idea-name>/`，因此主工作区与 linked worktree 共享同一控制面；可用 `CHISEL_CONTROL_ROOT` 覆盖。

<br/>

## 核心工作流

### 概览

```
接收需求 → 需求澄清 → 难度/执行档位分级
→ [仅 full：理解 as-is → 后台 Writer → 用户确认] → 方案设计 → 后台 Writer
→ 对抗完整性审查（失败则修复循环）→ 用户确认方案 → 初始化 task → 编码 → 架构师 CR → [返修闭环]
→ 最终总结 → 当前变更报告 → 用户合并决策 → 交付
```

方括号表示可能跳过的步骤（取决于复杂度分级）。

### 流程步骤

| # | 步骤 | 说明 |
|---|---|---|
| 1 | **接收需求** | 解析用户输入，按模板保存 `requirement.md` |
| 2 | **澄清并分级** | 先澄清，再持久化带输入指纹的难度、风险、执行档位与 subagent 预算 |
| 3 | **理解 as-is（仅 full）** | explorer/analyst 产出结构化证据；后台 Writer 按完整 source manifest 生成人类文档和 fresh receipt |
| 4 | **确认 as-is（仅 full）** | 人类审查 3 分钟摘要、风险地图、误解点，逐项确认 |
| 5 | **方案设计** | planner 产出实现计划、task 定义、追溯矩阵 |
| 6 | **对抗完整性审查** | fresh reviewer 逐项对照 requirement/clarification/as-is/to-be；发现遗漏即生成 findings，修复后重跑，直到 pass |
| 7 | **确认方案** | 仅在对抗 gate 通过后，人类审查策略方向和 task 拆分 |
| 8 | **初始化 task** | 从 `tasks.json` 生成 task 文件和状态机 |
| 9 | **编码** | coder agent 在受限文件范围内编码 |
| 10 | **架构师 CR** | reviewer 检查验收标准和行为不变式 |
| 11 | **返修闭环** | 单 task 最多返修 5 次，第 4–5 轮由 fresh agent 接管，超过后进入 blocked |
| 12 | **最终总结** | 汇总变更、scope control 和交付回执 |
| 13 | **合并前 CR** | 生成当前变更报告，要求用户选择批准、要求修改或评论/暂缓 |
| 14 | **交付** | 用户确认后通过隔离 integration worktree 转分支、合并或进入冲突链路 |

### 复杂度分级

| 复杂度 | 判定条件 | 影响 |
|---|---|---|
| `hotfix` | 显式紧急修复、低风险且限单文件 | 快速路径，仅 spec 审查；超限自动升级 |
| `minor` | 小型兼容行为变更 | 澄清、快速路径、仅 spec 审查 |
| `trivial` | 涉及范围 ≤ 2 文件，无新增表/接口，跨模块目录 < 3 | 快速路径，仅 spec 审查 |
| `moderate` | 澄清后的保守 floor 或有界多文件变更 | 只用 requirement/clarification 和有界 source manifest 轻量规划，不启动 as-is agents |
| `standard` | 跨模块或边界变更 | 完整 as-is/to-be 流程和集成审查 |
| `complex` | 高风险、多仓、迁移或大范围变更 | 全流程、全维度和集成审查 |

### 人工确认关卡

chisel 根据澄清后的执行路径启用 **最多 3 个人工关卡**：

1. **As-is 确认** — 验证对当前系统行为的理解
2. **To-be 确认** — 批准实现方向、完整 task 拆分、依赖和风险
3. **合并前 CR** — 审阅当前变更报告，明确批准精确的 Git/工作区快照

full 路径使用全部三个关卡；moderate 跳过 As-is 确认，保留 To-be 和合并前 CR；direct 的 hotfix/minor/trivial 跳过两次设计确认，通常只保留精确快照的合并前 CR。

确认决策持久化在 idea 目录中，编排器每次恢复都会重新读取；不依赖隐藏的旁路知识库。

### Worktree 隔离

chisel 支持外层非 Git workspace 包含一个或多个 Git 仓库。持久化 idea registry 记录控制面、仓库路径、分支、base/default ref 和生命周期，因此可从外层、任一仓库或任一 linked worktree 定位并恢复。一个需求在每个仓库使用同一逻辑分支名，并通过独立 worktree 并行开发。

### 并行开发

当多个 task 无文件重叠时：
- **无重叠** → `Agent(isolation: "worktree")` 并行编码
- **文件重叠或依赖** → 串行
- **返修** → 始终串行
- **CR** → 并行派发（只读，无需 worktree）

### 局部回退

```bash
IDEA_DIR=$(node ${CLAUDE_PLUGIN_ROOT}/scripts/control-plane.mjs --project-root . --idea <idea-name>)
node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-status.mjs "$IDEA_DIR" --rollback-step <step> --dry-run
```

回退只清理白名单内运行态产物，不删除业务源码。

<br/>

## 主要产物

### As-is 文档

```text
.chisel/<idea-name>/as-is/
  overview.md              # 3 分钟摘要、风险地图、误解点
  core-walkthrough.md      # 核心链路 sequence diagram
  evidence-index.md        # 证据索引表
  evidence-ledger.json     # 结构化证据账本
  coverage-matrix.json     # 入口/链路/数据/副作用覆盖
  ai-input/                # 结构化 AI 输入版本（standard only）
```

### To-be 与 Task

```text
.chisel/<idea-name>/to-be/
  implementation-plan.md       # 策略方向和设计决策
  tasks.json                   # 机器可读 task 定义
  traceability-matrix.json     # 需求→task 追溯
  adversarial-review.md        # 对抗完整性审查记录
  adversarial-review.json      # 机器 gate 依据（pass/findings/evidence）
.chisel/<idea-name>/tasks/
  task-001.md                  # task 文件（含 Exports/Imports）
.chisel/<idea-name>/task-workflow-state.yaml
```

### Report 与 CR

```text
.chisel/<idea-name>/task-reports/    # 实现报告
.chisel/<idea-name>/cr/              # 代码审查结果
.chisel/<idea-name>/cr/current-change-report.md   # 人工审阅的合并前变更报告
.chisel/<idea-name>/cr/current-change-report.json # 绑定代码快照的结构化报告
.chisel/<idea-name>/confirmations/merge-review.json # 批准/要求修改/暂缓决定
.chisel/<idea-name>/final-summary.md # 最终变更总结
```

每个工作流步骤完成后，Chisel 会在对话中把该步骤的每个产物输出为绝对路径 Markdown 链接。也可以直接运行确定性渲染脚本：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/phase-artifacts.mjs <idea-dir> <completed-step>
```

Dashboard 链接只是补充，不替代需求、方案、Task 报告、CR 和最终总结等原始文件链接。

<br/>

## 质量控制

### 风险分级

| 风险等级 | 必填章节 |
|---|---|
| `low` | Acceptance Criteria |
| `medium` | + Behavior Invariants、Forbidden Files |
| `high` | 全字段强制填实 |

### Scope Check

编码完成后 `scope-check.mjs` 验证：
- 变更文件在声明范围内
- 未触碰禁区文件
- 无未声明的新增公共导出

### To-be 完整性 gate

`plan:confirm` 之前必须先执行 `plan:adversarial-review`：由 fresh reviewer 直接对照 `requirement.md`、澄清 AC/VC、as-is 证据和全部结构化 to-be 产物，写入 `to-be/adversarial-review.json` 与 `.md`。`fail` 必须带可执行 findings 并回到 `plan:design` 修复；只有机器校验的 `pass` 才能进入用户确认。审查轮次有上限，达到上限进入 `blocked`，不会把不完整方案交给用户。

schema v2+ 的追溯矩阵严格执行：缺失/空矩阵失败，每个 AC 和 verification condition 必须精确映射，并做 task→matrix 双向校验。实现报告必须逐条给出非占位的 Acceptance Criteria Result 和 Traceability Evidence，且 `Completion Status: DONE`（或明确审阅过的 `DONE_WITH_CONCERNS`）后才允许 verification/review。

### 中断检测

task 的 `run_id` lease 过期时，orchestration-status 输出 stale warning；长耗时操作前通过 heartbeat 续租，不再依赖固定 30 分钟猜测。

<br/>

## 架构

### Skills

| Skill | 说明 |
|---|---|
| `/chisel` | 主编排器，端到端驱动整个工作流 |
| `/chisel-understand` | 只读理解 as-is，生成文档和证据 |
| `/chisel-plan` | to-be 规划（策略+拆解） |
| `/chisel-implement` | 编排 coding subagent 实现 task |
| `/chisel-review` | 架构师 CR 审查 |
| `/chisel-report` | 查看恢复点和 task 状态（文本/HTML dashboard） |
| `/chisel-debug` | reproduce-first 根因工作流（独立模式或返修诊断模式） |

### Agents

| Agent | 说明 |
|---|---|
| `agent-chisel-writer` | 从结构化产物生成人类可读文档（sonnet） |
| `agent-chisel-analyst` | 深度代码走查，产出结构化 as-is 数据（sonnet） |
| `agent-chisel-coder` | 按 confirmed task 持续实现并验证（默认继承主编排器模型，复杂/升级任务覆盖为 opus） |
| `agent-chisel-reviewer` | 多维度 CR，单维度/次深度审查（opus） |

### Scripts

| 脚本 | 说明 |
|---|---|
| `orchestration-runner.mjs` | 带租约的持久 runner、崩溃恢复与幂等 transition |
| `orchestration-status.mjs` | 只读权威恢复点计算 |
| `control-plane.mjs` | 解析 linked worktree 共享控制面 |
| `orchestration-transition.mjs` | 校验 resume step 与 revision 后显式切换状态并记录事件 |
| `gate-check.mjs` | 阶段 postcondition gate 校验 |
| `traceability-check.mjs` | 双向 AC/VC→task 覆盖和最终批准校验 |
| `adversarial-review.mjs` | 确定性 to-be 完整性审查和有界修复循环记录 |
| `task-init.mjs` | 初始化 task 文件和状态机 |
| `workflow-status.mjs` | task 状态查询、回退、overlap 检测 |
| `task-provenance.mjs` | 记录 task 执行基线/结果指纹与 changed-files 归属 |
| `verify-run.mjs` | 绑定工作区指纹的多仓构建/测试验证 |
| `checkpoint.mjs` | 绑定源码身份、保存完整 artifact 的一致性快照恢复 |
| `scope-check.mjs` | 文件边界和禁区校验 |
| `multi-repo-worktree.mjs` | registry 驱动的多仓 worktree、定位/恢复/状态和回执 |
| `branch-merge.mjs` | 隔离 integration 合并和机器可读冲突分析 |
| `review-selector.mjs` | 基于 diff/路径/内容的风险和审查维度选择 |
| `repo-map.mjs` | 代码地图生成 |
| `debt-scan.mjs` | 静态技术债务扫描 |
| `as-is-score.mjs` | as-is 产物质量评分 |
| `cr-prepare.mjs` | CR 预计算数据 |
| `dashboard.mjs` | 自包含 HTML 仪表板生成 |

<br/>

## 贡献

欢迎贡献。如果计划做较大改动，请**先开 issue** 讨论方向和范围。

欢迎 bug 报告、功能建议和 pull request。

<br/>

## 许可证

基于 [MIT License](./LICENSE) 开源。

Copyright 2026 jxin
