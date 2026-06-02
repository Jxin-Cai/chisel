# To-Be 实现方案模板

确认目标行为、边界、验证和回滚。不夹带未经确认的大重构。

## 目标行为

## 非目标行为

## 方案总览

## 改造点映射

基于 as-is 调用链（引用 `as-is/ai-input/call-graph.md`），标注每个链路节点的改造决策。

| # | 链路节点 | as-is 行为 | 改造决策 | 改造内容摘要 | 关联 CP |
|---|---------|-----------|---------|------------|--------|
| 1 | EntryPoint A | 接收请求并校验 | **保留** | — | — |
| 2 | Service.method() | 执行业务逻辑 | **改造** | 新增分支处理 X 场景 | CP-1 |
| 3 | Repository.save() | 持久化 | **保留** | — | — |
| 4 | EventPublisher | 发布事件 | **新增** | 新建节点，处理 Y 事件 | CP-2 |

改造决策取值：
- `保留`：复用现有逻辑不动，作为上下游透传
- `改造`：修改现有节点的行为或接口
- `新增`：链路上新增节点（此前不存在）
- `删除`：移除现有节点（需说明替代方案）

### 改造点详情

> 每个非「保留」节点一个 CP 条目。CP 编号贯穿本文档、tasks.json、impact-risk-report.json。

#### CP-1: Service.method() — 新增分支处理 X 场景

- **做什么（一句话）**：新增 X 场景处理分支，确保 Y 输入得到 Z 行为。
- **影响（一句话）**：影响 Service.method() 的下游持久化/返回语义，但保持既有 A 场景不变。
- **当前行为**：...（引用 call-graph 中的 evidence / facts.md 中的 F-xxx）
- **目标行为**：...
- **修改方式**：...（具体到函数级别，如"在 X 函数第 N 行后插入分支判断"）
- **影响的上游节点**：...
- **影响的下游节点**：...
- **行为不变量**：...（不能破坏的现有契约、幂等性、兼容性承诺）
- **对应 Task**：task-001

#### CP-2: EventPublisher — 新建事件发布

- **当前行为**：（不存在）
- **目标行为**：...
- **修改方式**：新增文件/类
- **影响的上游节点**：Service.method()（需从此处调用）
- **影响的下游节点**：无（终端节点）
- **行为不变量**：不影响主流程同步返回
- **对应 Task**：task-002

## 允许修改范围

| 范围 | 原因 | 对应 CP | 备注 |
|---|---|---|---|
| | | | |

## 禁止修改范围

| 范围 | 原因 | 触碰条件 |
|---|---|---|
| | | |

## 需要保留的历史行为

## Context to Load

- as-is：
- wiki：
- module map：
- ADR：

## 方案详情

> 按 CP 编号展开，每个 CP 对应一段详细设计。有涉及则展开，无涉及则跳过以下维度：接口层改动、业务逻辑改动、持久化/数据模型改动、API 契约变更、数据迁移或兼容方案、并发安全与幂等性、事务边界与数据一致性、错误处理。

## Verification Surface

## 回滚方案

## 风险清单

| 风险 | 等级 | 关联 CP | 缓解方式 |
|---|---|---|---|
| | low / medium / high | | |

## 知识候选处理策略

## Task 拆分建议

每个 Task 必须通过 `trace_refs` 关联到一个或多个需求/验收/验证追踪项，并通过 `change_point_refs` 关联到一个或多个 CP。

同时写入 `to-be/traceability-matrix.json`。该文件表达需求链路，不要把 `RISK-*` 当作需求项；风险放入 `impact-risk-report.json.risk_matrix`，如需追踪风险缓解，可使用 `type: "risk_mitigation"`，dashboard 不计入需求覆盖率。

```json
{
  "items": [
    {
      "id": "AC-001",
      "type": "acceptance_criteria",
      "source": "requirement-clarification.json",
      "source_refs": ["REQ-001", "C-001"],
      "description": "用户创建时拒绝空名称",
      "cp_refs": ["CP-1"],
      "coverage_refs": ["E-001", "L-001", "D-001", "S-001"],
      "covered_by_tasks": ["task-001"]
    },
    {
      "id": "AC-001/VC-001",
      "type": "verification_condition",
      "source": "requirement-clarification.json",
      "source_refs": ["AC-001", "VC-001"],
      "description": "空名称请求返回 400 且不写库",
      "cp_refs": ["CP-1"],
      "coverage_refs": ["E-001", "D-001", "S-001"],
      "covered_by_tasks": ["task-001"]
    }
  ]
}
```

同时写入 `to-be/tasks.json`（task-init.mjs 做 schema 校验）：

