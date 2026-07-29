<div align="center">

# Chisel

**文件驱动的遗留系统功能增强工作流插件 — 基于 Claude Code。**

[![License](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Claude Code](https://img.shields.io/badge/Claude_Code-Plugin-D97757.svg)](https://github.com/anthropics/claude-code)
[![Node.js](https://img.shields.io/badge/Node.js-18+-339933.svg?logo=nodedotjs&logoColor=white)](https://nodejs.org/)

[English](./README.md)&ensp;|&ensp;[中文文档](./README_zh.md)&ensp;|&ensp;[License](./LICENSE)

</div>

<br/>

Chisel 是一个 [Claude Code](https://github.com/anthropics/claude-code) 插件，用文件驱动的工作流帮助你在遗留系统上安全地增加功能：先理解 as-is，再确认 to-be 方案，然后拆 task、实现、架构师 CR、返修闭环，并把项目知识沉淀到可渐进加载的 wiki 中。

每一步都产出文件化产物，方便中断后恢复，也方便人审查 AI 的每一步判断。

<br/>

## 目录

- [为什么需要 Chisel](#为什么需要-chisel)
- [安装](#安装)
- [快速使用](#快速使用)
- [核心工作流](#核心工作流)
- [主要产物](#主要产物)
- [项目知识系统](#项目知识系统)
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
| **确认** | 三个人工确认关卡 — as-is 理解、策略方向、task 拆分 |
| **实现** | 受限编码，文件边界强制执行，安全时并行 |
| **审查** | 多维度架构师 CR，自动返修闭环（单 task 最多 3 轮） |
| **知识** | 捕获禁区、历史包袱、术语映射，沉淀到持久化项目 wiki |

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

chisel 会在业务仓库中创建运行态产物目录 `.chisel/<idea-name>/`，记录需求理解、确认结果、实施方案、task 状态、CR 结论和知识候选。

<br/>

## 核心工作流

### 概览

```
接收需求 → 理解 as-is → 用户确认 → [生成 AI 输入] → 策略设计 → 用户确认策略
→ task 拆分 → 用户确认拆分 → 初始化 task → 编码 → 架构师 CR → [返修闭环]
→ [知识沉淀] → 最终总结 → 完成 → [worktree 合并]
```

方括号表示可能跳过的步骤（取决于复杂度分级）。

### 流程步骤

| # | 步骤 | 说明 |
|---|---|---|
| 1 | **接收需求** | 解析用户输入，按模板保存 `requirement.md` |
| 2 | **理解 as-is** | explorer agent 只读扫描代码，产出 overview、core-walkthrough、evidence-index |
| 3 | **确认 as-is** | 人类审查 3 分钟摘要、风险地图、误解点，逐项确认 |
| 4 | **生成 AI 输入** | 人类版文档提炼为结构化 AI 输入格式（trivial 跳过） |
| 5 | **方案设计** | planner 产出实现计划、task 定义、追溯矩阵 |
| 6 | **确认方案** | 人类审查策略方向和 task 拆分，确认通过 |
| 7 | **知识提取** | 提取长期知识候选（trivial 跳过） |
| 8 | **初始化 task** | 从 `tasks.json` 生成 task 文件和状态机 |
| 9 | **编码** | coder agent 在受限文件范围内编码 |
| 10 | **架构师 CR** | reviewer 检查验收标准和行为不变式 |
| 11 | **返修闭环** | 单 task 最多返修 3 次，超过进入 blocked |
| 12 | **最终总结** | 汇总变更、scope control、wiki 更新 |
| 13 | **完成** | 若在 worktree 中，提示合并分支 |

### 复杂度分级

| 复杂度 | 判定条件 | 影响 |
|---|---|---|
| `trivial` | 涉及范围 ≤ 2 文件，无新增表/接口，跨模块目录 < 3 | 跳过 AI 输入生成和知识沉淀 |
| `standard` | 默认 | 完整流程 |

### 人工确认关卡

chisel 有 **3 个强制确认环节**，暂停流程等待用户逐项确认：

1. **As-is 确认** — 验证对当前系统行为的理解
2. **策略确认** — 批准实现方向和设计决策
3. **Task 确认** — 批准任务拆分和依赖关系

确认对话中检测到的知识信号（禁区/包袱/术语）会实时写入 `knowledge-candidates/`。

### Worktree 隔离

遗留系统改动风险高，chisel 强烈建议在隔离的 worktree 中工作。一个需求 = 一个 worktree。完成后协助创建 PR 或直接合并。

### 并行开发

当多个 task 无文件重叠时：
- **无重叠** → `Agent(isolation: "worktree")` 并行编码
- **文件重叠或依赖** → 串行
- **返修** → 始终串行
- **CR** → 并行派发（只读，无需 worktree）

### 局部回退

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/workflow-status.mjs .chisel/<idea-name> --rollback-step <step> --dry-run
```

回退只清理白名单内运行态产物，不删除业务源码、wiki 或 knowledge-candidates。

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
.chisel/<idea-name>/tasks/
  task-001.md                  # task 文件（含 Exports/Imports）
.chisel/<idea-name>/task-workflow-state.yaml
```

### Report 与 CR

```text
.chisel/<idea-name>/task-reports/    # 实现报告
.chisel/<idea-name>/cr/              # 代码审查结果
.chisel/<idea-name>/final-summary.md # 最终变更总结
```

<br/>

## 项目知识系统

chisel 把长期项目知识沉淀到业务仓库的 `.chisel/wiki/{project-name}/`：

| 分类 | 用途 |
|---|---|
| **禁区** | 不能直接修改的代码 |
| **包袱** | 有历史原因的奇怪设计 |
| **坏味道** | 看起来该重构但当前不能动的代码 |
| **术语** | 业务概念 ↔ 代码概念映射 |
| **ADR / module map / hotspot** | 辅助后续 task 按需加载上下文 |

### 独立使用 `/chisel-wiki`

知识管理不依赖主流程，随时可用：

```text
/chisel-wiki init                    # 初始化 wiki
/chisel-wiki feed forbidden_zone ... # 喂入一条知识
/chisel-wiki query 支付              # 查询相关知识
/chisel-wiki health                  # 检查引用有效性
/chisel-wiki list                    # 列出所有条目
/chisel-wiki import file.json        # 批量导入
```

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

### 中断检测

task 处于 `coding`/`repairing` 状态超 30 分钟时，orchestration-status 输出 stale warning。

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
| `/chisel-status` | 查看恢复点和 task 状态 |
| `/chisel-wiki` | 独立知识库管理 |

### Agents

| Agent | 说明 |
|---|---|
| `agent-chisel-writer` | 从结构化产物生成人类可读文档（sonnet） |
| `agent-chisel-coder` | 按 confirmed task 编码实现（sonnet） |
| `agent-chisel-coder-light` | trivial task 快速编码（haiku） |
| `agent-chisel-coder-heavy` | complex task 深度编码（opus） |
| `agent-chisel-reviewer` | 多维度 CR，单维度/次深度审查（opus） |

### Scripts

| 脚本 | 说明 |
|---|---|
| `orchestration-status.mjs` | 恢复点判定和复杂度检测 |
| `gate-check.mjs` | 阶段 postcondition gate 校验 |
| `task-init.mjs` | 初始化 task 文件和状态机 |
| `workflow-status.mjs` | task 状态查询、回退、overlap 检测 |
| `wiki-manage.mjs` | wiki 初始化、合入、查询、health-check |
| `scope-check.mjs` | 文件边界和禁区校验 |
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
