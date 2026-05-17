# Knowledge Candidate 提取指南

当 `resume_step` = `knowledge:extract` 时加载本文件。

## 流程

1. 扫描以下来源中与禁区、包袱、坏味道、术语相关的发现：
   - `{IDEA_DIR}/as-is/knowledge-candidates.md`
   - `{IDEA_DIR}/task-reports/`
   - `{IDEA_DIR}/cr/`
   - `{IDEA_DIR}/knowledge-candidates/` 下的独立候选文件（`fz-*.md`、`wbi-*.md`、`dnr-*.md`、`term-*.md`）
2. 去重：不同来源的候选按 name/scope 去重
3. 按需 Read 相关模板（不要一次全加载）：
   - `${CLAUDE_PLUGIN_ROOT}/skills/chisel-help/references/knowledge-candidates-template.md`
   - `${CLAUDE_PLUGIN_ROOT}/skills/chisel-help/references/forbidden-zones-template.md`
   - `${CLAUDE_PLUGIN_ROOT}/skills/chisel-help/references/weird-but-intentional-template.md`
   - `${CLAUDE_PLUGIN_ROOT}/skills/chisel-help/references/do-not-refactor-yet-template.md`
   - `${CLAUDE_PLUGIN_ROOT}/skills/chisel-help/references/glossary-template.md`
4. 在 `{IDEA_DIR}/knowledge-candidates/` 下补充或更新候选文件
5. 呈现合并后的候选摘要给用户，逐条确认
6. 用户确认的候选，创建 JSON 文件（含 `category` 和 `content`），调用：
   ```
   node ${CLAUDE_PLUGIN_ROOT}/scripts/wiki-manage.mjs --merge . <candidate.json>
   ```
7. 合入完成后调用 `node ${CLAUDE_PLUGIN_ROOT}/scripts/wiki-rule-inject.mjs .` 确保 rule 激活
8. 如果 `.chisel/wiki/` 不存在且候选内容足够，先调用 `node ${CLAUDE_PLUGIN_ROOT}/scripts/wiki-manage.mjs --init .` 初始化
9. 完成后 `touch {IDEA_DIR}/.knowledge-extracted`
