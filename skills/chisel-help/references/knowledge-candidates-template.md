# Knowledge Candidates 模板

本模板用于 `.chisel/<idea-name>/knowledge-candidates/`。候选知识必须先以 JSON 文件记录，经过用户逐条确认后，才能合入 `.chisel/wiki/{project-name}/`。

`as-is/knowledge-candidates.md` 可以保留人类可读摘要，但不作为 gate 的状态来源。

## 核心原则

知识候选只收录**代码之外、帮助 AI 理解项目背景的人类上下文**。判断标准：如果这条信息能通过读代码或 git 历史推导出来，就不应该进入知识库。

合格来源：
- 用户对话中的澄清（如：某块设计虽有问题但保留的历史原因）
- 业务术语 → 代码概念的映射（如：用户说"权益"，代码里对应哪些类/字段）
- 需求文档中明确的约束或决策
- 用户描述的组织/流程/业务规则等代码无法体现的信息

不合格来源：
- 代码坏味道、静态分析信号（这些是 as-is 分析产物，不是知识）
- 文件指标异常、代码结构问题
- 任何能通过 grep/git log 得到的事实

## 文件命名

```text
knowledge-candidates/
  fz-001.json
  wbi-001.json
  dnr-001.json
  term-entitlement.json
```

## 生命周期状态

| status | confirmed | 含义 |
|---|---:|---|
| `proposed` | `false` | 已发现，等待用户决策 |
| `confirmed` | `true` | 用户确认收录，等待合入 wiki |
| `merged` | `true` | 已合入 wiki |
| `rejected` | `false` | 用户明确不收录 |
| `deferred` | `false` | 证据不足或后续再确认 |

终态只有：`merged`、`rejected`、`deferred`。转换路径：`proposed → confirmed/rejected/deferred`，`confirmed → merged/rejected/deferred`。

## 基础 JSON 模板

```json
{
  "id": "fz-001",
  "category": "forbidden_zone",
  "status": "proposed",
  "confirmed": false,
  "source_step": "understand:confirm",
  "created_at": "2026-05-17T00:00:00.000Z",
  "quality_score": 0.8,
  "relevance": "high",
  "keywords": ["旧接口响应", "legacy response"],
  "evidence": [
    { "file": "clarifications.md", "line_start": 12, "line_end": 12, "note": "用户确认旧接口响应字段不能改" },
    { "file": "src/user.ts", "line_start": 28, "line_end": 28, "note": "旧响应字段被客户端依赖" }
  ],
  "content": {
    "范围": "src/user.ts 的旧接口响应结构",
    "原因": "旧客户端依赖当前响应字段",
    "建议": "只增加校验，不修改响应字段名称、层级和语义"
  },
  "decision": null,
  "merge": null
}
```

必填字段：`id`, `category`, `status`, `confirmed`, `source_step`, `keywords`(非空), `evidence`(结构化), `content`(按 category 填齐必填键)。

可选字段：`quality_score`(>=0.5)、`relevance`(`"high"` | `"medium"` | `"low"`，用户在 confirm 时指定)。

## 分类 content 必填键

| category | 必填 content 键 | 可选键 | 来源要求 |
|----------|----------------|--------|---------|
| forbidden_zone | 范围, 原因 | 建议 | 用户明确告知不能动的区域 |
| weird_but_intentional | 现象, 原因 | 建议 | 用户澄清的历史设计决策 |
| smell | 坏味道, 位置, 本次不处理原因 | — | 用户确认知晓且明确说明不处理原因（非代码扫描发现） |
| glossary | 术语, 定义 | 出现位置 | 用户澄清的业务术语 → 代码概念映射 |

## 用户决策与合入

使用脚本写回状态，不要手改 JSON：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/wiki-manage.mjs --candidate-status {IDEA_DIR} <candidate-file> <confirmed|rejected|deferred> --reason "<原因>"
```

只有 `status=confirmed` 的候选可以合入 wiki：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/wiki-manage.mjs --merge . <candidate-file>
```