```json
{
  "tasks": [
    {
      "task_id": "task-001",
      "depends_on": [],
      "title": "实现某个业务能力",
      "goal": "本 task 完成的目标行为",
      "change_point_refs": ["CP-1"],
      "allowed_files": ["src/a.ts"],
      "forbidden_files": [],
      "expected_files": ["src/a.ts"],
      "trace_refs": ["REQ-001"],
      "acceptance_criteria": ["满足某个可验证行为"],
      "behavior_invariants": ["需要保持的旧行为、接口契约或包袱"],
      "impact_surface": {"files": ["src/a.ts"], "symbols": [], "invariants": [], "shared_state": []},
      "context_to_load": {"as_is": [], "to_be": [], "wiki": [], "module_map": [], "adr": []},
      "risk_level": "low",
      "rollback": "回退本 task 修改的文件"
    }
  ]
}
```

必填字段：`behavior_invariants`、`impact_surface`、`context_to_load`、`change_point_refs` 必须填写，即使为空数组也要显式给出结构，供 task-init、并行调度和 coder 上下文加载使用。

可选字段：`allowed_symbols`、`forbidden_symbols`、`exports`、`imports`、`modification_hints`、`task_complexity`。

- `change_point_refs`：本 task 对应的改造点 CP 编号列表。
- `exports`：本 task 产出的、可被其他 task 引用的符号或文件（如新增的函数、类型、配置）。
- `imports`：本 task 依赖的、由其他 task 产出的符号或文件（引用 `exports` 的 task_id）。
- `modification_hints`：string[] — 给 coder 的修改提示（如"在 X 函数后添加 Y 调用"），降低上手成本。
- `task_complexity`："trivial" | "standard" | "complex"（可选，默认 "standard"）— 决定 coder agent 模型选择：trivial→haiku, standard→sonnet, complex→opus。

同时写入 `to-be/impact-risk-report.json`（详见独立 schema 定义）。

> **flow_graph 必填说明**：impact-risk-report.json 的 `flow_graph` 字段描述功能全链路，nodes 包含链路上所有节点（保留/改造/新增/删除），edges 按调用/数据流方向连接。dashboard 据此自动渲染带颜色标记的全链路改造视图：灰色=保留、蓝色=改造、绿色=新增、红色=删除。

如涉及 DB 表/字段/关系新增、修改、删除，同时写入 `to-be/data-change-plan.json`：

```json
{
  "schema_version": 1,
  "summary": {"has_db_changes": true, "change_count": 1, "compatibility": "compatible", "notes": "新增可空字段，不影响旧写入路径"},
  "entities": [
    {
      "name": "users",
      "display_name": "用户表",
      "change_type": "modify",
      "description": "用户表新增 last_login_at 用于登录审计",
      "fields": [
        {"name": "last_login_at", "change_type": "add", "before": null, "after": {"type": "timestamp", "nullable": true, "default": null, "comment": "最后登录时间"}, "impact": "新增可空字段，不影响旧写入路径", "cp_refs": ["CP-2"], "task_refs": ["task-002"]}
      ],
      "relations": []
    }
  ],
  "migrations": []
}
```

如涉及 API endpoint、请求字段、响应字段、错误码、鉴权契约新增、修改、删除，同时写入 `to-be/api-change-plan.json`：

```json
{
  "schema_version": 1,
  "summary": {"has_api_changes": true, "change_count": 1, "compatibility": "compatible", "notes": "新增可选响应字段，旧客户端可忽略"},
  "endpoints": [
    {
      "id": "API-001",
      "method": "POST",
      "path": "/users",
      "change_type": "modify",
      "description": "创建用户接口新增 nickname 入参",
      "request": {"params": [], "query": [], "headers": [], "body": [{"name": "nickname", "change_type": "add", "before": null, "after": {"type": "string", "required": false, "description": "用户昵称"}, "impact": "可选字段，兼容旧客户端"}]},
      "response": {"status_codes": [], "body": []},
      "errors": [],
      "compatibility": "compatible",
      "cp_refs": ["CP-1"],
      "task_refs": ["task-001"]
    }
  ]
}
```

## 变更完整性自检结果

> Planner 必须填写此章节，证明已执行伴生变更推断。

### 伴生变更推断

| CP | 触发的规则 | 伴生产物 | 已安排在 | 备注 |
|----|-----------|---------|---------|------|
| CP-1 | DB model 字段变更 | migration | task-002 | ALTER TABLE users ADD ... |
| CP-2 | 新增 API | 路由+DTO+文档 | task-003 | — |

无触发规则的 CP 填「无适用规则」。

### Spec 覆盖率

- 总 AC 数：X
- 已覆盖：X
- 未覆盖：无（或列出遗漏并说明原因）

### CP-Task 一致性

- 所有 CP 均有 task 覆盖：✅ / ❌（列出孤立 CP）
