# AI 输入版模板

as-is 确认后，从人类学习版提取面向 AI agent 的结构化输入。这些文件供 Planner agent 使用，要求紧凑、字段化、无叙事。

---

## facts.md

从 overview.md 的核心事实 + core-walkthrough.md 提取的已确认事实清单。

```
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

从 core-walkthrough.md 的时序图提取的结构化调用关系。

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
```

---

## data-schema.md

从 details/data-model.md（或 core-walkthrough.md 中内联的数据部分）提取的表/字段/关系结构化数据。

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

从 details/api-contracts.md（或 core-walkthrough.md 中内联的接口部分）提取的接口签名清单。

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

从 overview.md 的禁区/包袱/坏味道 + clarifications.md 提取的约束信息。

```
## 禁区（不能修改）

| ID | 范围 | 原因 | 证据 |
|----|------|------|------|
| FZ-001 | <path/module> | <原因> | <file:line> |

## 包袱（看起来奇怪但有原因）

| ID | 现象 | 原因 | 证据 |
|----|------|------|------|
| WBI-001 | <现象> | <原因> | <file:line> |

## 坏味道（暂不重构）

| ID | 位置 | 坏味道 | 不处理原因 |
|----|------|-------|-----------|
| DNR-001 | <path> | <描述> | <原因> |

## 兼容约束

- <兼容行为描述>
```

---

## change-surface.md

从 core-walkthrough.md 的 safe-to-change area 提取的可修改区域。

```
## Safe-to-Change Areas

| 区域 | 文件范围 | 修改类型 | 注意事项 |
|------|---------|---------|---------|
| 订单创建逻辑 | src/service/order.ts:50-120 | 增加/修改 | 需保持幂等性 |

## 影响面

| 修改区域 | 直接影响 | 间接影响 |
|---------|---------|---------|
| Service.createOrder | OrderController, OrderTest | 下游消息消费者 |
```
