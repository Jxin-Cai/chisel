---
name: chisel-help
description: chisel 插件的共享契约和模板索引。不单独执行。
disable-model-invocation: true
---

# chisel-help

共享契约 skill，不直接面向用户。

## 契约文件

| 文件 | 用途 |
|------|------|
| `workflow.yaml` | 阶段定义和 task 状态机 |
| `orchestration.yaml` | 编排步骤和 gate 映射 |
| `references/as-is-template.md` | as-is 产物模板 |
| `references/to-be-template.md` | to-be 方案模板 |
| `references/task-template.md` | task 文件模板，包含 task frontmatter 元数据 |
| `references/task-report-template.md` | coding report 模板 |
| `references/cr-template.md` | CR 模板 |
| `references/llm-wiki-index-template.md` | `.chisel/wiki/{project-name}/` 根入口模板和渐进加载规则 |
| `references/glossary-template.md` | 项目术语模板 |
| `references/forbidden-zones-template.md` | 禁区模板：不能动或需确认后才能动的区域 |
| `references/weird-but-intentional-template.md` | 包袱模板：看似奇怪但有意保留的设计 |
| `references/do-not-refactor-yet-template.md` | 坏味道模板：当前不要顺手重构的区域 |
| `references/module-map-template.md` | 模块地图模板，按任务触碰模块渐进加载 |
| `references/knowledge-candidates-template.md` | 单次迭代结束后的长期知识候选模板 |
| `references/requirement-template.md` | receive-requirement 产物模板 |
| `references/clarifications-template.md` | understand:confirm 产物模板 |
| `references/final-summary-template.md` | final:summary 产物模板 |
| `references/phase-confirm-details.md` | confirm/final/merge/知识捕获阶段的详细行为指南 |
## 运行态目录

`.chisel/<idea-name>/`

## 长期知识目录

`.chisel/wiki/{project-name}/`（project-name = git 仓库名）

长期知识用于跨需求复用，包括术语、禁区、包袱、暂不重构坏味道、模块地图和 ADR 索引。单次迭代中发现的新知识先写入 `.chisel/<idea-name>/knowledge-candidates/`，不要自动合入长期 wiki。

## 加载方式

agent 和 skill 按需 Read 具体文件，不要一次全部加载。优先读取当前 task 的 `Context to Load`，只在任务触碰对应模块、禁区、包袱、坏味道或 ADR 时加载相关 wiki 文件。
