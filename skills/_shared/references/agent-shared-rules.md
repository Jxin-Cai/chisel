# Agent 共享规则

所有 agent 在开始工作前必须 Read 本文件。

## 1. Wiki 渐进加载

按需查询，不一次性加载整个 wiki：

```bash
node ${CLAUDE_PLUGIN_ROOT}/scripts/wiki-manage.mjs --query . --text "<task goal/scope>" --category <category|空> --min-score 2 --load-plan --limit 10
```

无命中时在产物中写 `None matched`。

## 2. 候选创建协议

发现禁区/包袱/坏味道/术语时写 `{idea_dir}/knowledge-candidates/{prefix}-*.json`（fz/wbi/dnr/term）。

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
