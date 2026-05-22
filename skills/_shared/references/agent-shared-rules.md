# Agent 共享规则

所有 agent 在开始工作前必须 Read 本文件。

## 1. Wiki 渐进加载

按需查询，不一次性加载整个 wiki：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/wiki-manage.mjs --query . --text "<task goal/scope>" --category <category|空> --min-score 2 --load-plan --limit 10
```

无命中时在产物中写 `None matched`。

## 2. 候选创建协议

在用户对话中识别到代码无法推导的上下文时（禁区/包袱/术语映射/历史决策），写 `{idea_dir}/knowledge-candidates/{prefix}-*.json`（fz/wbi/dnr/term）。

仅在以下场景创建候选：
- 用户澄清了某个设计的历史原因（代码看不出为什么这样做）
- 用户解释了业务术语与代码概念的映射关系
- 用户声明某区域不能动且给出了代码之外的原因
- 需求文档中明确了某个约束或决策

不要从代码静态分析信号创建候选——坏味道、指标异常等属于 as-is 分析产物，不是知识。

必须满足：`status=proposed`、`confirmed=false`、填写 `source_step`、`quality_score`（optional，取值 0–1）、非空 `keywords`、结构化 `evidence`（含 `file`/`line_start`）、按 category 填齐 `content` 必填键。格式见 `knowledge-candidates-template.md`。

## 3. Scope / Wiki Proof 格式

**Scope Check Proof** 必须记录：

- Command（exact）、Result、schema_version、changed_files_count、violations_count、forbidden_symbol_hits_count
- Scope Check JSON Summary（完整 JSON）
- Hit Proofs 表（File / Expected proof / Forbidden proof / Symbol proof / Status）
- Invariant Proofs 表（Invariant / Proof / Result）

Invariant Proofs 必须逐项覆盖 task `Behavior Invariants`；`Proof` 必须填写实际验证证据，不得为空或占位；`Result` 只能是 `pass` 或 `fail`；approved CR 必须全部为 `pass`。

**Wiki Proof** 必须记录：

- Query command、Query summary、category/min-score、load_plan JSON
- Wiki Entries Loaded 表（Entry / File / Why Loaded / Used For）

## 4. 模板优先

写产物前先 Read 对应模板文件，按模板结构填充。不凭记忆写格式。
