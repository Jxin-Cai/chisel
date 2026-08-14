#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { durableAtomicWrite } from './file-transaction.mjs';
import { completeDocumentJob, prepareDocumentJob } from './document-job.mjs';

function readJson(ideaDir, rel, fallback = {}) {
  const file = join(ideaDir, rel);
  if (!existsSync(file)) return fallback;
  try { return JSON.parse(readFileSync(file, 'utf8')); } catch { return fallback; }
}

function readText(ideaDir, rel) {
  const file = join(ideaDir, rel);
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : '';
}

function text(value, fallback = '未记录') {
  const normalized = String(value ?? '').trim();
  return normalized || fallback;
}

function list(values, fallback = '无') {
  const items = Array.isArray(values) ? values : [];
  return items.length ? items.map(item => `- ${text(typeof item === 'string' ? item : item.summary || item.description || item.name || item.id || JSON.stringify(item))}`).join('\n') : `- ${fallback}`;
}

function structured(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  return typeof value === 'string' ? value : `\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function markdownCell(value, fallback = '—') {
  return text(value, fallback).replaceAll('|', '\\|').replace(/[\r\n]+/g, '<br>');
}

function scopeRows(values, kind) {
  const items = Array.isArray(values) ? values : [];
  if (!items.length) return kind === 'allowed' ? '| — | 无 | — |' : '| — | 无 | — |';
  return items.map(item => {
    if (typeof item === 'string') return `| ${markdownCell(item)} | — | — |`;
    if (kind === 'allowed') {
      return `| ${markdownCell(item.scope)} | ${markdownCell(item.reason)} | ${markdownCell((item.cp_refs || []).join(', '))} |`;
    }
    return `| ${markdownCell(item.scope)} | ${markdownCell(item.reason)} | ${markdownCell(item.trigger_condition)} |`;
  }).join('\n');
}

function mermaidText(value, fallback = '') {
  return text(value, fallback).replace(/[\r\n]+/g, ' ').replace(/["<>]/g, '').trim();
}

function flowGraphDiagram(flowGraph = {}) {
  const nodes = Array.isArray(flowGraph.nodes) ? flowGraph.nodes : [];
  const edges = Array.isArray(flowGraph.edges) ? flowGraph.edges : [];
  if (!nodes.length) return 'flowchart LR\n  EMPTY["暂无改造链路节点"]';
  const aliases = new Map(nodes.map((node, index) => [node.id, `N${index + 1}`]));
  const lines = ['flowchart LR'];
  for (const node of nodes) {
    const decision = node.decision || '保留';
    const cpRef = node.cp_ref || node.change_point_ref || '';
    const label = [node.label || node.name || node.id, decision, cpRef].filter(Boolean).map(value => mermaidText(value)).join('<br/>');
    lines.push(`  ${aliases.get(node.id)}["${label}"]`);
  }
  for (const edge of edges) {
    if (!aliases.has(edge.from) || !aliases.has(edge.to)) continue;
    const label = mermaidText(edge.label || edge.kind || edge.type);
    lines.push(`  ${aliases.get(edge.from)} -->${label ? `|"${label}"|` : ''} ${aliases.get(edge.to)}`);
  }
  return lines.join('\n');
}

function contextToLoad(context = {}) {
  const labels = { as_is: 'as-is', wiki: 'wiki', module_map: 'module map', adr: 'ADR' };
  return Object.entries(labels).map(([key, label]) => `- ${label}：${(Array.isArray(context[key]) ? context[key] : []).map(String).join(', ') || '无'}`).join('\n');
}

function changePointSections(changePoints) {
  const items = Array.isArray(changePoints) ? changePoints : [];
  return items.map(cp => `### ${text(cp.cp_id)}: ${text(cp.node)}

- 决策：${text(cp.decision)}
- 做什么：${text(cp.what)}
- 为什么：${text(cp.why)}
- 当前行为：${text(cp.current_behavior)}
- 目标行为：${text(cp.target_behavior)}
- 修改方式：${text(cp.modification_approach)}
- 上游影响：${text(cp.upstream_impact)}
- 下游影响：${text(cp.downstream_impact)}
- 行为不变量：${(cp.invariants || []).map(String).join('；') || '无'}
- 对应 Task：${(cp.corresponding_tasks || []).map(String).join(', ') || '无'}
- 设计理由：${text(cp.design_rationale)}
`).join('\n') || '无改造点详情。';
}

function evidenceRows(ledger) {
  const facts = Array.isArray(ledger?.facts) ? ledger.facts : Array.isArray(ledger) ? ledger : [];
  const rows = facts.flatMap(fact => {
    const evidence = Array.isArray(fact.evidence) && fact.evidence.length ? fact.evidence : [{}];
    return evidence.map(entry => `| ${text(fact.id)} | ${text(fact.claim)} | ${text(entry.file)}:${text(entry.line_start, '?')} | ${text(fact.status)} |`);
  });
  return rows.length ? rows.join('\n') : '| N/A | 无既有实现证据 | N/A | confirmed |';
}

function linkSequence(coverage) {
  const links = Array.isArray(coverage?.links) ? coverage.links : [];
  if (!links.length) return 'flowchart LR\n  A["无既有调用链或不适用"]';
  const ids = new Map();
  const idFor = value => {
    const key = text(value, 'unknown');
    if (!ids.has(key)) ids.set(key, `N${ids.size + 1}`);
    return ids.get(key);
  };
  const lines = ['flowchart LR'];
  for (const link of links) {
    const from = link.from || link.source || link.caller;
    const to = link.to || link.target || link.callee;
    const fromId = idFor(from);
    const toId = idFor(to);
    lines.push(`  ${fromId}["${text(from).replaceAll('"', '')}"] -->|"${text(link.kind || link.description, 'call').replaceAll('"', '')}"| ${toId}["${text(to).replaceAll('"', '')}"]`);
  }
  return lines.join('\n');
}

function renderAsIs(ideaDir) {
  const requirement = readText(ideaDir, 'requirement.md');
  const ledger = readJson(ideaDir, 'as-is/evidence-ledger.json');
  const coverage = readJson(ideaDir, 'as-is/coverage-matrix.json');
  const budget = readJson(ideaDir, 'as-is/context-budget.json');
  const changeSurface = readText(ideaDir, 'as-is/ai-input/change-surface.md');
  const facts = readText(ideaDir, 'as-is/ai-input/facts.md');
  const sequence = linkSequence(coverage);
  const entrypoints = Array.isArray(coverage.entrypoints) ? coverage.entrypoints : [];

  const overview = `# As-Is 概览

### 需求摘要

${text(requirement)}

### 3分钟摘要

${text(facts, '结构化事实已记录在 evidence-ledger.json。')}

### 读者导航

- 核心链路：core-walkthrough.md
- 逐条证据：evidence-index.md
- 上下文覆盖：context-budget.md

### 当前能力边界

${list(entrypoints.map(item => item.name || item.entrypoint || item.id), '未识别既有入口')}

### 待澄清问题

- 无需在 As-Is 阶段单独阻塞；未决业务问题并入方案确认。

### 用户确认清单

无需用户确认；As-Is 内容随 To-Be 方案一起审阅。

### 阅读充分性声明

本概览由 repo-map、evidence-ledger、coverage-matrix、context-budget 与 ai-input 确定性生成。

\`\`\`mermaid
${sequence}
\`\`\`
`;

  const walkthrough = `# 核心走查

## 既有逻辑链路

\`\`\`mermaid
${sequence}
\`\`\`

## 安全变更面

${text(changeSurface)}
`;

  const evidenceIndex = `# Evidence Index

| Fact | Claim | Evidence | Status |
|---|---|---|---|
${evidenceRows(ledger)}
`;

  const contextBudget = `# Context Budget

- 已读文件数：${Number(budget.read_file_count ?? budget.files_read?.length ?? 0)}
- 已读行数：${Number(budget.read_lines ?? budget.total_lines_read ?? 0)}
- 覆盖率：${text(budget.coverage ?? budget.coverage_ratio ?? budget.coverage_percent)}

## 未读相关文件

${list(budget.unread_relevant_files)}
`;

  durableAtomicWrite(join(ideaDir, 'as-is/overview.md'), overview);
  durableAtomicWrite(join(ideaDir, 'as-is/core-walkthrough.md'), walkthrough);
  durableAtomicWrite(join(ideaDir, 'as-is/evidence-index.md'), evidenceIndex);
  durableAtomicWrite(join(ideaDir, 'as-is/context-budget.md'), contextBudget);
}

function renderToBe(ideaDir) {
  const notes = readJson(ideaDir, 'to-be/design-notes.json');
  const tasksDoc = readJson(ideaDir, 'to-be/tasks.json');
  const impact = readJson(ideaDir, 'to-be/impact-risk-report.json');
  const tasks = Array.isArray(tasksDoc.tasks) ? tasksDoc.tasks : Array.isArray(tasksDoc) ? tasksDoc : [];
  const changePoints = Array.isArray(notes.change_points) ? notes.change_points : Array.isArray(impact.change_points) ? impact.change_points : [];
  const taskSections = tasks.map(task => `### ${text(task.task_id || task.id, 'task')}

${text(task.goal || task.description || task.summary)}

- Acceptance Criteria：${(task.acceptance_criteria || task.trace_refs || []).map(String).join(', ') || '见 traceability-matrix.json'}
- Expected Files：${(task.expected_files || []).join(', ') || '见 file_plan'}
`).join('\n');
  const cpRows = changePoints.map(cp => `| ${text(cp.id)} | ${text(cp.summary || cp.description || cp.node)} | ${text(cp.decision || cp.action)} |`).join('\n') || '| N/A | 见 impact-risk-report.json | 保持 |';
  const selfCheck = notes.self_check || {};
  const flowGraph = flowGraphDiagram(impact.flow_graph);

  const plan = `# To-Be 实施方案

## TL;DR

${text(notes.tl_dr)}

> Schema v${text(notes.schema_version)} · Generated at ${text(notes.generated_at)}

## 目标行为

${text(notes.goal_behavior, '满足 requirement 与全部 Acceptance Criteria。')}

## 非目标行为

${text(notes.non_goal_behavior, '无')}

## 方案总览

${text(notes.strategy_overview)}

## 改造链路图

\`\`\`mermaid
${flowGraph}
\`\`\`

## 允许修改范围

| 范围 | 原因 | 对应 CP |
|---|---|---|
${scopeRows(notes.allowed_scope, 'allowed')}

## 禁止修改范围

| 范围 | 原因 | 触碰条件 |
|---|---|---|
${scopeRows(notes.forbidden_scope, 'forbidden')}

## 需要保留的历史行为

${list(notes.historical_behaviors)}

## Context to Load

${contextToLoad(notes.context_to_load)}

## 改造点映射

| CP | 改造点 | 决策 |
|---|---|---|
${cpRows}

## 方案详情

${changePointSections(notes.change_point_details)}

## Verification Surface

${list(notes.verification_surface)}

## 回滚方案

${text(notes.rollback_plan)}

## Task 拆分建议

${taskSections || '任务定义见 to-be/tasks.json。'}

## 变更完整性自检结果

### 伴生变更推断

${structured(selfCheck.companion_changes || selfCheck.companion_change_inference, '已由结构化计划 gate 校验。')}

### Spec、CP、Task 与文件映射

${structured(selfCheck.traceability || selfCheck.coverage || {
  spec_coverage: selfCheck.spec_coverage,
  cp_task_consistency: selfCheck.cp_task_consistency,
  file_plan_completeness: selfCheck.file_plan_completeness,
  dependency_completeness: selfCheck.dependency_completeness,
  reverse_detection: selfCheck.reverse_detection,
}, '以 traceability-matrix.json 与 tasks.json 为准。')}

### 验证计划

${structured(selfCheck.verification || selfCheck.test_plan, '每个 task 的 Verification Plan 必须通过结构化 gate。')}

> 本文由结构化 To-Be 产物确定性渲染；JSON 是权威来源。
`;
  durableAtomicWrite(join(ideaDir, 'to-be/implementation-plan.md'), plan);
}

export function renderHumanDocuments(ideaDir, mode) {
  if (!['as-is', 'to-be'].includes(mode)) throw new Error(`unknown document mode: ${mode}`);
  mkdirSync(join(ideaDir, mode), { recursive: true });
  prepareDocumentJob(ideaDir, mode);
  if (mode === 'as-is') renderAsIs(ideaDir);
  else renderToBe(ideaDir);
  const receipt = completeDocumentJob(ideaDir, mode);
  return { status: 'complete', mode, receipt: join(ideaDir, 'document-jobs', `${mode}.json`), outputs: receipt.outputs };
}

function main() {
  const ideaDir = process.argv[2];
  const mode = process.argv[3];
  if (!ideaDir || !mode) {
    process.stderr.write('Usage: document-render.mjs <idea-dir> <as-is|to-be>\n');
    process.exit(1);
  }
  try { console.log(JSON.stringify(renderHumanDocuments(ideaDir, mode))); }
  catch (error) { process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exit(1); }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
