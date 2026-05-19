# Knowledge Candidate 提取指南

当 `resume_step` = `knowledge:extract` 时加载本文件。

## 目标

整理本轮发现的长期知识候选，经用户逐条决策后合入 wiki 或标记终态。阶段完成 = 所有候选进入终态且通过 `knowledge-extracted` gate。

## 流程

1. 扫描候选来源：`{IDEA_DIR}/as-is/knowledge-candidates.md`、`task-reports/`、`cr/`、`knowledge-candidates/*.json`
2. 去重：同 `category + content` 的 scope/name 合并
3. 按需 Read 相关模板（knowledge-candidates-template / wiki category 模板）
4. 在 `{IDEA_DIR}/knowledge-candidates/` 下补充或更新候选 JSON（必须满足 agent-shared-rules §2 要求）
5. 运行 gate：`node ${CLAUDE_PLUGIN_ROOT}/scripts/gate-check.mjs {IDEA_DIR} knowledge-candidates-exists`
6. 运行 health-check 检查候选完整性：`node ${CLAUDE_PLUGIN_ROOT}/scripts/gate-check.mjs {IDEA_DIR} health-check`
7. 呈现候选摘要给用户（包含 `relevance` 字段供用户在 confirm 时指定：`"high"` | `"medium"` | `"low"`），逐条选择 confirmed / rejected / deferred，用脚本写回：
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/wiki-manage.mjs --candidate-status {IDEA_DIR} <candidate-file> <confirmed|rejected|deferred> --reason "<原因>"
   ```
   confirmed 时同时指定 relevance：在候选 JSON 中写入 `"relevance": "high|medium|low"`。
8. 如 `.chisel/wiki/{project-name}/` 不存在且有 confirmed 候选：`--init .`
9. 对 confirmed 候选检测冲突后合入：
   ```bash
   node ${CLAUDE_PLUGIN_ROOT}/scripts/wiki-manage.mjs --detect-conflicts . <candidate-file>
   node ${CLAUDE_PLUGIN_ROOT}/scripts/wiki-manage.mjs --merge . <candidate-file>
   ```
   冲突时需用户确认 `decision.override_conflict_reason`。
10. 合入完成后：`node ${CLAUDE_PLUGIN_ROOT}/scripts/wiki-rule-inject.mjs .`
11. 所有候选终态后：`touch {IDEA_DIR}/.knowledge-extracted`
12. 运行 gate：`node ${CLAUDE_PLUGIN_ROOT}/scripts/gate-check.mjs {IDEA_DIR} knowledge-extracted`

## 完成条件

- 每个候选处于终态：`merged`、`rejected` 或 `deferred`
- `merged` 有 `merge.wiki_file` + `merge.entry_id`；`rejected/deferred` 有 `decision.reason`
- 不能留下 `proposed` 或 `confirmed` 候选
