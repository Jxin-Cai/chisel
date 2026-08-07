---
name: chisel-contracts
description: chisel 插件的共享契约、执行协议和模板索引。承接跨 orchestrator、agent 和阶段 skill 复用的状态纪律、证据协议与上下文隔离规则。不单独执行。
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

## 协议文件

跨角色复用的执行协议。按当前角色加载最小必要内容：

| 角色 | 必须加载 | 说明 |
|---|---|---|
| 主编排器 | `references/protocols/iron-rules.md` | 状态恢复、步骤切换、gate 与完成证据纪律 |
| 所有 Chisel agent | `references/protocols/agent-protocol.md` | Wiki、知识候选、proof、模板和上下文隔离协议 |
| 维护 Chisel 自身 | `references/protocols/principle-enforcement-map.md` | 原则到 script/hook/prompt 的执法映射 |
| coder agent | `references/protocols/agent-protocol.md`，再加载 `../chisel-implement/references/coder-instructions.md` | coder 流程归属于 implement skill，不属于公共层 |

只加载当前角色对应的文件。不要因引用本 skill 而一次性读取全部 references。

### 协议边界规则

1. 只收纳至少被两个独立 skill 或 agent 使用的稳定协议。
2. 将阶段动作、模板、输出格式和角色专属步骤保留在对应 skill 中。
3. 由上层 skill 或 agent 先 Read 本文件，再按角色加载具体协议；禁止直接依赖匿名共享目录。
4. 对公共协议的路径或名称做变更时，运行全量测试，确保所有 `${CLAUDE_PLUGIN_ROOT}` 引用仍可解析。
5. 公共原则只能在一处定义；其他文件使用链接或路径引用，不复制全文。

## 运行态目录

`control-plane.mjs --project-root . --idea <idea-name>` 的输出（默认 Git common root 下 `.chisel/<idea-name>/`）

## 加载方式

agent 和 skill 按需 Read 具体文件，不要一次全部加载。优先读取当前 task 的 `Context to Load`。
