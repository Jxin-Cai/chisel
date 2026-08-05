---
name: chisel-branch
description: 当用户说"转分支"、"合并分支"、"merge"、"sync"、"冲突分析"、"合并到主干"、"同步主干"时触发。
argument-hint: "<convert|merge-to-main|sync-from-main> [idea-name]"
---

# 分支管理工具

用户参数：`$ARGUMENTS`

---

## 子命令路由

从 `$ARGUMENTS` 解析子命令和 idea-name：

| 子命令 | 作用 |
|--------|------|
| `convert [idea-name]` | 将 worktree 转为常规分支（删除 worktree 保留分支+提交记录） |
| `merge-to-main [idea-name]` | 将特性分支合并到主干（含冲突智能分析） |
| `sync-from-main [idea-name]` | 将主干最新变更同步到特性分支（含冲突智能分析） |

若未指定 idea-name，检查当前工作目录下的 `.chisel/` 是否有唯一活跃 idea（只有一个包含 `worktree-decision.json` 的子目录）。若有多个，列出让用户选择。

---

## convert 流程

### 1. 读取决策文件

```bash
cat .chisel/<idea-name>/worktree-decision.json
```

若文件不存在或 `mode` = `current-branch`，告知用户当前未使用 worktree 隔离，无需转换。

### 2. 执行转换

**单仓模式**（schema_version=1 或无 repos 字段）：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/branch-merge.mjs --convert <branch_name> --repo .
```

**多仓模式**（schema_version=2，repos 数组非空）：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/multi-repo-worktree.mjs --convert <idea-name> --repos <repo1,repo2,...>
```

### 3. 处理结果

- `status: "converted"` → 告知用户："Worktree 已移除，分支 `<branch>` 保留了 N 个提交。当前已切换到该分支，后续可按常规 git 流程操作。"
- `status: "uncommitted_changes"` → 告知用户有未提交的变更，列出脏文件，建议先 commit 或 stash
- `status: "worktree_not_found"` → 告知 worktree 可能已被手动移除，检查分支是否还在：`git branch --list <branch_name>`

### 4. 更新决策文件

转换成功后，更新 `worktree-decision.json` 添加 `converted_at` 字段：

```json
{
  "converted_at": "<ISO 8601 timestamp>"
}
```

---

## merge-to-main 流程

### 1. 确定分支

```bash
FEATURE_BRANCH=$(git branch --show-current)
DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's|refs/remotes/origin/||' || echo main)
```

若有 `worktree-decision.json`，从中读取 `branch_name` 作为特性分支名。

### 2. 展示将合并的变更

```bash
git log --oneline ${DEFAULT_BRANCH}..${FEATURE_BRANCH}
```

向用户确认是否继续合并。

### 3. 执行合并（含冲突分析）

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/branch-merge.mjs --merge --source <feature-branch> --target <default-branch> --repo .
```

### 4. 处理结果

- `status: "merged"` → 告知合并成功，展示合并后的分支状态
- `status: "conflicts_detected"` → 展示冲突分析详情：
  1. 列出所有冲突文件及分类（auto_resolvable / true_conflict）
  2. 对 auto_resolvable 的文件说明双方改动不在同一区域
  3. 对 true_conflict 的文件展示具体冲突行范围和推荐策略
  4. 使用 `AskUserQuestion` 询问用户：

  | 选项 | 描述 |
  |------|------|
  | 自动解决可解冲突 | 自动合并不重叠的改动，真实冲突仍需手动处理 |
  | 全部手动处理 | 不自动解决，我自己处理所有冲突 |
  | 放弃合并 | 取消本次合并操作 |

  若用户选"自动解决可解冲突"且存在 true_conflict：
  ```bash
  node ${CLAUDE_PLUGIN_ROOT}/scripts/branch-merge.mjs --merge --source <feature-branch> --target <default-branch> --repo . --auto-resolve
  ```
  然后告知用户哪些文件已自动解决，哪些仍需手动处理。

**多仓模式**：对 `worktree-decision.json` 中每个 repo 依次执行上述流程，汇总结果。

---

## sync-from-main 流程

### 1. 确定分支

与 merge-to-main 相同方式确定两个分支。

### 2. 展示主干新变更

```bash
git log --oneline ${FEATURE_BRANCH}..${DEFAULT_BRANCH}
```

向用户确认是否同步。

### 3. 执行合并

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/branch-merge.mjs --merge --source <default-branch> --target <feature-branch> --repo .
```

### 4. 处理结果

与 merge-to-main 的结果处理逻辑完全相同。

---

## 错误处理

| 场景 | 处理 |
|------|------|
| 未在 git 仓库中 | 报错退出 |
| 当前分支已是主干 | merge-to-main 报错"当前已在主干分支" |
| worktree-decision.json 不存在 | 从 git 当前状态推断分支信息 |
| 脚本执行失败 | 展示错误信息，不做破坏性操作 |
