---
name: chisel-contracts
description: chisel 插件的共享契约和模板索引。不单独执行。
disable-model-invocation: true
---

# chisel-contracts

共享契约 skill，不直接面向用户。

## 契约文件

| 文件 | 用途 |
|------|------|
| `workflow.yaml` | 阶段定义和 task 状态机 |
| `orchestration.yaml` | 编排步骤和 gate 映射 |
| `references/task-template.md` | task 文件模板，包含 task frontmatter 元数据 |
| `references/clarifications-template.md` | understand:confirm 产物模板 |
| `references/knowledge-candidates-template.md` | 单次迭代结束后的长期知识候选模板 |
| `references/final-summary-template.md` | final:summary 产物模板 |
| `references/phase-confirm-details.md` | confirm/final/merge/知识捕获阶段的详细行为指南 |
| `references/phase-task-init.md` | task 初始化阶段指南 |
| `references/phase-knowledge-extract.md` | 知识提取阶段指南 |

## 运行态目录

`.chisel/<idea-name>/`

## 长期知识目录

`.chisel/wiki/{project-name}/`（project-name = git 仓库名）

长期知识用于跨需求复用，包括术语、禁区、包袱、暂不重构坏味道、模块地图和 ADR 索引。单次迭代中发现的新知识先写入 `.chisel/<idea-name>/knowledge-candidates/`，不要自动合入长期 wiki。

## 加载方式

agent 和 skill 按需 Read 具体文件，不要一次全部加载。优先读取当前 task 的 `Context to Load`，只在任务触碰对应模块、禁区、包袱、坏味道或 ADR 时加载相关 wiki 文件。
