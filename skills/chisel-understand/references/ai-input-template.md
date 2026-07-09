# AI 输入版模板

供 Planner agent 使用，紧凑、字段化、无叙事。

**与人类学习版的区别**：
- 人类版 = 叙事 + 图表 + 业务语义解释（为人类理解而写）
- AI 版 = 纯结构化表格 + 证据引用（为 Planner agent 消费而写）
- 不要从人类版复制叙事段落、Mermaid 图或解释文字，只提取结构化字段

---

## facts.md

`[F-xxx]` 必须来自 evidence-ledger，不允许新增未入账事实。

```
## Source Coverage

| Source | Covered refs | Omissions | Reason |
|---|---|---|---|
| as-is/evidence-ledger.json | F-001, F-002 | 无 | — |

## 已确认事实

- [F-001] <事实描述> | 证据: <file:line>
- [F-002] <事实描述> | 证据: <file:line>

## 推断（待确认）

- [I-001] <推断描述> | 依据: <file:line> | 置信度: 高/中/低

## 能力边界

- 当前支持: <能力列表>
- 当前不支持: <能力列表>
```

---

## call-graph.md

```
## 调用链

| 调用方 | 被调方 | 类型 | 说明 | 证据 |
|-------|-------|------|------|------|
| Controller.create | Service.createOrder | sync | 创建订单主入口 | src/controller.ts:42 |
| Service.createOrder | Repository.save | sync | 持久化 | src/service.ts:78 |

## 入口→终点映射

| 入口 | 最终写入 | 最终读取 | 外部调用 |
|------|---------|---------|---------|
| POST /api/order | order, order_item | user, product | 无 |

## 前端→API 映射

> 当 coverage-matrix 有 `ui_entries` 时必须填写。无前端则写「不涉及前端」。

| 前端页面/组件 | 路由 | API 调用 | 后端 Controller | 证据 |
|-------------|------|---------|----------------|------|
| pages/orders/index.tsx | /orders | GET /api/orders | OrderController.list | pages/orders/index.tsx:15 → src/controller/order.ts:20 |
| pages/orders/[id].tsx | /orders/:id | GET /api/orders/:id | OrderController.get | pages/orders/[id].tsx:22 → src/controller/order.ts:35 |
```

---

## data-schema.md

```
## 表清单

### <table_name>

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | bigint | PK | 主键 |
| status | varchar(32) | NOT NULL | 状态枚举: PENDING/ACTIVE/CLOSED |

### 关系

| 源表 | 目标表 | 类型 | 外键 | 确认方式 |
|------|-------|------|------|---------|
| order | order_item | 1:N | order_item.order_id | DB FK |
| order | user | N:1 | order.user_id | 代码推断 |
```

---

## api-surface.md

```
## 接口清单

| 方法 | 路径/Topic | 请求关键字段 | 响应关键字段 | 鉴权 | 幂等 |
|------|-----------|------------|------------|------|------|
| POST | /api/order | userId, items[] | orderId, status | JWT | 否 |
| GET | /api/order/:id | - | order{} | JWT | 是 |

## 错误码

| 接口 | 错误码 | 含义 |
|------|-------|------|
| POST /api/order | 400 | 参数校验失败 |
| POST /api/order | 409 | 重复创建 |
```

---

## constraints.md

> Severity: `hard`（planner 必须遵守，违反直接 fail）/ `soft`（可权衡后覆写，需在 risk-report 说明理由）

```
## Source Coverage

| Source | Covered refs | Omissions | Reason |
|---|---|---|---|
| as-is/overview.md + clarifications.json + confirmations/as-is.json | C-001 | 无 | — |

## 禁区（不能修改）

| ID | 范围 | Severity | 原因 | 证据 |
|----|------|----------|------|------|
| FZ-001 | <path/module> | hard | <原因> | <file:line> |

## 包袱（看起来奇怪但有原因）

| ID | 现象 | Severity | 原因 | 证据 |
|----|------|----------|------|------|
| WBI-001 | <现象> | soft | <原因> | <file:line> |

## 坏味道（暂不重构）

| ID | 位置 | Severity | 坏味道 | 不处理原因 |
|----|------|----------|-------|-----------|
| DNR-001 | <path> | soft | <描述> | <原因> |

## 兼容约束

- <兼容行为描述>
```

---

## change-surface.md

```
## Source Coverage

| Source | Covered refs | Omissions | Reason |
|---|---|---|---|
| as-is/core-walkthrough.md + as-is/coverage-matrix.json | F-001, E-001, L-001, D-001, S-001 | 无 | — |

## Safe-to-Change Areas

| 区域 | 文件范围 | 修改类型 | 注意事项 |
|------|---------|---------|---------|
| 订单创建逻辑 | src/service/order.ts:50-120 | 增加/修改 | 需保持幂等性 |

## 影响面

| 修改区域 | 直接影响 | 间接影响 |
|---------|---------|---------|
| Service.createOrder | OrderController, OrderTest | 下游消息消费者 |
```

---

## field-flow.md

> 仅当 coverage-matrix.json 中有 `field_traces` 时生成。无字段变更需求时不生成此文件。

```
## Source Coverage

| Source | Covered refs | Omissions | Reason |
|---|---|---|---|
| as-is/coverage-matrix.json (field_traces) | FT-001 | 无 | — |

## 字段流转表

| 字段名 | DB Column | Entity/Model | Service Return | DTO/VO | API Response | Frontend Type | State/Store | UI Render | 备注 |
|-------|-----------|-------------|---------------|--------|-------------|--------------|------------|-----------|------|
| discount_amount | orders.discount_amount | Order.discountAmount | OrderService.get() | OrderVO.discountAmount | GET /orders/:id $.discountAmount | OrderResponse.discountAmount | orderStore.discount | OrderDetail.tsx:42 | 全链路存在 |
| new_field | orders.new_field | Order.newField | OrderService.get() | — | — | — | — | — | 仅到 Entity 层，DTO 未透传 |

## 断裂点

| 字段 | 缺失层级 | 影响 | 建议 |
|------|---------|------|------|
| new_field | dto, api_response, frontend_type, frontend_state, ui_render | 前端不会展示此字段 | 补充 DTO 映射 + API 返回 + 前端类型 + 页面渲染 |
```
