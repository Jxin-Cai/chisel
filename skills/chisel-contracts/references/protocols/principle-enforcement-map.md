# 原则执法映射

本文档描述每条设计原则在各层的执法机制，以及 bug 分诊协议。

---

## 执法层级总览

| 层级 | 强度 | 特征 | 适用场景 |
|------|------|------|----------|
| 脚本（script） | 最强 | 确定性、不可绕过 | 状态转移、gate 校验、枚举覆盖检查 |
| Hook | 强 | 响应式（边界拦截） | 写保护、终止拦截、提醒注入 |
| Prompt | 中 | 依赖模型遵循 | 执行质量、判断约束 |

---

## 原则 → 执法机制

### P1: 穷举枚举

| 执法层 | 机制 | 文件 |
|--------|------|------|
| 脚本 | `enum-coverage-check.mjs` 静态检查枚举在所有消费处的覆盖 | `scripts/enum-coverage-check.mjs` |
| 机器定义 | `workflow-definition.json` 作为 step / phase / gate / complexity path 的唯一枚举源 | `skills/chisel-contracts/workflow-definition.json` |
| Prompt | Iron Rule #9: 修 P1 bug 时运行 enum-coverage-check | `iron-rules.md` |

**已知违规案例（0.21.1–0.21.2）：**
- `STEP_TO_PHASE` 缺 `review:cr-moderate`
- `hooks.json` PostToolUse matcher 缺 `Edit`
- `dashboard.mjs` detectComplexity 不支持 hotfix/minor/moderate
- `cr-parse` --type 索引在 splice 后错位

### P2: 状态转移完整性

| 执法层 | 机制 | 文件 |
|--------|------|------|
| 脚本 | `VALID_TRANSITIONS` 集合，非法转移抛错 | `scripts/workflow-lib.mjs` |
| 脚本 | durable transaction journal 保证 workflow event/state 和 task provenance/state 崩溃后 roll-forward | `scripts/file-transaction.mjs` |
| 脚本 | runner + task `run_id`/owner/lease/heartbeat 防止双重执行与旧 run 提交 | `scripts/orchestration-runner.mjs`, `scripts/task-provenance.mjs` |
| Hook | `pre-tool-write-guard` 禁止 Write/Edit 及 Bash 直接写机器状态 | `hooks/pre-tool-write-guard.mjs` |
| Hook | `stop-gate-guard` 阻止未满足 postcondition 的停止 | `hooks/stop-gate-guard.mjs` |
| Prompt | Iron Rule #1/#2/#4: 状态文件是真相/禁止跳步/每轮调用 | `iron-rules.md` |

**历史回归案例（现由上述机制覆盖）：**
- `markCr` 守卫允许重复调用导致 `rework_count` 多次递增
- `--start-task` 绕过 rework 上限（needs_rework+count≥MAX 仍可转 repairing）
- `rollbackTask` 未重置 `rework_count`
- 残留 `.done` 文件使 done gate 在 allTasksApproved=false 时通过

### P3: 边界快速失败

| 执法层 | 机制 | 文件 |
|--------|------|------|
| 脚本 | `parseScalar` try-catch、`readTaskState` 文件存在检查 | `scripts/workflow-lib.mjs` |
| 脚本 | `gate-check` 每个 gate 入口检查文件/字段存在性 | `scripts/gate-check.mjs` |
| Hook | `pre-tool-write-guard` 校验路径格式 | `hooks/pre-tool-write-guard.mjs` |

**历史回归案例（现由上述机制覆盖）：**
- `parseScalar` 中 `JSON.parse` 未 try-catch
- `task.report_file` 可能 undefined 导致 `join()` 崩溃
- `scope-check` `/*` glob 缺少深度限制导致跨目录误匹配
- `as-is-score` 使用错误变量名 `MIN_DIMENSION_SCORE`

### P4: 副作用一致性

| 执法层 | 机制 | 文件 |
|--------|------|------|
| 脚本 | `rollbackWorkflow` 级联清理下游状态 | `scripts/workflow-lib.mjs` |
| Hook | `post-tool-write-reminder` 写完产物后提醒跑 gate | `hooks/post-tool-write-reminder.mjs` |
| Hook | `stop-gate-guard` 验证当前步骤 postcondition 完整 | `hooks/stop-gate-guard.mjs` |
| Prompt | Iron Rule #5: 每步完成验证 gate | `iron-rules.md` |

**历史回归案例（现由上述机制覆盖）：**
- `rollback` 后 dashboard phase 未重置为 pending
- `orchestration-status` 冗余 done 检查位于 allTasksApproved guard 之外

### P5: 唯一正规来源

| 执法层 | 机制 | 文件 |
|--------|------|------|
| 脚本 | `workflow-lib.mjs` 导出共享枚举/函数供其他脚本导入 | `scripts/workflow-lib.mjs` |
| 脚本 | `enum-coverage-check.mjs` 检测重复定义 | `scripts/enum-coverage-check.mjs` |
| 脚本 | `workflow-projector.mjs` 从 canonical JSON 生成旧 YAML 投影 | `scripts/workflow-projector.mjs` |

`dashboard.mjs`、`orchestration-status.mjs` 和状态机均从 `workflow-definition.json` 派生路径；复杂度检测统一复用 `workflow-lib.mjs`。

---

## Bug 分诊协议

遇到新 bug 时，按以下决策树操作：

```
┌─ 1. 分类：违反了哪条原则？
│   ├─ 新变体未传播到所有路由表？ → P1
│   ├─ 状态变更遗漏副作用或存在旁路？ → P2
│   ├─ 外部输入 undefined/malformed 导致崩溃？ → P3
│   ├─ 改了 X 但读 X 的下游未同步？ → P4
│   └─ 同一逻辑在两处独立演化出分歧？ → P5
│
├─ 2. 定位正规执法层：
│   ├─ 能否用脚本让此类 bug 结构性不可能？ → 优先选脚本层
│   ├─ 能否用 hook 在边界拦截？ → 次选 hook 层
│   └─ 只能靠模型自律？ → 最后选 prompt 层（加 HARD-GATE + 反模式表）
│
├─ 3. 确定修复范围：
│   ├─ P1: grep 该枚举的全部消费处，全部修复，运行 enum-coverage-check
│   ├─ P2: 修正正规函数，添加 assertion/invariant 防重入
│   ├─ P3: 在入口加 guard clause，检查有无其他调用者共享此入口
│   ├─ P4: 识别所有下游读者，确保一致性，考虑重构使耦合显式化
│   └─ P5: 提取到唯一来源，所有副本改为导入
│
└─ 4. 防范同类：
    ├─ 能否添加静态检查让此类 bug 下次被自动捕获？
    └─ 能否重构使此类 bug 在结构上不可能发生？
```

---

## Commit 规范

修 bug 的 commit message 应包含原则标记：

```
fix: [P1] STEP_TO_PHASE 补全 review:cr-moderate 映射
fix: [P2] markCr 添加幂等守卫防止 rework_count 重复递增
fix: [P3] parseScalar 添加 try-catch 防止 JSON 畸形崩溃
```
