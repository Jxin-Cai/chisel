#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, basename } from 'node:path';
import {
  readTaskState, taskStateFile, detectComplexity
} from './workflow-lib.mjs';
import { STEP_GATE_MAP, WORKFLOW_PATHS } from './workflow-definition.mjs';
import { checkGate } from './gate-check.mjs';
import {
  collectCrResults, collectTraceability, computeReportSummary,
  countCrFindings, countTasksByStatus, normalizeApiChangePlan,
  normalizeCoverageMatrixRefs, normalizeDataChangePlan, normalizeStepTimings,
  normalizeTasksJson, normalizeTraceabilityTree, oneSentence,
  formatDuration, formatEvidence, mdToHtml, parseTableSection
} from './report-model.mjs';
import { summary as collectSessionMetrics } from './session-metrics.mjs';

// --- Report data loading ---

function readJson(ideaDir, rel) {
  const p = join(ideaDir, rel);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function fileSha256(path) {
  if (!existsSync(path)) return '';
  try { return createHash('sha256').update(readFileSync(path)).digest('hex'); } catch { return ''; }
}

function readMd(ideaDir, rel) {
  const p = join(ideaDir, rel);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}

function readWorkflowState(ideaDir) {
  const p = join(ideaDir, 'workflow-state.yaml');
  if (!existsSync(p)) return null;
  const text = readFileSync(p, 'utf8');
  const result = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^([a-z_]+):\s*(.+)$/);
    if (m) result[m[1]] = m[2].trim();
  }
  result.phases = {};
  const phaseLines = text.split('\n').filter(l => /^  [a-z]+:/.test(l));
  for (const l of phaseLines) {
    const m = l.match(/^\s+([a-z]+):\s*(.+)$/);
    if (m) result.phases[m[1]] = m[2].trim();
  }
  const history = [];
  const historyStart = text.indexOf('step_history:');
  if (historyStart !== -1) {
    const histLines = text.slice(historyStart).split('\n').slice(1);
    let entry = {};
    for (const hl of histLines) {
      if (/^\s+-\s*$/.test(hl) || /^\s+- step:/.test(hl)) {
        if (entry.step) history.push(entry);
        entry = {};
        const sm = hl.match(/step:\s*(.+)/);
        if (sm) entry.step = sm[1].trim();
      } else if (/^\s+step:/.test(hl)) {
        const sm = hl.match(/step:\s*(.+)/);
        if (sm) entry.step = sm[1].trim();
      } else if (/^\s+entered_at:/.test(hl)) {
        const sm = hl.match(/entered_at:\s*(.+)/);
        if (sm) entry.entered_at = sm[1].trim();
      } else if (/^\s+exited_at:/.test(hl)) {
        const sm = hl.match(/exited_at:\s*(.+)/);
        if (sm) entry.exited_at = sm[1].trim();
      } else if (/^\s+duration_ms:/.test(hl)) {
        const sm = hl.match(/duration_ms:\s*(.+)/);
        if (sm) entry.duration_ms = Number(sm[1].trim()) || 0;
      } else if (/^[a-z]/.test(hl)) break;
    }
    if (entry.step) history.push(entry);
  }
  result.step_history = history;
  return result;
}

function collectStepOutputs(ideaDir, steps, currentStep, stepHistory) {
  const STEP_OUTPUTS_MAP = {
    'receive-requirement': [{ label: '需求文档', file: 'requirement.md' }],
    'understand:explore': [
      { label: '概览', file: 'as-is/overview.md' },
      { label: '核心走查', file: 'as-is/core-walkthrough.md' },
    ],
    'clarify:requirement': [{ label: '需求澄清', file: 'requirement-clarification.json' }],
    'classify:requirement': [{ label: '需求分级', file: 'requirement-classification.json' }],
    'plan:design': [
      { label: '实现方案', file: 'to-be/implementation-plan.md' },
      { label: 'Tasks', file: 'to-be/tasks.json' },
    ],
    'implement:code': [{ label: 'Task 报告', file: 'task-reports/', isDir: true }],
    'test:unit': [{ label: '单测结果', file: 'unit-test-result.json' }, { label: '单测报告', file: 'reports/test-report.html' }],
    'review:cr': [{ label: 'CR 结果', file: 'cr/', isDir: true }],
    'review:cr-report': [{ label: 'CR 汇总报告', file: 'reports/cr-report.html' }],
    'final:summary': [{ label: '最终摘要', file: 'final-summary.md' }],
    'review:merge': [
      { label: 'CR 报告（含合并审阅）', file: 'reports/cr-report.html' },
      { label: '合并审阅确认', file: 'confirmations/merge-review.json' },
    ],
  };
  const visited = new Set((stepHistory || []).map(h => h.step));
  return steps.map(stepId => {
    const gateId = STEP_GATE_MAP[stepId];
    const gatePassed = gateId ? checkGate(ideaDir, gateId).pass : false;
    const status = stepId === currentStep ? 'current' : visited.has(stepId) || gatePassed ? 'done' : 'pending';
    const outputs = (STEP_OUTPUTS_MAP[stepId] || []).map(o => ({ ...o, exists: existsSync(join(ideaDir, o.file)) }));
    return { step: stepId, status, outputs };
  });
}

// --- HTML utilities ---

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function wrapHtml(_title, body) { return body; }

function blockHero() { return ''; }

function pillClass(status) {
  if (['approved', 'pass', 'passed', 'success', 'complete', 'done', 'ready_for_human_review', 'ready', 'clean', 'low', 'none'].includes(status)) return 'pill-success';
  if (['coding', 'coded', 'reviewing', 'in_progress', 'comment', 'hold'].includes(status)) return 'pill-accent';
  if (['needs_rework', 'repairing', 'medium'].includes(status)) return 'pill-warn';
  if (['blocked', 'failed', 'fail', 'high', 'critical', 'action_required', 'request_changes'].includes(status)) return 'pill-danger';
  return 'pill-muted';
}

function metric(label, value, hint = '', tone = '') {
  const cls = tone === 'accent' ? 'v-accent' : tone === 'success' ? 'v-success' : tone === 'warn' ? 'v-warn' : tone === 'danger' ? 'v-danger' : '';
  return `<div class="metric animate-in"><div class="metric-value ${cls}">${esc(value)}</div><div class="metric-label">${esc(label)}</div>${hint ? `<div class="metric-hint">${esc(hint)}</div>` : ''}</div>`;
}

function domId(value) {
  const normalized = String(value || 'section').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'section';
}

function sectionNav(items) {
  return `<nav class="section-nav" aria-label="报告目录"><span class="section-nav-label">阅读路径</span>${items.map(item => `<a href="#${esc(item.id)}">${esc(item.label)}</a>`).join('')}</nav>`;
}

function detailPanel(id, title, body, open = false) {
  return `<details class="detail-panel" id="${esc(id)}"${open ? ' open' : ''}><summary><span>${esc(title)}</span><span class="detail-hint">展开详情</span></summary><div class="detail-body">${body}</div></details>`;
}

