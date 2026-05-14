---
name: legacy-help
description: legacy-feature 插件的共享契约和模板索引。不单独执行。
disable-model-invocation: true
---

# legacy-help

共享契约 skill，不直接面向用户。

## 契约文件

| 文件 | 用途 |
|------|------|
| `workflow.yaml` | 阶段定义和 task 状态机 |
| `orchestration.yaml` | 编排步骤和 gate 映射 |
| `references/as-is-template.md` | as-is 产物模板 |
| `references/to-be-template.md` | to-be 方案模板 |
| `references/task-template.md` | task 文件模板 |
| `references/task-report-template.md` | coding report 模板 |
| `references/cr-template.md` | CR 模板 |

## 运行态目录

`.legacy-feature/<idea-name>/`

## 加载方式

agent 和 skill 按需 Read 具体文件，不要一次全部加载。
