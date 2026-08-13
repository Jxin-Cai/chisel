---
name: chisel-hotol
description: 当用户要求 HOTOL、无人值守、无需确认、一路开发并合并到主干，或调用 /chisel-hotol 时触发。
argument-hint: "<需求描述或需求文件路径>"
disable-model-invocation: true
---

# Chisel HOTOL Orchestrator

HOTOL（Human Out Of The Loop）是 `/chisel` 的显式无人值守模式。用户参数：`$ARGUMENTS`

先完整 Read `${CLAUDE_PLUGIN_ROOT}/skills/chisel/SKILL.md`、`${CLAUDE_PLUGIN_ROOT}/skills/chisel-contracts/SKILL.md`
和主编排器要求的铁律，然后执行同一权威 workflow-definition、runner、gate、验证、CR 与返修闭环。本文件只覆盖
交互决策和最终交付行为；不得降低任何机器 gate、测试、对抗审查、CR、追溯或新鲜性要求。

## 启用与持久化

创建/定位 `{IDEA_DIR}` 后、开始任何会停顿的步骤前运行：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/execution-mode.mjs {IDEA_DIR} --enable-hotol --target default
```

`execution-mode.json` 是唯一模式授权。没有该文件时一律按普通交互模式执行；禁止把已有普通 workflow 静默升级为
HOTOL。默认只授权合并到每个仓库的本地默认主干，不授权 push、force push、删除分支/worktree 或放弃变更。

## 不停顿契约

从接收需求开始，在同一长程执行中持续调用 runner，直到所有仓库的主干合并 receipt 成功，或产生不可安全继续的
真实阻塞。不得调用 `AskUserQuestion`，不得因交付报告、阶段完成、上下文变长、agent 返回或普通歧义而停顿。

- 低风险歧义：采用最保守、可逆、向后兼容、范围最小且可验证的默认值，并把假设写入
  `requirement-clarification.json`、`requirement.md` 和最终总结。
- 业务语义、数据迁移、安全/权限等高风险缺口：优先从仓库契约、测试、调用方和历史模式取得证据；仍无法得到唯一安全
  结论时写入 `{IDEA_DIR}/hotol-blocked.json`（原因、证据、已尝试路径、恢复条件），进入 `blocked`，直接报告，不向用户提问。
- 权限、凭据、外部服务、真实 merge conflict 或连续重试上限同样形成终态阻塞；不得伪造成功或降低 gate。

## 交互步骤覆盖

| 步骤 | HOTOL 行为 |
|---|---|
| `clarify:requirement` | 自主完成 gap analysis，以保守默认值消除未决问题，生成 canonical requirement 后运行 `hotol-approve.mjs {IDEA_DIR} --requirement`；不展示后等待 hash 确认 |
| `understand:confirm` | 生成、交付并校验 As-Is 报告后立即推进；本步骤本来就不需要确认 |
| `plan:confirm` | 仅在对抗审查 gate 通过后生成 To-Be HTML，取 `reports.mjs` 返回的 SHA-256，运行 `hotol-approve.mjs {IDEA_DIR} --to-be --expected-sha <sha>`，再验证 `to-be-report-confirmed` |
| `worktree:setup` | 自动选择所有检测到的 Git 仓库和隔离 worktree；不询问仓库列表或 current-branch 策略。创建失败时诊断并重试，仍失败则阻塞 |
| `review:merge` | 生成当前快照和统一 CR HTML；只有 readiness 为 ready、全量验证/CR/gate 均通过时，运行 `hotol-approve.mjs {IDEA_DIR} --merge` |
| `done` | 不显示交付菜单；自动执行下方“合并到主干”，所有 receipt 成功后才创建 `.done` |

直接路径虽不经过 workflow 的 `worktree:setup` step，也必须在编码前创建隔离 worktree 并写入
`worktree-decision.json`/registry。若启动仓库存在未提交用户改动，不得搬运、stash 或混入；记录阻塞，避免覆盖用户工作。

## 提交与最终快照

最终全量验证之前，在每个开发 worktree 中只暂存本需求 provenance/scope 覆盖的文件并创建普通 Git commit。
不得暂存 `.chisel/` 控制面或需求范围外的既有改动。commit 后重新运行 full verification、CR 报告和 merge review，
确保批准绑定 clean HEAD；任何后续代码变化都必须重新执行这条链路。

## 合并到主干

从 schema v3 registry / `worktree-decision.json` 逐仓读取 `repo_path`、开发 `branch` 和 `default_branch`，禁止硬编码
`main`。对每个仓库执行：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/branch-merge.mjs --merge \
  --source <feature-branch> --target <default-branch> --repo <repo-path> \
  --idea <idea-name> --hotol --update-local-target \
  --verify-command-json '<该仓库 required check 的 argv JSON>'
```

`--hotol` 必须验证持久授权；`--update-local-target` 只有在目标 ref 未漂移且目标 checkout 干净时才推进本地主干。
冲突时保留 integration worktree，按 base/ours/theirs 自动解决仅有唯一机器可验证答案的冲突，重跑 required checks 后用
`--continue --hotol --idea ... --update-local-target`；有多种合理语义时进入 blocked，不询问用户也不武断选择。

逐仓命令结束后运行 `node ${CLAUDE_PLUGIN_ROOT}/scripts/hotol-approve.mjs {IDEA_DIR} --complete-delivery`。该命令只有在
每份 receipt 同时满足 `status=merged` 且 `local_target.status=updated` 时才原子创建 `{IDEA_DIR}/.done`；禁止直接 touch
该 marker。随后给出最终总结。
不自动 push；只有用户在最初命令中明确要求推送远端时，启用模式时追加 `--push`，交付命令也追加 `--push`。

## 优先级

机器 gate 与状态机仍高于本 skill。普通 chisel 的“必须等用户确认”规则在且仅在有效 HOTOL 授权存在时，由上述确定性
自动确认命令替代；这不是跳过确认，而是把用户在启动 HOTOL 时授予的决策范围绑定到具体产物 hash 和 Git 快照。