function mermaidText(value, fallback = '') {
  return String(value || fallback).replace(/[\r\n]+/g, ' ').replace(/["<>]/g, '').trim();
}

function mermaidId(value, prefix = 'N') {
  const normalized = String(value || '').replace(/[^a-zA-Z0-9_]/g, '_').replace(/^([^a-zA-Z_])/, '_$1');
  return `${prefix}_${normalized || 'item'}`;
}

function mermaidDiagram(source, label, { wide = false } = {}) {
  return `<div class="diagram-stage${wide ? ' diagram-stage-wide' : ''}" role="region" aria-label="${esc(label)}" tabindex="0"><pre class="mermaid">${esc(source)}</pre></div>`;
}

function renderSequenceSource(links) {
  const names = [...new Set(links.flatMap(link => [link.from || link.source || link.caller, link.to || link.target || link.callee]).filter(Boolean))];
  const aliases = new Map(names.map((name, index) => [name, `P${index + 1}`]));
  const lines = ['sequenceDiagram', ...names.map(name => `  participant ${aliases.get(name)} as ${mermaidText(name, '未知节点')}`)];
  for (const link of links) {
    const from = link.from || link.source || link.caller;
    const to = link.to || link.target || link.callee;
    if (!aliases.has(from) || !aliases.has(to)) continue;
    const asyncKind = /async|event|message|queue/i.test(String(link.kind || link.type || ''));
    const arrow = asyncKind ? '-)' : '->>';
    const description = [link.id, link.kind || link.type, link.description].filter(Boolean).join(' · ');
    lines.push(`  ${aliases.get(from)}${arrow}${aliases.get(to)}: ${mermaidText(description, '调用')}`);
  }
  return lines.join('\n');
}

function normalizeDomainModels(coverageMatrix) {
  const explicit = Array.isArray(coverageMatrix.domain_models) ? coverageMatrix.domain_models : [];
  if (explicit.length > 0) return explicit;
  return (Array.isArray(coverageMatrix.data) ? coverageMatrix.data : []).map(item => ({
    id: item.id,
    name: item.model || item.entity || item.table || item.name || item.id,
    kind: item.kind || (item.table || item.entity ? 'entity' : 'domain model'),
    fields: item.fields || [],
    operations: item.operations || (item.operation ? [item.operation] : []),
  }));
}

function renderClassSource(coverageMatrix) {
  const models = normalizeDomainModels(coverageMatrix);
  const aliases = new Map(models.map((model, index) => [model.id || model.name, mermaidId(model.id || model.name || index, 'M')]));
  const lines = ['classDiagram'];
  for (const model of models) {
    const key = model.id || model.name;
    const id = aliases.get(key);
    lines.push(`  class ${id}["${mermaidText(model.name || model.entity || model.table || model.id, '领域模型')}"]`);
    if (model.kind) lines.push(`  <<${mermaidText(model.kind)}>> ${id}`);
    for (const field of (model.fields || [])) {
      const value = typeof field === 'string' ? field : `${field.type || 'any'} ${field.name || field.field || ''}`;
      lines.push(`  ${id} : +${mermaidText(value, 'field')}`);
    }
    for (const operation of (model.operations || [])) {
      const value = typeof operation === 'string' ? operation : operation.name || operation.operation;
      lines.push(`  ${id} : +${mermaidText(value, 'operation')}()`);
    }
  }
  const relationships = Array.isArray(coverageMatrix.domain_relationships)
    ? coverageMatrix.domain_relationships
    : (Array.isArray(coverageMatrix.relationships) ? coverageMatrix.relationships : []);
  const relationArrows = { inheritance: '<|--', composition: '*--', aggregation: 'o--', dependency: '..>', realization: '..|>', association: '-->' };
  for (const relation of relationships) {
    const from = aliases.get(relation.from || relation.source || relation.owner);
    const to = aliases.get(relation.to || relation.target || relation.member);
    if (!from || !to) continue;
    const arrow = relationArrows[String(relation.kind || relation.type || '').toLowerCase()] || '-->';
    const left = mermaidText(relation.from_cardinality || relation.source_cardinality);
    const right = mermaidText(relation.to_cardinality || relation.target_cardinality);
    const cardinality = `${left ? ` "${left}"` : ''} ${arrow}${right ? ` "${right}"` : ''}`;
    lines.push(`  ${from}${cardinality} ${to}${relation.label || relation.name || relation.kind ? ` : ${mermaidText(relation.label || relation.name || relation.kind)}` : ''}`);
  }
  return lines.join('\n');
}

function renderAsIsUml(coverageMatrix = {}) {
  const links = Array.isArray(coverageMatrix.links) ? coverageMatrix.links : [];
  const models = normalizeDomainModels(coverageMatrix);
  const sequence = links.length > 0
    ? mermaidDiagram(renderSequenceSource(links), '需求范围内全部既有代码逻辑时序', { wide: true })
    : '<p class="diagram-empty">未识别到既有代码调用链；请检查 coverage-matrix.links。</p>';
  const modelDiagram = models.length > 0
    ? mermaidDiagram(renderClassSource(coverageMatrix), '领域模型 UML 类图', { wide: true })
    : '<p class="diagram-empty">当前需求不涉及领域模型，或 coverage-matrix.domain_models 尚未补充。</p>';
  return `<section class="card diagram-card diagram-card-full" id="as-is-sequence"><div class="card-heading"><div><p class="eyebrow">UML Sequence</p><h2>待改已有代码逻辑全链路</h2><p class="muted compact">完整罗列需求范围内从入口到副作用终点的既有调用，不截断节点或分支。</p></div><span class="diagram-legend">${links.length} 次交互</span></div>${sequence}</section><section class="card diagram-card diagram-card-full" id="as-is-models"><div class="card-heading"><div><p class="eyebrow">UML Class Diagram</p><h2>领域模型定义与关系</h2><p class="muted compact">展示领域模型的属性、行为、关系类型与多重性；它不是数据库表调用顺序图。</p></div><span class="diagram-legend">${models.length} 个模型</span></div>${modelDiagram}</section>`;
}

function renderChangeFlow(impactRisk = {}, changePoints = []) {
  const graph = impactRisk?.flow_graph || {};
  const nodes = Array.isArray(graph.nodes) && graph.nodes.length ? graph.nodes : changePoints.map(cp => ({ id: cp.id, label: cp.node || cp.summary || cp.id, decision: cp.decision, cp_ref: cp.id }));
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const unchanged = value => ['保留', 'keep', 'unchanged'].includes(String(value || '').toLowerCase());
  const changed = nodes.filter(node => !unchanged(node.decision)).length;
  const aliases = new Map(nodes.map((node, index) => [node.id, mermaidId(node.id || index, 'F')]));
  const source = ['flowchart LR'];
  for (const node of nodes) {
    const decision = node.decision || '改造';
    const tone = decision === '新增' ? 'add' : decision === '删除' ? 'remove' : unchanged(decision) ? 'keep' : 'modify';
    const cpRef = node.cp_ref || node.change_point_ref || (String(node.id || '').startsWith('CP-') ? node.id : '');
    const label = [node.label || node.name || node.id, decision, cpRef].filter(Boolean).map(value => mermaidText(value)).join('<br/>');
    source.push(`  ${aliases.get(node.id)}["${label}"]:::${tone}`);
  }
  for (const edge of edges) {
    if (!aliases.has(edge.from) || !aliases.has(edge.to)) continue;
    const label = mermaidText(edge.label || edge.kind || edge.type);
    source.push(`  ${aliases.get(edge.from)} -->${label ? `|${label}|` : ''} ${aliases.get(edge.to)}`);
  }
  if (edges.length === 0) {
    for (let index = 1; index < nodes.length; index++) source.push(`  ${aliases.get(nodes[index - 1].id)} --> ${aliases.get(nodes[index].id)}`);
  }
  source.push('  classDef keep fill:#f8fafc,stroke:#94a3b8,color:#475569,stroke-width:1px');
  source.push('  classDef modify fill:#fffbeb,stroke:#f59e0b,color:#92400e,stroke-width:3px');
  source.push('  classDef add fill:#f0fdf4,stroke:#16a34a,color:#166534,stroke-width:3px');
  source.push('  classDef remove fill:#fef2f2,stroke:#dc2626,color:#991b1b,stroke-width:3px,stroke-dasharray:5 3');
  const cpLinks = nodes.map(node => node.cp_ref || node.change_point_ref || (String(node.id || '').startsWith('CP-') ? node.id : '')).filter(Boolean);
  return `<section class="card diagram-card diagram-card-bleed" id="change-flow"><div class="card-heading"><div><p class="eyebrow">Change Journey</p><h2>改造点全链路</h2><p class="muted compact">一张图保留入口、分支与终点的完整拓扑；画布使用原始尺寸，可横向滚动查看，不会缩成缩略图。</p></div><span class="diagram-legend">${changed}/${nodes.length} 节点变化</span></div>${nodes.length ? mermaidDiagram(source.join('\n'), 'To-Be 改造点全链路大图', { wide: true }) : '<p class="diagram-empty">暂无 flow_graph 节点。</p>'}<div class="change-legend"><span class="keep">保留</span><span class="modify">改造</span><span class="add">新增</span><span class="remove">删除</span></div>${cpLinks.length ? `<nav class="diagram-links" aria-label="跳转到改造点详情">${[...new Set(cpLinks)].map(cp => `<a href="#cp-${domId(cp)}">${esc(cp)}</a>`).join('')}</nav>` : ''}</section>`;
}

function renderToBeUml(impactRisk = {}) {
  const graph = impactRisk?.flow_graph || {};
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  const byId = new Map(nodes.map(node => [node.id, node]));
  if (edges.length > 0) {
    const sequenceLinks = edges.map(edge => ({ ...edge, from: byId.get(edge.from)?.label || byId.get(edge.from)?.name || edge.from, to: byId.get(edge.to)?.label || byId.get(edge.to)?.name || edge.to, kind: edge.label || edge.kind || 'interaction' }));
    return `<section class="card diagram-card diagram-card-full" id="to-be-model"><div class="card-heading"><div><p class="eyebrow">UML Target Model · Sequence</p><h2>目标核心时序</h2><p class="muted compact">以真实 UML 时序展示目标系统的参与者与交互顺序。</p></div><span class="diagram-legend">${nodes.length} 个参与节点</span></div>${mermaidDiagram(renderSequenceSource(sequenceLinks), '目标核心时序', { wide: true })}</section>`;
  }
  return `<section class="card diagram-card" id="to-be-model"><div class="card-heading"><div><p class="eyebrow">UML Target Model</p><h2>目标系统模型</h2></div><span class="diagram-legend">${nodes.length} 个节点</span></div><p class="diagram-empty">flow_graph 暂无边，无法生成目标时序；请补充节点间交互。</p></section>`;
}

// --- Block renderers ---

function renderOverviewSection(data) {
  const { summary, workflowSteps, currentIdx, timingSummary, currentStep, impactRisk, stepOutputs, performanceMetrics } = data;
  const ts = summary.taskStats;
  const cr = summary.crStats;

  let body = blockHero('📊', '工作流总览', `${data.ideaName} · ${data.complexity} · 当前步骤：${currentStep}`);

  body += `<div class="metric-grid stagger-group">\n`;
  body += metric('执行进度', `${summary.workflowPercentage}%`, `${summary.workflowDone}/${summary.workflowTotal} 步`, 'accent');
  body += metric('Task 完成', `${ts.percentage}%`, `${ts.approved}/${ts.total} approved`, ts.percentage === 100 ? 'success' : 'accent');
  body += metric('需求覆盖', `${summary.requirementCoverage}%`, summary.missingRequirements ? `${summary.missingRequirements} 项缺失` : '全覆盖', summary.requirementCoverage === 100 ? 'success' : 'warn');
  body += metric('CR Rework', String(cr.rework), `${cr.highSeverity} high`, cr.rework ? 'danger' : 'success');
  body += metric('总耗时', timingSummary.total_label, timingSummary.longest_step ? `最长：${timingSummary.longest_step.step}` : '', 'accent');
  body += `</div>\n`;

  body += `<div class="card animate-in"><h2>工作流进度</h2><div class="wf-steps">`;
  body += workflowSteps.map((s, i) => {
    const cls = i < currentIdx ? 'done' : i === currentIdx ? 'current' : '';
    return `<span class="wf-step ${cls}">${esc(s)}</span>`;
  }).join('<span class="wf-arrow">→</span>');
  body += `</div></div>\n`;

  if (timingSummary.steps.length > 0) {
    const maxMs = Math.max(1, ...timingSummary.steps.map(s => s.duration_ms));
    body += `<div class="card animate-in"><h2>环节耗时</h2>`;
    for (const s of timingSummary.steps) {
      const pct = Math.max(2, Math.round((s.duration_ms / maxMs) * 100));
      body += `<div class="timing-row"><div class="timing-step">${esc(s.step)}</div><div class="timing-bar"><div class="timing-fill" style="width:${pct}%"></div></div><div class="timing-val">${esc(s.duration_label)}</div></div>`;
    }
    body += `</div>\n`;
  }

  if (performanceMetrics?.attribution) {
    const attr = performanceMetrics.attribution;
    const measured = attr.measured_spans_ms || {};
    body += `<div class="card animate-in"><div class="card-heading"><div><p class="eyebrow">Time Attribution</p><h2>耗时归因</h2></div><span class="diagram-legend">wall ${esc(formatDuration(attr.wall_clock_ms || 0))}</span></div><div class="metric-grid compact-metrics">`;
    body += metric('用户等待', formatDuration(attr.human_wait_ms || 0), 'confirm / clarify', 'warn');
    body += metric('自动流程', formatDuration(attr.active_workflow_ms || 0), '非等待步骤', 'accent');
    body += metric('验证', formatDuration(measured.verification || 0), 'test / build', measured.verification ? 'accent' : '');
    body += metric('控制面', formatDuration(measured.control_plane || 0), 'runner / transition');
    body += metric('报告生成', formatDuration(measured.report_generation || 0), 'HTML / hash');
    body += metric('Agent', String(performanceMetrics.total_agent_calls || performanceMetrics.counters?.agent_calls || 0), '调用次数');
    body += `</div></div>`;
  }

  if (impactRisk?.summary?.highest_risk) {
    body += `<div class="card animate-in card-accent-orange"><h2>风险关注</h2><p>${esc(impactRisk.summary.highest_risk)}</p></div>\n`;
  }

  return wrapHtml(`总览 — ${data.ideaName}`, body);
}

function renderAsIsSection(data) {
  const { overview, coreWalkthrough, evidenceLedger, qualityScore, coverageMatrix } = data;
  let body = blockHero('📖', 'As-Is 现状理解', data.ideaName);

  if (!overview && !coreWalkthrough && !evidenceLedger && !qualityScore) {
    body += `<div class="card animate-in"><p class="muted">暂无 As-Is 产物。</p></div>`;
    return wrapHtml(`As-Is — ${data.ideaName}`, body);
  }

  body += sectionNav([
    { id: 'as-is-sequence', label: '待改已有逻辑全链路' },
    { id: 'as-is-models', label: '领域模型 UML' },
    { id: 'as-is-walkthrough', label: '完整逻辑走查' },
    { id: 'as-is-overview', label: '一句话现状总结' },
    { id: 'as-is-evidence', label: '证据与质量（按需）' },
  ]);
  body += renderAsIsUml(coverageMatrix || {});
  if (coreWalkthrough) body += detailPanel('as-is-walkthrough', '所有待变更既有代码逻辑（完整走查）', `<div class="section-md">${mdToHtml(coreWalkthrough)}</div>`, true);
  if (overview) body += detailPanel('as-is-overview', '现状总结（一段话）', `<p>${esc(oneSentence(overview))}</p>`, true);
  body += `<section id="as-is-evidence" class="detail-stack">`;
  if (qualityScore) {
    const dims = qualityScore.dimensions || qualityScore.scores || {};
    let qualityBody = `<table><tr><th>维度</th><th>评分</th></tr>`;
    for (const [k, v] of Object.entries(dims)) {
      const score = typeof v === 'number' ? v : v?.score || 0;
      const pct = Math.round(score * 100);
      const tone = pct >= 80 ? 'success' : pct >= 60 ? 'accent' : 'warn';
      qualityBody += `<tr><td>${esc(k)}</td><td><span class="pill pill-${tone === 'success' ? 'success' : tone === 'warn' ? 'warn' : 'accent'}">${pct}%</span></td></tr>`;
    }
    body += detailPanel('as-is-quality', '质量评分', `${qualityBody}</table>`);
  }
  if (evidenceLedger) {
    const items = Array.isArray(evidenceLedger) ? evidenceLedger : (evidenceLedger.facts || evidenceLedger.items || []);
    if (items.length > 0) {
      let evidenceBody = `<table><tr><th>ID</th><th>声明</th><th>状态</th></tr>`;
      for (const e of items.slice(0, 20)) {
        evidenceBody += `<tr><td>${esc(e.id || '')}</td><td class="desc">${esc(oneSentence(e.claim || e.description || ''))}</td><td><span class="pill ${pillClass(e.status || 'pending')}">${esc(e.status || 'pending')}</span></td></tr>`;
      }
      body += detailPanel('as-is-evidence-index', `证据索引（${items.length}）`, `${evidenceBody}</table>`);
    }
  }
  body += `</section>`;

  return wrapHtml(`As-Is — ${data.ideaName}`, body);
}

function renderToBeSection(data) {
  const { implementationPlan, normalizedTasks, traceabilityTree, changePoints, dataChanges, apiChanges, taskDetails, impactRisk } = data;
  let body = blockHero('🎯', 'To-Be 方案', data.ideaName);

  if (!implementationPlan && normalizedTasks.length === 0) {
    body += `<div class="card animate-in"><p class="muted">暂无 To-Be 产物。</p></div>`;
    return wrapHtml(`To-Be — ${data.ideaName}`, body);
  }

  body += `<div class="metric-grid stagger-group">`;
  body += metric('需求覆盖', `${traceabilityTree?.percentage || 0}%`, `${traceabilityTree?.covered || 0}/${traceabilityTree?.total || 0}`, (traceabilityTree?.percentage || 0) === 100 ? 'success' : 'accent');
  body += metric('改造点', String(changePoints.length), 'CP');
  body += metric('Task', String(normalizedTasks.length), '实现拆分');
  body += metric('数据/API', `${dataChanges ? 1 : 0}/${apiChanges ? 1 : 0}`, 'DB/API 计划');
  body += `</div>\n`;

  body += sectionNav([
    { id: 'implementation-plan', label: '完整 To-Be 方案' },
    { id: 'to-be-model', label: '目标核心时序' },
    { id: 'change-flow', label: '变更点在 As-Is 节点上的呈现' },
    { id: 'change-points', label: '全部变更点' },
    { id: 'risk-plan', label: '风险点与风险评估' },
  ]);
  if (implementationPlan) {
    body += detailPanel('implementation-plan', '完整 To-Be 方案（完整实施方案）', `<div class="section-md">${mdToHtml(implementationPlan)}</div>`, true);
  }
  body += renderToBeUml(impactRisk || {});
  body += renderChangeFlow(impactRisk || {}, changePoints);

  if ((normalizedTasks || []).length > 0) {
    let taskBody = `<table><tr><th>Task</th><th>风险</th><th>关联需求</th><th>目标</th></tr>`;
    for (const t of normalizedTasks) {
      taskBody += `<tr><td><strong>${esc(t.id)}</strong></td><td><span class="pill ${pillClass(t.risk_level)}">${esc(t.risk_level)}</span></td><td>${esc((t.trace_refs || []).join(', ') || '—')}</td><td class="desc">${esc(oneSentence(t.title || t.goal))}</td></tr>`;
    }
    body += detailPanel('task-plan', `Task 拆分（${normalizedTasks.length}）`, `${taskBody}</table>`);
  }

  if (changePoints.length > 0) {
    body += `<section id="change-points" class="cp-grid">${changePoints.slice(0, 30).map(cp => detailPanel(`cp-${domId(cp.id)}`, `${cp.id} · ${cp.node || cp.summary || '改造点'}`, `<div class="cp-summary"><span class="pill ${pillClass(cp.decision === '删除' ? 'fail' : cp.decision === '新增' ? 'approved' : 'coding')}">${esc(cp.decision || '改造')}</span><span class="pill ${pillClass(cp.risk_level || 'low')}">${esc(cp.risk_level || 'low')}</span></div><p>${esc(cp.summary || cp.description || cp.node || '')}</p>${cp.reason ? `<p><strong>设计理由：</strong>${esc(cp.reason)}</p>` : ''}`)).join('')}</section>`;
  }

  if (impactRisk?.risk_matrix?.length) {
    let riskBody = `<table><tr><th>ID</th><th>描述</th><th>严重度</th><th>缓解</th></tr>`;
    for (const r of impactRisk.risk_matrix.slice(0, 10)) {
      riskBody += `<tr><td>${esc(r.id)}</td><td class="desc">${esc(oneSentence(r.description))}</td><td><span class="pill ${pillClass(r.severity)}">${esc(r.severity)}</span></td><td class="desc">${esc(oneSentence(r.mitigation))}</td></tr>`;
    }
    body += detailPanel('risk-plan', `风险矩阵（${impactRisk.risk_matrix.length}）`, `${riskBody}</table>`);
  }

  return wrapHtml(`To-Be — ${data.ideaName}`, body);
}

function renderUnitTestSection(data) {
  const result = data.unitTestResult;
  let body = blockHero('🧪', '单测与覆盖率', data.ideaName);
  if (!result) {
    body += `<div class="card animate-in"><p class="muted">暂无 unit-test-result.json；必须完成单测、覆盖率采集和异常集中返修后才能进入 CR。</p></div>`;
    return wrapHtml(`单测 — ${data.ideaName}`, body);
  }
  const repositories = Array.isArray(result.repositories) ? result.repositories : [];
  const tests = repositories.flatMap(repo => repo.requirement_unit_tests || []);
  const anomalies = result.run_summary?.anomalies || [];
  const coverage = repositories.map(repo => repo.coverage).filter(Boolean);
  const average = key => coverage.length ? Math.round(coverage.reduce((sum, item) => sum + Number(item[key]?.pct || 0), 0) / coverage.length * 100) / 100 : 0;
  body += `<div class="metric-grid stagger-group">`;
  body += metric('执行结果', result.status, `${result.run_summary?.total_runs || 0} 轮`, result.status === 'pass' ? 'success' : 'danger');
  body += metric('Lines', `${average('lines')}%`, '行覆盖率', average('lines') >= 80 ? 'success' : 'warn');
  body += metric('Branches', `${average('branches')}%`, '分支覆盖率', average('branches') >= 80 ? 'success' : 'warn');
  body += metric('返修次数', String(result.run_summary?.repair_count || 0), `${anomalies.length} 个异常`, anomalies.length ? 'warn' : 'success');
  body += `</div>`;
  body += `<div class="card animate-in"><h2>覆盖率明细</h2><table><tr><th>仓库</th><th>Lines</th><th>Statements</th><th>Functions</th><th>Branches</th></tr>`;
  for (const repo of repositories) {
    const c = repo.coverage || {};
    body += `<tr><td class="desc">${esc(repo.project_root)}</td><td>${esc(c.lines?.pct ?? '—')}%</td><td>${esc(c.statements?.pct ?? '—')}%</td><td>${esc(c.functions?.pct ?? '—')}%</td><td>${esc(c.branches?.pct ?? '—')}%</td></tr>`;
  }
  body += `</table></div>`;
  body += `<div class="card animate-in"><h2>本次需求补充的单测 List</h2>${tests.length ? `<table><tr><th>状态</th><th>测试文件</th></tr>${tests.map(test => `<tr><td>${esc(test.status)}</td><td class="desc">${esc(test.file)}</td></tr>`).join('')}</table>` : '<p class="muted">Git diff 中未识别到新增或修改的单测文件。</p>'}</div>`;
  body += `<div class="card animate-in"><h2>单测通过与返修情况</h2><p>共执行 ${esc(result.run_summary?.total_runs || 0)} 轮，失败 ${esc(result.run_summary?.failed_runs || 0)} 轮，集中返修 ${esc(result.run_summary?.repair_count || 0)} 次，当前状态：<span class="pill ${pillClass(result.status)}">${esc(result.status)}</span>。</p>${anomalies.length ? `<table><tr><th>轮次</th><th>检查</th><th>异常</th><th>状态</th></tr>${anomalies.map(item => `<tr><td>${esc(item.run)}</td><td>${esc(item.check)}</td><td class="desc">${esc((item.failed_tests || []).join('; ') || oneSentence(item.output_tail || '未解析到测试名'))}</td><td>${item.resolved ? '已修复' : '待修复'}</td></tr>`).join('')}</table>` : '<p class="muted">未记录单测异常。</p>'}</div>`;
  return wrapHtml(`单测 — ${data.ideaName}`, body);
}

function renderProgressSection(data) {
  const { tasks, taskDetails, traceabilityTree } = data;
  const entries = Object.entries(tasks || {});
  let body = blockHero('🚀', '实现进度', data.ideaName);

  const stats = countTasksByStatus(tasks);
  body += `<div class="metric-grid stagger-group">`;
  body += metric('总计', String(stats.total), '', 'accent');
  body += metric('已通过', String(stats.approved), '', 'success');
  body += metric('返修中', String((stats.byStatus.needs_rework || 0) + (stats.byStatus.repairing || 0)), '', 'warn');
  body += metric('编码中', String((stats.byStatus.coding || 0) + (stats.byStatus.coded || 0)), '', 'accent');
  body += `</div>\n`;

  body += `<div class="progress animate-in"><div class="progress-fill ${stats.percentage === 100 ? 'fill-success' : 'fill-accent'}" style="width:${stats.percentage}%"></div></div>\n`;

  if (entries.length > 0) {
    body += `<div class="card animate-in"><h2>Task 状态矩阵</h2><table><tr><th>Task</th><th>状态</th><th>返修</th><th>描述</th></tr>`;
    for (const [id, t] of entries) {
      body += `<tr><td><strong>${esc(id)}</strong></td><td><span class="pill ${pillClass(t.status || 'pending')}">${esc(t.status || 'pending')}</span></td><td>${t.rework_count || 0}</td><td class="desc">${esc(oneSentence(t.description || ''))}</td></tr>`;
    }
    body += `</table></div>\n`;
  }

  if (traceabilityTree && traceabilityTree.total > 0) {
    body += `<div class="card animate-in"><h2>需求覆盖度 — ${traceabilityTree.percentage}%</h2>`;
    body += `<div class="progress"><div class="progress-fill ${traceabilityTree.percentage === 100 ? 'fill-success' : 'fill-warn'}" style="width:${traceabilityTree.percentage}%"></div></div>`;
    const missing = (traceabilityTree.requirementItems || []).filter(i => i.coverage === 'missing');
    if (missing.length > 0) {
      body += `<h2 style="margin-top:16px">缺失覆盖项 (${missing.length})</h2><table><tr><th>ID</th><th>类型</th><th>描述</th></tr>`;
      for (const item of missing.slice(0, 10)) {
        body += `<tr><td>${esc(item.id)}</td><td>${esc(item.type)}</td><td class="desc">${esc(oneSentence(item.description))}</td></tr>`;
      }
      body += `</table>`;
    }
    body += `</div>\n`;
  }

  return wrapHtml(`进度 — ${data.ideaName}`, body);
}

function renderCrSection(data) {
  const { crResults, taskDetails, reviewReportMd, aggregateAssessmentMd, normalizedTasks, tasks } = data;
  let body = blockHero('🔍', 'CR 审查结果', data.ideaName);

  if (crResults.length === 0) {
    body += `<div class="card animate-in"><p class="muted">暂无 CR 结果。</p></div>`;
    return wrapHtml(`CR — ${data.ideaName}`, body);
  }

  const stats = countCrFindings(crResults);
  body += `<div class="metric-grid stagger-group">`;
  body += metric('Rework', String(stats.rework), '需返修', stats.rework ? 'danger' : 'success');
  body += metric('High 严重度', String(stats.highSeverity), '高风险', stats.highSeverity ? 'danger' : 'success');
  body += metric('平均置信度', stats.avgConfidence ? `${stats.avgConfidence}%` : '—', '');
  body += metric('Observations', String(stats.observations), '参考建议');
  body += `</div>\n`;

  if ((normalizedTasks || []).length > 0) {
    body += `<div class="card animate-in"><h2>本次开发功能</h2><table><tr><th>Task</th><th>功能</th><th>状态</th><th>累计返修</th></tr>`;
    for (const task of normalizedTasks || []) {
      const state = tasks?.[task.id] || {};
      body += `<tr><td>${esc(task.id)}</td><td class="desc">${esc(oneSentence(task.title || task.goal))}</td><td>${esc(state.status || 'pending')}</td><td>${esc(state.rework_count || 0)}</td></tr>`;
    }
    body += `</table></div>`;
  }

  body += `<div class="card animate-in"><h2>维度总览</h2><table><tr><th>维度</th><th>结果</th><th>Rework</th><th>Obs</th></tr>`;
  for (const r of crResults) {
    body += `<tr><td>${esc(r.dimension)}</td><td><span class="pill ${pillClass(r.result)}">${esc(r.result)}</span></td><td>${r.reworkItems?.length || 0}</td><td>${r.observations?.length || 0}</td></tr>`;
  }
  body += `</table></div>\n`;

  const reworkItems = crResults.flatMap(r => (r.reworkItems || []).map(i => ({ ...i, dim: r.dimension })));
  if (reworkItems.length > 0) {
    body += `<div class="card animate-in card-accent-red"><h2>Rework Items</h2><table><tr><th>维度</th><th>问题</th><th>严重度</th><th>置信度</th></tr>`;
    for (const i of reworkItems) {
      const desc = i['问题描述'] || i.description || '';
      const sev = i['严重度'] || i.severity || '';
      body += `<tr><td>${esc(i.dim)}</td><td class="desc">${esc(oneSentence(desc))}</td><td><span class="pill ${pillClass(sev)}">${esc(sev)}</span></td><td>${esc(i['置信度'] || i.confidence || '')}</td></tr>`;
    }
    body += `</table></div>\n`;
  }

  if (reviewReportMd) {
    body += `<div class="card animate-in"><h2>总报告</h2><div class="section-md">${mdToHtml(reviewReportMd)}</div></div>\n`;
  }
  if (aggregateAssessmentMd) {
    body += `<div class="card animate-in card-accent-purple"><h2>多维问题汇总裁决与根因合并</h2><div class="section-md">${mdToHtml(aggregateAssessmentMd)}</div></div>\n`;
  }

  return wrapHtml(`CR — ${data.ideaName}`, body);
}

/**
 * Render the structured merge-review packet.  This deliberately reads the
 * internal JSON snapshot (and the optional confirmation), so every value in
 * the CR report is bound to the exact source snapshot that was reviewed.
 */
function renderCurrentChangeSection(data) {
  const report = data.currentChangeReport;
  let body = blockHero('🧭', '合并审阅', data.ideaName);

  if (!report) {
    body += `<div class="card animate-in"><p class="muted">合并审阅数据尚未生成。</p><p class="muted">完成 review:merge 后，本章节会直接更新到同一份 CR 报告中。</p></div>`;
    return wrapHtml(`合并审阅 — ${data.ideaName}`, body);
  }

  const readiness = report.readiness || {};
  const repositories = Array.isArray(report.repositories) ? report.repositories : [];
  const verification = report.verification || {};
  const machine = report.machine_review || {};
  const risk = report.risk || {};
  const repoTotals = repositories.reduce((totals, repo) => {
    const files = Array.isArray(repo.files) ? repo.files : [];
    const reported = repo.totals || {};
    totals.files += Number(reported.files ?? files.length) || 0;
    totals.additions += Number(reported.additions) || files.reduce((sum, file) => sum + (Number(file.additions) || 0), 0);
    totals.deletions += Number(reported.deletions) || files.reduce((sum, file) => sum + (Number(file.deletions) || 0), 0);
    return totals;
  }, { files: 0, additions: 0, deletions: 0 });
  const confirmation = data.mergeConfirmation;
  const confirmationMatches = Boolean(
    confirmation && data.currentChangeReportSha256 &&
    confirmation.report_sha256 === data.currentChangeReportSha256
  );
  // A decision embedded in the immutable report is safe to show.  A separate
  // confirmation is only trusted when its hash binds it to this exact report.
  const reviewDecision = report.review_decision || report.reviewDecision || (confirmationMatches ? confirmation : null);

  body += `<div class="metric-grid stagger-group">`;
  body += metric('Merge readiness', readiness.status || 'unknown', (readiness.blockers || []).length ? `${readiness.blockers.length} blocker(s)` : '无阻塞条件', readiness.status === 'ready_for_human_review' ? 'success' : 'warn');
  body += metric('仓库范围', String(repositories.length), 'repositories', 'accent');
  body += metric('变更文件', String(repoTotals.files), `+${repoTotals.additions} / -${repoTotals.deletions}`, repoTotals.files ? 'accent' : 'success');
  body += metric('Verification', verification.status || 'missing', '', verification.status === 'passed' || verification.status === 'pass' ? 'success' : 'warn');
  body += metric('Machine CR', machine.verdict || 'unknown', `${machine.blocking_findings || 0} blocking`, machine.verdict === 'approved' ? 'success' : 'danger');
  body += metric('Risk', risk.level || 'not_assessed', '', ['low', 'none', 'not_assessed'].includes(risk.level) ? 'success' : 'warn');
  body += `</div>\n`;

  body += `<div class="card animate-in card-accent-purple"><h2>当前代码已实现的内容</h2>`;
  if (report.implementation_summary) {
    body += `<div class="section-md">${mdToHtml(report.implementation_summary)}</div>`;
  } else {
    body += `<p class="muted">未找到 final-summary.md，无法说明当前实现。</p>`;
  }
  const tasks = Array.isArray(report.tasks) ? report.tasks : [];
  if (tasks.length > 0) {
    body += `<h3 class="subheading">Task 与落地文件</h3><div class="table-scroll"><table><tr><th>Task</th><th>做了什么</th><th>涉及文件</th><th>返修</th></tr>`;
    for (const task of tasks) body += `<tr><td>${esc(task.task_id || '—')}</td><td class="desc">${esc(task.description || '未记录')}</td><td class="desc mono">${esc((task.changed_files || []).join(', ') || '—')}</td><td>${esc(task.rework_count || 0)}</td></tr>`;
    body += `</table></div>`;
  }
  body += `</div>\n`;

  body += `<div class="card animate-in card-accent-${readiness.status === 'ready_for_human_review' ? 'green' : 'orange'}"><h2>Readiness</h2>`;
  if (readiness.status) body += `<p><span class="pill ${pillClass(readiness.status)}">${esc(readiness.status)}</span></p>`;
  const blockers = Array.isArray(readiness.blockers) ? readiness.blockers : [];
  if (blockers.length > 0) {
    body += `<ul class="change-list">${blockers.map(item => `<li>${esc(item)}</li>`).join('')}</ul>`;
  } else {
    body += `<p class="muted">未记录阻塞条件。</p>`;
  }
  body += `</div>\n`;

  body += `<div class="card animate-in"><h2>Repository scope</h2>`;
  if (repositories.length === 0) {
    body += `<p class="muted">报告未包含仓库。</p>`;
  } else {
    body += `<div class="table-scroll"><table><tr><th>Repository</th><th>Branch</th><th>Base → Head</th><th>Workspace</th><th>Dirty</th></tr>`;
    for (const repo of repositories) {
      const base = String(repo.base_commit || '').slice(0, 12) || '—';
      const head = String(repo.head_commit || '').slice(0, 12) || '—';
      const fingerprint = String(repo.workspace_fingerprint || '').slice(0, 12) || '—';
      body += `<tr><td><strong>${esc(repo.repository || repo.project_root || 'unknown')}</strong><div class="muted mono">${esc(repo.project_root || '')}</div></td><td>${esc(repo.branch || '—')}</td><td class="mono">${esc(base)} → ${esc(head)}</td><td class="mono">${esc(fingerprint)}</td><td><span class="pill ${repo.dirty ? 'pill-warn' : 'pill-success'}">${repo.dirty ? 'dirty' : 'clean'}</span></td></tr>`;
    }
    body += `</table></div>`;
  }
  body += `</div>\n`;

  body += `<div class="card animate-in"><h2>Diff totals &amp; files</h2>`;
  body += `<div class="metric-grid compact-grid">${metric('Files', String(repoTotals.files))}${metric('Additions', `+${repoTotals.additions}`, '', 'success')}${metric('Deletions', `-${repoTotals.deletions}`, '', 'danger')}</div>`;
  for (const repo of repositories) {
    const files = Array.isArray(repo.files) ? repo.files : [];
    body += `<h3 class="subheading">${esc(repo.repository || repo.project_root || 'repository')}</h3>`;
    if (files.length === 0) {
      body += `<p class="muted">No changed files.</p>`;
      continue;
    }
    body += `<div class="table-scroll"><table><tr><th>Status</th><th>File</th><th>+</th><th>−</th></tr>`;
    for (const file of files) {
      const binary = Boolean(file.binary);
      body += `<tr><td><span class="pill ${pillClass(String(file.status || '').toLowerCase() === 'd' ? 'fail' : 'coding')}">${esc(file.status || '—')}</span></td><td class="desc mono" title="${esc(file.path || '')}">${esc(file.path || '—')}</td><td>${binary ? 'binary' : Number(file.additions || 0)}</td><td>${binary ? 'binary' : Number(file.deletions || 0)}</td></tr>`;
    }
    body += `</table></div>`;
  }
  body += `</div>\n`;

  body += `<div class="card animate-in"><h2>Automated checks</h2>`;
  const checkRows = repositories.flatMap(repo => (Array.isArray(repo.checks) ? repo.checks : []).map(check => ({ repo, check })));
  const verificationRows = Array.isArray(verification.repositories) ? verification.repositories.flatMap(repo => (Array.isArray(repo.checks) ? repo.checks : []).map(check => ({ repo, check }))) : [];
  const checks = checkRows.length > 0 ? checkRows : verificationRows;
  if (checks.length === 0) {
    body += `<p class="muted">暂无自动化检查结果。</p>`;
  } else {
    body += `<div class="table-scroll"><table><tr><th>Repository</th><th>Check</th><th>Command</th><th>Result</th><th>Duration</th></tr>`;
    for (const row of checks) {
      const repoName = row.repo?.repository || row.repo?.project_root || 'repository';
      const check = row.check || {};
      const status = check.status || 'unknown';
      body += `<tr><td>${esc(repoName)}</td><td><strong>${esc(check.id || 'check')}</strong></td><td class="desc mono" title="${esc(check.command || '')}">${esc(check.command || '—')}</td><td><span class="pill ${pillClass(status)}">${esc(status)}</span></td><td class="mono">${check.duration_ms == null ? '—' : `${esc(check.duration_ms)} ms`}</td></tr>`;
    }
    body += `</table></div>`;
  }
  body += `</div>\n`;

  body += `<div class="card animate-in"><h2>Machine CR</h2>`;
  const dimensions = Array.isArray(machine.dimensions) ? machine.dimensions : [];
  if (dimensions.length > 0) {
    body += `<div class="table-scroll"><table><tr><th>Dimension</th><th>Result</th><th>Blocking</th><th>Observations</th></tr>`;
    for (const dim of dimensions) body += `<tr><td>${esc(dim.name || dim.dimension || 'dimension')}</td><td><span class="pill ${pillClass(dim.result)}">${esc(dim.result || 'unknown')}</span></td><td>${esc(dim.rework_items ?? dim.reworkItems?.length ?? 0)}</td><td>${esc(dim.observations ?? dim.observation_count ?? 0)}</td></tr>`;
    body += `</table></div>`;
  } else {
    body += `<p class="muted">未记录维度结果。</p>`;
  }
  const findings = Array.isArray(machine.findings) ? machine.findings : (Array.isArray(machine.blocking_findings) ? machine.blocking_findings : []);
  const observations = Array.isArray(machine.observations) ? machine.observations : [];
  if (findings.length > 0) {
    body += `<h3 class="subheading">Blocking findings</h3><ul class="change-list">${findings.map(item => `<li><span class="pill ${pillClass(item.severity)}">${esc(item.severity || 'unknown')}</span> <strong>${esc(item.id || 'finding')}</strong> ${esc(oneSentence(item.description || item['问题描述'] || ''))}${item.recommendation ? ` <span class="muted">${esc(oneSentence(item.recommendation))}</span>` : ''}</li>`).join('')}</ul>`;
  }
  if (observations.length > 0) {
    body += `<h3 class="subheading">Observations</h3><ul class="change-list">${observations.map(item => `<li><strong>${esc(item.id || 'observation')}</strong> ${esc(oneSentence(item.description || item['描述'] || ''))}</li>`).join('')}</ul>`;
  }
  body += `</div>\n`;

  body += `<div class="card animate-in card-accent-${['low', 'none'].includes(risk.level) ? 'green' : 'orange'}"><h2>Risk &amp; compatibility</h2><p><span class="pill ${pillClass(risk.level)}">${esc(risk.level || 'not_assessed')}</span>${risk.highest_risk ? ` <span>${esc(risk.highest_risk)}</span>` : ''}</p>`;
  const riskItems = Array.isArray(risk.items) ? risk.items : [];
  if (riskItems.length > 0) {
    body += `<div class="table-scroll"><table><tr><th>ID</th><th>Severity</th><th>Description</th><th>Mitigation</th></tr>`;
    for (const item of riskItems) body += `<tr><td>${esc(item.id || 'RISK')}</td><td><span class="pill ${pillClass(item.severity)}">${esc(item.severity || 'unknown')}</span></td><td class="desc">${esc(oneSentence(item.description || ''))}</td><td class="desc">${esc(oneSentence(item.mitigation || '—'))}</td></tr>`;
    body += `</table></div>`;
  } else if (!risk.highest_risk) {
    body += `<p class="muted">未记录风险条目。</p>`;
  }
  body += `</div>\n`;

  body += `<div class="card animate-in card-accent-purple"><h2>Human review decision</h2>`;
  if (reviewDecision) {
    const decision = reviewDecision.decision || reviewDecision.status || 'unknown';
    body += `<p><span class="pill ${pillClass(decision)}">${esc(decision)}</span>${reviewDecision.confirmed_by ? ` · ${esc(reviewDecision.confirmed_by)}` : ''}${reviewDecision.confirmed_at ? ` · ${esc(reviewDecision.confirmed_at)}` : ''}</p>`;
    if (reviewDecision.comment) body += `<p class="section-md">${esc(reviewDecision.comment)}</p>`;
  } else {
    body += `<p class="muted">尚未记录人工审阅决定。</p>`;
    body += `<ul class="change-list"><li><strong>Approve</strong> — exact snapshot may proceed to merge.</li><li><strong>Request changes</strong> — return to repair and generate a new report.</li><li><strong>Comment / hold</strong> — record feedback without authorizing merge.</li></ul>`;
  }
  body += `</div>\n`;

  return wrapHtml(`合并审阅 — ${data.ideaName}`, body);
}

function renderTimelineSection(data) {
  const { timingSummary, stepOutputs, stepHistory } = data;
  let body = blockHero('⏱️', '时间线与产出', data.ideaName);

  if (timingSummary.steps.length > 0) {
    const maxMs = Math.max(1, ...timingSummary.steps.map(s => s.duration_ms));
    body += `<div class="card animate-in"><h2>环节耗时 · 总计 ${esc(timingSummary.total_label)}</h2>`;
    for (const s of timingSummary.steps) {
      const pct = Math.max(2, Math.round((s.duration_ms / maxMs) * 100));
      body += `<div class="timing-row"><div class="timing-step">${esc(s.step)}${s.running ? ' · 进行中' : ''}</div><div class="timing-bar"><div class="timing-fill" style="width:${pct}%"></div></div><div class="timing-val">${esc(s.duration_label)}</div></div>`;
    }
    body += `</div>\n`;
  }

  if (stepOutputs.length > 0) {
    body += `<div class="card animate-in"><h2>步骤产出</h2><table><tr><th>步骤</th><th>状态</th><th>产出</th></tr>`;
    for (const so of stepOutputs) {
      const statusText = so.status === 'done' ? '已完成' : so.status === 'current' ? '进行中' : '待执行';
      const outputs = so.outputs.length === 0 ? '—' : so.outputs.map(o => `${o.exists ? '✓' : '✗'} ${o.label}`).join(', ');
      body += `<tr><td style="font-family:var(--mono);font-size:0.72rem">${esc(so.step)}</td><td><span class="pill ${pillClass(so.status === 'done' ? 'approved' : so.status === 'current' ? 'coding' : 'pending')}">${statusText}</span></td><td style="font-size:0.78rem">${esc(outputs)}</td></tr>`;
    }
    body += `</table></div>\n`;
  }

  if (stepHistory.length > 0) {
    body += `<div class="card animate-in"><h2>时间线</h2>`;
    for (const h of stepHistory) {
      const time = (h.entered_at || '').slice(0, 16).replace('T', ' ');
      body += `<div style="display:flex;gap:12px;padding:6px 0;font-size:0.82rem"><span style="color:var(--text3);min-width:130px;font-family:var(--mono);font-size:0.72rem">${esc(time)}</span><span>${esc(h.step)}</span></div>`;
    }
    body += `</div>\n`;
  }

  return wrapHtml(`时间线 — ${data.ideaName}`, body);
}

// --- Public report sections ---

function loadData(ideaDir) {
  const workflowState = readWorkflowState(ideaDir);
  const taskState = readTaskState(taskStateFile(ideaDir));
  const crResults = collectCrResults(ideaDir);
  const reviewReportMd = readMd(ideaDir, 'cr/review-report.md');
  const aggregateAssessmentMd = readMd(ideaDir, 'cr/aggregate-assessment.md');
  const currentChangeReport = readJson(ideaDir, 'cr/current-change-report.json');
  const currentChangeReportSha256 = fileSha256(join(ideaDir, 'cr/current-change-report.json'));
  const rawMergeConfirmation = readJson(ideaDir, 'confirmations/merge-review.json');
  const mergeConfirmation = rawMergeConfirmation?.report_sha256 === currentChangeReportSha256
    ? rawMergeConfirmation
    : null;
  const impactRisk = readJson(ideaDir, 'to-be/impact-risk-report.json');
  const overview = readMd(ideaDir, 'as-is/overview.md');
  const coreWalkthrough = readMd(ideaDir, 'as-is/core-walkthrough.md');
  const evidenceLedger = readJson(ideaDir, 'as-is/evidence-ledger.json');
  const qualityScore = readJson(ideaDir, 'as-is/quality-score.json');
  const coverageMatrix = readJson(ideaDir, 'as-is/coverage-matrix.json');
  const implementationPlan = readMd(ideaDir, 'to-be/implementation-plan.md');
  const tasksJson = readJson(ideaDir, 'to-be/tasks.json');
  const clarification = readJson(ideaDir, 'requirement-clarification.json');
  const dataChangePlanJson = readJson(ideaDir, 'to-be/data-change-plan.json');
  const dataChangePlanMd = readMd(ideaDir, 'to-be/data-change-plan.md');
  const apiChangePlanJson = readJson(ideaDir, 'to-be/api-change-plan.json');
  const apiChangePlanMd = readMd(ideaDir, 'to-be/api-change-plan.md');
  const unitTestResult = readJson(ideaDir, 'unit-test-result.json');
  let performanceMetrics = null;
  try { performanceMetrics = collectSessionMetrics(ideaDir); } catch { /* optional metrics */ }

  const normalizedTasks = normalizeTasksJson(tasksJson);
  const coverageRefs = normalizeCoverageMatrixRefs(coverageMatrix || {});
  const traceabilityTree = normalizeTraceabilityTree({ traceability: collectTraceability(ideaDir), clarification, tasks: normalizedTasks, taskState });
  const dataChanges = normalizeDataChangePlan(dataChangePlanJson, dataChangePlanMd);
  const apiChanges = normalizeApiChangePlan(apiChangePlanJson, apiChangePlanMd);

  const ideaName = basename(ideaDir);
  const complexity = detectComplexity(ideaDir);
  const currentStep = workflowState?.current_step || 'unknown';

  const WORKFLOW_STEPS = [...(WORKFLOW_PATHS[complexity] || WORKFLOW_PATHS.standard).map(item => item.step)];
  if (currentStep === 'repair:code' && !WORKFLOW_STEPS.includes('repair:code')) {
    const idx = WORKFLOW_STEPS.indexOf('implement:code');
    WORKFLOW_STEPS.splice(idx + 1, 0, 'repair:code');
  }
  if (!WORKFLOW_STEPS.includes('done')) WORKFLOW_STEPS.push('done');

  const currentIdx = WORKFLOW_STEPS.indexOf(currentStep);
  const stepOutputs = collectStepOutputs(ideaDir, WORKFLOW_STEPS, currentStep, workflowState?.step_history || []);
  const timingSummary = normalizeStepTimings({
    stepHistory: workflowState?.step_history || [],
    currentStep,
    startedAt: workflowState?.started_at || '',
    lastUpdated: workflowState?.last_updated_at || ''
  });
  const summary = computeReportSummary({
    tasks: taskState.tasks,
    traceabilityModel: traceabilityTree,
    crResults,
    impactRisk,
    currentIdx,
    workflowSteps: WORKFLOW_STEPS
  });

  // Collect task details inline (lightweight version)
  const taskDetails = {};
  for (const [taskId, task] of Object.entries(taskState.tasks || {})) {
    taskDetails[taskId] = { id: taskId, status: task.status || 'pending', description: task.description || '' };
  }

  // Normalize change points
  const changePoints = [];
  for (const cp of (impactRisk?.change_points || [])) {
    changePoints.push({ ...cp, summary: oneSentence(cp.description || cp.node || cp.id) });
  }

  return {
    ideaName, complexity, currentStep,
    workflowSteps: WORKFLOW_STEPS, currentIdx,
    summary, timingSummary, stepOutputs,
    tasks: taskState.tasks, taskDetails,
    normalizedTasks, traceabilityTree, changePoints,
    crResults, reviewReportMd, aggregateAssessmentMd, currentChangeReport, currentChangeReportSha256, mergeConfirmation, impactRisk,
    overview, coreWalkthrough, evidenceLedger, qualityScore, coverageMatrix,
    implementationPlan, dataChanges, apiChanges, unitTestResult, performanceMetrics,
    stepHistory: workflowState?.step_history || [],
  };
}

const REPORT_SECTIONS = {
  overview: renderOverviewSection,
  'as-is': renderAsIsSection,
  'to-be': renderToBeSection,
  'unit-tests': renderUnitTestSection,
  progress: renderProgressSection,
  'cr-results': renderCrSection,
  'current-change': renderCurrentChangeSection,
  timeline: renderTimelineSection,
};

export { REPORT_SECTIONS, loadData };
