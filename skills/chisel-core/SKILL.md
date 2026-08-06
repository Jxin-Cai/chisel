---
name: chisel-core
description: Chisel 的公共执行契约 skill，承接跨 orchestrator、agent 和阶段 skill 复用的状态纪律、证据协议与上下文隔离规则。仅供 Chisel 上层 skill 和 agent 显式引用，不作为独立用户工作流执行。
user-invocable: false
disable-model-invocation: true
---

# Chisel Core

集中承接真正跨角色复用的执行协议。将角色专属流程保留在所属 skill 内，禁止把仅由单一阶段使用的说明重新放入本 skill。

## 加载协议

按当前角色加载最小必要内容：

| 角色 | 必须加载 | 说明 |
|---|---|---|
| 主编排器 | `references/iron-rules.md` | 状态恢复、步骤切换、gate 与完成证据纪律 |
| 所有 Chisel agent | `references/agent-protocol.md` | Wiki、知识候选、proof、模板和上下文隔离协议 |
| 维护 Chisel 自身 | `references/principle-enforcement-map.md` | 原则到 script/hook/prompt 的执法映射 |
| coder agent | `references/agent-protocol.md`，再加载 `../chisel-implement/references/coder-instructions.md` | coder 流程归属于 implement skill，不属于公共层 |

只加载当前角色对应的文件。不要因引用本 skill 而一次性读取全部 references。

## 边界规则

1. 只收纳至少被两个独立 skill 或 agent 使用的稳定协议。
2. 将阶段动作、模板、输出格式和角色专属步骤保留在对应 skill 中。
3. 由上层 skill 或 agent 先 Read 本文件，再按角色加载具体协议；禁止直接依赖匿名共享目录。
4. 对公共协议的路径或名称做变更时，运行全量测试，确保所有 `${CLAUDE_PLUGIN_ROOT}` 引用仍可解析。
5. 公共原则只能在一处定义；其他文件使用链接或路径引用，不复制全文。

## 资源

- `references/iron-rules.md`：不可绕过的工作流原则与运行纪律。
- `references/agent-protocol.md`：所有 agent 共享的证据、知识和上下文协议。
- `references/principle-enforcement-map.md`：设计原则的确定性执法映射与 bug 分诊方法。
