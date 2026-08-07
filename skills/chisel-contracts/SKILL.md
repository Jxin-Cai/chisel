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
| `workflow-definition.json` | 编排 step / phase / gate / complexity path 的唯一定义 |
| `orchestration.yaml` | 从 canonical JSON 生成的旧消费者兼容投影 |
| `references/task-template.md` | task 文件模板，包含 task frontmatter 元数据 |
| `references/clarifications-template.md` | understand:confirm 产物模板 |
| `references/final-summary-template.md` | final:summary 产物模板 |
| `references/phase-confirm-details.md` | confirm/final/merge 阶段的详细行为指南 |
| `references/phase-task-init.md` | task 初始化阶段指南 |

## 运行态目录

`control-plane.mjs --project-root . --idea <idea-name>` 的输出（默认 Git common root 下 `.chisel/<idea-name>/`）

## 加载方式

agent 和 skill 按需 Read 具体文件，不要一次全部加载。优先读取当前 task 的 `Context to Load`。
