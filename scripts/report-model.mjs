#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readTaskState, taskStateFile, readFrontmatter, detectComplexity } from './workflow-lib.mjs';

// Shared report data model. No HTML page or workflow side effects live here.

// --- Data collection ---

function readJson(ideaDir, rel) {
  const p = join(ideaDir, rel);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function parseTableSection(text, heading) {
  const pattern = new RegExp(`^##\\s+${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^\\n]*\\n`, 'm');
  const match = text.match(pattern);
  if (!match) return [];
  const start = match.index + match[0].length;
  const rest = text.slice(start);
  const endMatch = rest.match(/^##\s/m);
  const section = endMatch ? rest.slice(0, endMatch.index) : rest;
  const lines = section.split('\n').filter(l => /^\|/.test(l) && /\|$/.test(l.trim()));
  if (lines.length < 2) return [];
  const headers = lines[0].split('|').slice(1, -1).map(c => c.trim().toLowerCase());
  return lines.slice(2).map(line => {
    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    const row = {};
    headers.forEach((h, i) => { row[h] = cells[i] || ''; });
    return row;
  });
}

function collectCrResults(ideaDir) {
  const crDir = join(ideaDir, 'cr');
  if (!existsSync(crDir)) return [];
  const files = readdirSync(crDir).filter(f => /^dim-.*-cr\.md$/.test(f));
  return files.map(f => {
    const text = readFileSync(join(crDir, f), 'utf8');
    const fm = readFrontmatter(text);
    const reworkItems = parseTableSection(text, 'Rework Items');
    const observations = parseTableSection(text, 'Observations (non-blocking)');
    return { file: f, dimension: fm.dimension || f.replace('dim-', '').replace('-cr.md', ''), result: fm.result || 'unknown', reworkItems, observations, ...fm };
  });
}

function collectTraceability(ideaDir) {
  const matrix = readJson(ideaDir, 'to-be/traceability-matrix.json');
  if (!matrix) return null;
  const state = readTaskState(taskStateFile(ideaDir));
  const items = (matrix.items || matrix || []).map(item => {
    const tasks = item.covered_by_tasks || [];
    const statuses = tasks.map(t => state.tasks[t]?.status || 'unknown');
    const allApproved = statuses.length > 0 && statuses.every(s => s === 'approved');
    const anyInProgress = statuses.some(s => ['coding', 'coded', 'reviewing', 'repairing'].includes(s));
    return { ...item, task_statuses: statuses, coverage: allApproved ? 'complete' : anyInProgress ? 'in_progress' : tasks.length === 0 ? 'missing' : 'pending' };
  });
  const total = items.length;
  const covered = items.filter(i => i.coverage === 'complete').length;
  return { total, covered, percentage: total > 0 ? Math.round((covered / total) * 100) : 0, items };
}

// --- Markdown to HTML ---

export function mdToHtml(md) {
  if (!md) return '';
  let html = '';
  const lines = md.split('\n');
  let inCode = false, codeContent = '', codeLang = '';
  let inList = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('```')) {
      if (!inCode) {
        if (inList) { html += '</ul>'; inList = false; }
        inCode = true;
        codeLang = line.slice(3).trim();
        codeContent = '';
      } else {
        if (codeLang === 'mermaid') {
          html += `<pre class="mermaid">${escHtml(codeContent)}</pre>`;
        } else {
          html += `<pre><code class="language-${codeLang || 'text'}">${escHtml(codeContent)}</code></pre>`;
        }
        inCode = false;
        codeLang = '';
      }
      continue;
    }
    if (inCode) { codeContent += (codeContent ? '\n' : '') + line; continue; }

    if (/^#{1,6}\s/.test(line)) {
      if (inList) { html += '</ul>'; inList = false; }
      const level = line.match(/^(#+)/)[1].length;
      const text = inlineFormat(line.replace(/^#+\s*/, ''));
      html += `<h${level}>${text}</h${level}>`;
    } else if (/^[-*]\s/.test(line)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inlineFormat(line.replace(/^[-*]\s*/, ''))}</li>`;
    } else if (/^\d+\.\s/.test(line)) {
      if (!inList) { html += '<ul>'; inList = true; }
      html += `<li>${inlineFormat(line.replace(/^\d+\.\s*/, ''))}</li>`;
    } else if (/^\|/.test(line) && /\|$/.test(line.trim())) {
      if (inList) { html += '</ul>'; inList = false; }
      const cells = line.split('|').slice(1, -1).map(c => c.trim());
      if (cells.every(c => /^[-:]+$/.test(c))) continue;
      const isHeader = i + 1 < lines.length && /^\|[-:|\s]+\|$/.test(lines[i + 1]?.trim() || '');
      const tag = isHeader ? 'th' : 'td';
      html += `<tr>${cells.map(c => `<${tag}>${inlineFormat(c)}</${tag}>`).join('')}</tr>`;
    } else if (line.trim() === '') {
      if (inList) { html += '</ul>'; inList = false; }
    } else {
      if (inList) { html += '</ul>'; inList = false; }
      html += `<p>${inlineFormat(line)}</p>`;
    }
  }
  if (inList) html += '</ul>';
  if (inCode && codeContent) {
    if (codeLang === 'mermaid') html += `<pre class="mermaid">${escHtml(codeContent)}</pre>`;
    else html += `<pre><code>${escHtml(codeContent)}</code></pre>`;
  }
  return html;
}

function inlineFormat(text) {
  return escHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

function escHtml(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}


function escAttr(s) {
  return escHtml(s).replace(/'/g, '&#39;');
}

function stripMarkdown(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/[\*_~]/g, '')
    .replace(/\|/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function oneSentence(text, fallback = '') {
  const clean = stripMarkdown(text || fallback);
  if (!clean) return fallback || '';
  const m = clean.match(/^(.{1,180}?[。.!！？?])/);
  if (m) return m[1];
  if (clean.length <= 180) return clean;
  const cut = clean.slice(0, 180).replace(/[，,；;：:].*$/, '');
  return (cut || clean.slice(0, 180)) + '…';
}

function normalizeTaskItem(t = {}) {
  return {
    ...t,
    id: t.task_id || t.id || '',
    title: t.title || t.goal || '',
    goal: t.goal || t.description || t.title || '',
    risk_level: t.risk_level || t.risk || 'low',
    change_point_refs: t.change_point_refs || t.cp_refs || [],
    trace_refs: t.trace_refs || [],
    acceptance_criteria: t.acceptance_criteria || t.ac || [],
    depends_on: t.depends_on || [],
    expected_files: t.expected_files || [],
    allowed_files: t.allowed_files || [],
    forbidden_files: t.forbidden_files || [],
    context_to_load: t.context_to_load || {},
  };
}

function normalizeTasksJson(tasksJson) {
  const raw = tasksJson?.tasks || (Array.isArray(tasksJson) ? tasksJson : []);
  return raw.map(normalizeTaskItem).filter(t => t.id);
}

function inferTraceType(id) {
  const s = String(id || '').toUpperCase();
  if (s.startsWith('RISK')) return 'risk';
  if (s.startsWith('AC-') && s.includes('/VC-')) return 'verification';
  if (s.startsWith('VC-') || s.startsWith('VER-') || s.includes('/VC-') || s.includes('/VER-')) return 'verification';
  if (s.startsWith('AC-')) return 'acceptance_criteria';
  if (s.startsWith('C-')) return 'constraint';
  if (s.startsWith('REQ-')) return 'requirement';
  return 'requirement';
}

function normalizeTraceType(type, id = '') {
  const raw = String(type || '').toLowerCase().replace(/[\s-]+/g, '_');
  if (['requirement', 'req', 'goal', 'functional'].includes(raw)) return 'requirement';
  if (['acceptance_criteria', 'acceptance', 'ac'].includes(raw)) return 'acceptance_criteria';
  if (['verification', 'verification_condition', 'vc', 'ver'].includes(raw)) return 'verification';
  if (['constraint', 'clarification', 'decision', 'c'].includes(raw)) return 'constraint';
  if (['risk', 'risk_mitigation', 'mitigation'].includes(raw)) return raw === 'mitigation' ? 'risk_mitigation' : raw;
  return inferTraceType(id);
}

function isRiskTrace(item) {
  const type = normalizeTraceType(item?.type, item?.id);
  return type === 'risk' || type === 'risk_mitigation';
}

function isRequirementTrace(item) {
  return !isRiskTrace(item);
}

function normalizeTraceabilityItem(item = {}, taskState = { tasks: {} }) {
  const id = item.id || item.requirement_id || item.req_id || '';
  const coveredBy = item.covered_by_tasks || item.tasks || [];
  const statuses = coveredBy.map(t => taskState.tasks?.[t]?.status || 'unknown');
  const allApproved = statuses.length > 0 && statuses.every(s => s === 'approved');
  const anyInProgress = statuses.some(s => ['coding', 'coded', 'reviewing', 'repairing'].includes(s));
  const coverage = allApproved ? 'complete' : anyInProgress ? 'in_progress' : coveredBy.length === 0 ? 'missing' : 'pending';
  return {
    ...item,
    id,
    type: normalizeTraceType(item.type, id),
    source: item.source || '',
    source_refs: item.source_refs || item.sources || [],
    description: item.description || item.requirement || item.goal || '',
    covered_by_tasks: coveredBy,
    cp_refs: item.cp_refs || item.change_point_refs || [],
    coverage_refs: item.coverage_refs || item.as_is_refs || [],
    task_statuses: statuses,
    coverage,
  };
}

function normalizeCoverageMatrixRefs(matrix = {}) {
  const dims = [
    ['entrypoints', 'E', '入口'],
    ['links', 'L', '链路'],
    ['data', 'D', '数据'],
    ['side_effects', 'S', '副作用'],
  ];
  const byId = {};
  const groups = {};
  for (const [key, prefix, label] of dims) {
    const items = Array.isArray(matrix?.[key]) ? matrix[key] : [];
    groups[key] = items.map(item => {
      const id = item.id || '';
      const normalized = { ...item, id, prefix, label, summary: summarizeCoverageItem(label, item) };
      if (id) byId[id] = normalized;
      return normalized;
    });
  }
  return { byId, groups };
}

function summarizeCoverageItem(label, item = {}) {
  if (label === '入口') {
    const name = item.name || item.entrypoint || item.path || item.description || item.id;
    return oneSentence(item.description || `${name} 是需求触发入口，影响请求进入后的主链路。`);
  }
  if (label === '链路') {
    const from = item.from || item.source || item.caller || '';
    const to = item.to || item.target || item.callee || '';
    return oneSentence(item.description || `${from}${from && to ? ' → ' : ''}${to} 是相关调用链路，影响上下游行为传递。`);
  }
  if (label === '数据') {
    const entity = item.entity || item.table || item.name || item.id;
    return oneSentence(item.description || `${entity} 是相关数据对象，影响字段、关系或持久化语义。`);
  }
  const name = item.name || item.kind || item.type || item.description || item.id;
  return oneSentence(item.description || `${name} 是相关副作用，影响外部调用、写入或异步行为。`);
}

function formatEvidence(evidence) {
  if (Array.isArray(evidence)) return evidence.map(formatEvidenceOne).filter(Boolean).join('; ');
  return formatEvidenceOne(evidence);
}

function formatEvidenceOne(e) {
  if (!e) return '';
  if (typeof e === 'string') return e;
  if (typeof e !== 'object') return String(e);
  const loc = [e.file || e.path || e.source || '', e.line_start ? `:${e.line_start}` : '', e.line_end ? `-${e.line_end}` : ''].join('');
  return loc || e.url || e.note || '';
}

function safeDomId(prefix, id) {
  const raw = String(id || 'unknown').trim() || 'unknown';
  const safe = raw.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'unknown';
  return `${prefix}-${safe}`;
}

function contextAttrs(context = {}) {
  const attrs = [];
  if (context.sourceType) attrs.push(`data-source-type="${escAttr(context.sourceType)}"`);
  if (context.sourceId) attrs.push(`data-source-id="${escAttr(context.sourceId)}"`);
  if (context.sourceLabel) attrs.push(`data-source-label="${escAttr(context.sourceLabel)}"`);
  if (context.returnTarget) attrs.push(`data-return-target="${escAttr(context.returnTarget)}"`);
  return attrs.length ? ' ' + attrs.join(' ') : '';
}

function renderTaskChip(taskId, taskDetails = {}, context = {}) {
  if (!taskId) return '';
  const exists = Boolean(taskDetails[taskId]);
  if (!exists) return `<span class="task-chip missing" title="未找到 task 详情">${escHtml(taskId)}</span>`;
  const sourceLabel = context.sourceLabel ? `，来源：${context.sourceLabel}` : '';
  return `<button type="button" class="task-chip" data-task-id="${escAttr(taskId)}" aria-label="查看 ${escAttr(taskId)} 详情${escAttr(sourceLabel)}"${contextAttrs(context)}>${escHtml(taskId)}</button>`;
}

function renderTaskChips(taskIds = [], taskDetails = {}, context = {}) {
  const ids = [...new Set(taskIds.filter(Boolean))];
  if (ids.length === 0) return '<span class="muted">—</span>';
  return ids.map(id => renderTaskChip(id, taskDetails, context)).join(' ');
}

function normalizeTraceabilityTree({ traceability, clarification, tasks, taskState }) {
  const items = (traceability?.items || []).map(i => normalizeTraceabilityItem(i, taskState));
  const existing = new Set(items.map(i => i.id));
  const acs = clarification?.acceptance_criteria || clarification?.acceptanceCriteria || [];
  for (const [idx, ac] of acs.entries()) {
    const acId = ac.id || `AC-${String(idx + 1).padStart(3, '0')}`;
    if (!existing.has(acId)) {
      items.push(normalizeTraceabilityItem({ id: acId, type: 'acceptance_criteria', source: 'requirement-clarification.json', description: ac.description || ac.title || String(ac), covered_by_tasks: [] }, taskState));
      existing.add(acId);
    }
    const vcs = ac.verification_conditions || ac.verifications || ac.conditions || [];
    for (const [vcIdx, vc] of vcs.entries()) {
      const vcId = vc.id || `VC-${String(vcIdx + 1).padStart(3, '0')}`;
      const fullId = `${acId}/${vcId}`;
      if (!existing.has(fullId) && !existing.has(vcId)) {
        items.push(normalizeTraceabilityItem({ id: fullId, type: 'verification', source: 'requirement-clarification.json', source_refs: [acId, vcId], description: vc.description || vc.condition || String(vc), covered_by_tasks: [] }, taskState));
        existing.add(fullId);
      }
    }
  }
  const requirementItems = items.filter(isRequirementTrace);
  const riskItems = items.filter(isRiskTrace);
  const covered = requirementItems.filter(i => i.coverage === 'complete').length;
  const total = requirementItems.length;
  const taskByTrace = new Map();
  for (const t of tasks || []) {
    for (const ref of t.trace_refs || []) {
      if (!taskByTrace.has(ref)) taskByTrace.set(ref, []);
      taskByTrace.get(ref).push(t.id);
    }
  }
  return { total, covered, percentage: total > 0 ? Math.round((covered / total) * 100) : 0, requirementItems, riskItems, taskByTrace };
}

function buildTraceabilityHierarchy(model) {
  const items = model?.requirementItems || [];
  const byId = new Map(items.map(item => [item.id, { item, children: [] }]));
  const attached = new Set();
  const roots = [];
  const ungrouped = [];

  const parentFromRefs = item => (item.source_refs || []).find(ref => ref !== item.id && byId.has(ref));
  const parentFromId = item => {
    const id = item.id || '';
    if (id.includes('/')) {
      const parent = id.split('/').slice(0, -1).join('/');
      if (byId.has(parent)) return parent;
    }
    if (item.type === 'verification') {
      const acPrefix = id.match(/(AC-\d+)/i)?.[1];
      if (acPrefix && byId.has(acPrefix)) return acPrefix;
    }
    return '';
  };

  for (const item of items) {
    const parentId = parentFromRefs(item) || parentFromId(item);
    if (parentId && byId.has(parentId) && parentId !== item.id) {
      byId.get(parentId).children.push(byId.get(item.id));
      attached.add(item.id);
    }
  }

  for (const item of items) {
    if (attached.has(item.id)) continue;
    const node = byId.get(item.id);
    if (item.type === 'requirement') roots.push(node);
    else ungrouped.push(node);
  }

  return { roots, ungrouped };
}

function countTasksByStatus(tasks = {}) {
  const entries = Object.values(tasks || {});
  const byStatus = entries.reduce((acc, t) => {
    const status = t.status || 'pending';
    acc[status] = (acc[status] || 0) + 1;
    return acc;
  }, {});
  const approved = byStatus.approved || 0;
  return { total: entries.length, approved, byStatus, percentage: entries.length ? Math.round((approved / entries.length) * 100) : 0 };
}

function countCrFindings(crResults = []) {
  const rework = crResults.reduce((sum, r) => sum + (r.reworkItems?.length || 0), 0);
  const observations = crResults.reduce((sum, r) => sum + (r.observations?.length || 0), 0);
  const highSeverity = crResults.reduce((sum, r) => sum + (r.reworkItems || []).filter(i => String(i['严重度'] || i.severity || '').toLowerCase().includes('high')).length, 0);
  const confidences = crResults.flatMap(r => (r.reworkItems || []).map(i => parseInt(i['置信度'] || i.confidence || '0', 10)).filter(n => n > 0));
  const avgConfidence = confidences.length ? Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length) : 0;
  return { rework, observations, highSeverity, avgConfidence };
}

function computeReportSummary({ tasks, traceabilityModel, crResults, impactRisk, currentIdx, workflowSteps }) {
  const taskStats = countTasksByStatus(tasks);
  const crStats = countCrFindings(crResults);
  const validCurrentIdx = currentIdx >= 0 ? currentIdx : 0;
  const workflowTotal = workflowSteps.length;
  const workflowDone = Math.min(validCurrentIdx + 1, workflowTotal);
  const workflowPercentage = workflowTotal ? Math.round((workflowDone / workflowTotal) * 100) : 0;
  const missingRequirements = (traceabilityModel?.requirementItems || []).filter(i => i.coverage === 'missing').length;
  return {
    taskStats,
    crStats,
    workflowDone,
    workflowTotal,
    workflowPercentage,
    requirementCoverage: traceabilityModel?.percentage || 0,
    missingRequirements,
    riskLevel: impactRisk?.summary?.risk_level || 'low',
  };
}

function normalizeChangePoints({ impactRisk, tasks, traceabilityModel, coverageRefs, implementationPlan }) {
  const byId = new Map();
  for (const cp of impactRisk?.change_points || []) {
    byId.set(cp.id, { ...cp, tasks: [], risk_items: [], coverage_refs: [], summary: oneSentence(cp.description || cp.node || cp.id), impact: oneSentence([...(cp.upstream_impact || []), ...(cp.downstream_impact || []), cp.risk_detail || ''].join('；')) });
  }
  const cpSection = extractCpSummariesFromPlan(implementationPlan);
  for (const [id, summary] of Object.entries(cpSection)) {
    if (!byId.has(id)) byId.set(id, { id, node: id, decision: '改造', tasks: [], risk_items: [], coverage_refs: [], summary, impact: '' });
    else byId.get(id).summary ||= summary;
  }
  for (const t of tasks || []) {
    for (const cpId of t.change_point_refs || []) {
      if (!byId.has(cpId)) byId.set(cpId, { id: cpId, node: cpId, decision: '改造', tasks: [], risk_items: [], coverage_refs: [], summary: oneSentence(t.goal || t.title || cpId), impact: '' });
      byId.get(cpId).tasks.push(t.id);
    }
  }
  for (const risk of impactRisk?.risk_matrix || []) {
    for (const cpId of risk.affected_cps || []) {
      if (!byId.has(cpId)) byId.set(cpId, { id: cpId, node: cpId, decision: '改造', tasks: [], risk_items: [], coverage_refs: [], summary: cpId, impact: '' });
      byId.get(cpId).risk_items.push(risk);
    }
  }
  for (const item of traceabilityModel?.requirementItems || []) {
    for (const cpId of item.cp_refs || []) {
      if (!byId.has(cpId)) continue;
      byId.get(cpId).coverage_refs.push(...(item.coverage_refs || []));
    }
  }
  return [...byId.values()].map(cp => ({ ...cp, tasks: [...new Set(cp.tasks)], coverage_refs: [...new Set(cp.coverage_refs)].map(id => coverageRefs.byId[id]).filter(Boolean) }));
}

function extractCpSummariesFromPlan(plan = '') {
  const out = {};
  const re = /#{3,4}\s+(CP-\d+)[:：]?([^\n]*)\n([\s\S]*?)(?=\n#{3,4}\s+CP-\d+|\n##\s|$)/g;
  let m;
  while ((m = re.exec(plan || ''))) out[m[1]] = oneSentence(m[2] || m[3] || m[1]);
  return out;
}

function normalizeDataChangePlan(jsonDoc, markdownText) {
  if (jsonDoc) return { kind: 'json', summary: jsonDoc.summary || {}, entities: jsonDoc.entities || [], migrations: jsonDoc.migrations || [] };
  if (markdownText) return { kind: 'markdown', markdown: markdownText, summary: {}, entities: [], migrations: [] };
  return null;
}

function normalizeApiChangePlan(jsonDoc, markdownText) {
  if (jsonDoc) return { kind: 'json', summary: jsonDoc.summary || {}, endpoints: jsonDoc.endpoints || [] };
  if (markdownText) return { kind: 'markdown', markdown: markdownText, summary: {}, endpoints: [] };
  return null;
}

function formatDuration(ms) {
  const totalSeconds = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
  return `${seconds}s`;
}

function parseTimeMs(value) {
  const ms = new Date(value || '').getTime();
  return Number.isFinite(ms) ? ms : null;
}

function normalizeStepTimings({ stepHistory = [], currentStep = '', startedAt = '', lastUpdated = '', now = new Date().toISOString() } = {}) {
  const nowMs = parseTimeMs(now) ?? Date.now();
  const collapsed = [];
  for (const h of stepHistory || []) {
    if (!h?.step || !h.entered_at) continue;
    const prev = collapsed[collapsed.length - 1];
    if (prev?.step === h.step) {
      if (!prev.exited_at && h.exited_at) prev.exited_at = h.exited_at;
      if (prev.duration_ms === undefined && h.duration_ms !== undefined) prev.duration_ms = h.duration_ms;
      continue;
    }
    collapsed.push({ ...h });
  }

  const steps = collapsed.map((h, index) => {
    const enteredMs = parseTimeMs(h.entered_at);
    const exitedMs = parseTimeMs(h.exited_at);
    const next = collapsed.slice(index + 1).find(item => item.step !== h.step && item.entered_at);
    const nextMs = parseTimeMs(next?.entered_at);
    const running = h.step === currentStep && currentStep !== 'done' && !h.exited_at && index === collapsed.length - 1;
    const durationMs = h.duration_ms !== undefined
      ? Number(h.duration_ms) || 0
      : enteredMs === null ? 0
        : Math.max(0, (exitedMs ?? nextMs ?? (running ? nowMs : parseTimeMs(lastUpdated) ?? nowMs)) - enteredMs);
    return {
      step: h.step,
      entered_at: h.entered_at,
      exited_at: h.exited_at || '',
      duration_ms: Math.max(0, durationMs),
      duration_label: formatDuration(durationMs),
      running
    };
  });

  const startedMs = parseTimeMs(startedAt);
  const totalEndMs = currentStep === 'done' ? (parseTimeMs(lastUpdated) ?? nowMs) : nowMs;
  const totalMs = startedMs !== null ? Math.max(0, totalEndMs - startedMs) : steps.reduce((sum, s) => sum + s.duration_ms, 0);
  const longestStep = steps.reduce((max, step) => step.duration_ms > (max?.duration_ms || 0) ? step : max, null);
  const current = steps.findLast?.(s => s.step === currentStep) || [...steps].reverse().find(s => s.step === currentStep) || null;
  return {
    total_ms: totalMs,
    total_label: formatDuration(totalMs),
    longest_step: longestStep,
    current_step: current,
    steps
  };
}

export { buildTraceabilityHierarchy, collectCrResults, collectTraceability, computeReportSummary, countCrFindings, countTasksByStatus, detectComplexity, formatDuration, formatEvidence, normalizeApiChangePlan, normalizeChangePoints, normalizeCoverageMatrixRefs, normalizeDataChangePlan, normalizeStepTimings, normalizeTaskItem, normalizeTasksJson, normalizeTraceabilityTree, oneSentence, parseTableSection, renderTaskChip, renderTaskChips, safeDomId };
