#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, basename, resolve } from 'node:path';
import { atomicWriteFile, readTaskState, taskStateFile, readFrontmatter } from './workflow-lib.mjs';

// --- Data collection ---

function readJson(ideaDir, rel) {
  const p = join(ideaDir, rel);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
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
  // parse phase section
  const phases = {};
  const phaseLines = text.split('\n').filter(l => /^  [a-z]+:/.test(l));
  for (const l of phaseLines) {
    const m = l.match(/^\s+([a-z]+):\s*(.+)$/);
    if (m) phases[m[1]] = m[2].trim();
  }
  result.phases = phases;
  // parse step_history
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
      } else if (/^[a-z]/.test(hl)) break;
    }
    if (entry.step) history.push(entry);
  }
  result.step_history = history;
  return result;
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

function mdToHtml(md) {
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

function scriptJson(value) {
  return JSON.stringify(value || {}).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
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
  if (['risk', 'risk_mitigation', 'mitigation'].includes(raw)) return raw;
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

function collectTaskDetails(ideaDir, taskState = { tasks: {} }) {
  const details = {};
  for (const [taskId, task] of Object.entries(taskState.tasks || {})) {
    const taskFile = task.file || `tasks/${taskId}.md`;
    const reportFile = task.report_file || `task-reports/${taskId}-report.md`;
    const crFile = task.cr_file || `cr/${taskId}-cr.md`;
    const taskMd = readMd(ideaDir, taskFile);
    const reportMd = readMd(ideaDir, reportFile);
    const crMd = readMd(ideaDir, crFile);
    details[taskId] = {
      id: taskId,
      status: task.status || 'pending',
      description: task.description || '',
      file: taskFile,
      report_file: reportFile,
      cr_file: crFile,
      task_html: taskMd ? mdToHtml(taskMd) : '<p style="color:var(--text2)">未找到 task markdown</p>',
      report_html: reportMd ? mdToHtml(reportMd) : '<p style="color:var(--text2)">暂无 task report</p>',
      cr_html: crMd ? mdToHtml(crMd) : '<p style="color:var(--text2)">暂无 task CR</p>',
    };
  }
  return details;
}

function renderTaskChip(taskId, taskDetails = {}) {
  if (!taskId) return '';
  const exists = Boolean(taskDetails[taskId]);
  if (!exists) return `<span class="task-chip missing" title="未找到 task 详情">${escHtml(taskId)}</span>`;
  return `<button type="button" class="task-chip" data-task-id="${escAttr(taskId)}">${escHtml(taskId)}</button>`;
}

function renderTaskChips(taskIds = [], taskDetails = {}) {
  const ids = [...new Set(taskIds.filter(Boolean))];
  if (ids.length === 0) return '<span style="color:var(--text2)">—</span>';
  return ids.map(id => renderTaskChip(id, taskDetails)).join(' ');
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

function traceTypeLabel(type) {
  return ({ requirement: 'REQ 需求', acceptance_criteria: 'AC 验收', verification: 'VC/VER 验证', constraint: 'C 约束', risk: 'RISK 风险', risk_mitigation: '风险缓解' })[type] || type;
}

function statusClassForCoverage(coverage) {
  return coverage === 'complete' ? 'approved' : coverage === 'missing' ? 'failed' : coverage === 'in_progress' ? 'coding' : 'pending';
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

function mermaidId(s) {
  const raw = String(s || 'entity').replace(/[^A-Za-z0-9_]/g, '_');
  return /^[A-Za-z_]/.test(raw) ? raw : `E_${raw}`;
}


function renderToBeSection({ implementationPlan, tasks, traceabilityModel, changePoints, dataChanges, apiChanges, taskDetails }) {
  if (!implementationPlan && tasks.length === 0 && changePoints.length === 0 && !dataChanges && !apiChanges) return '';
  return `<div class="card" style="margin-bottom:16px">
    <h2>To-Be 方案</h2>
    <div class="tabs" data-group="tobe">
      <button class="tab active" data-tab="tobe-overview">方案概览</button>
      <button class="tab" data-tab="tobe-chain">需求拆解链路</button>
      ${changePoints.length ? '<button class="tab" data-tab="tobe-cp">CP 改造点</button>' : ''}
      ${tasks.length ? '<button class="tab" data-tab="tobe-tasks">Task 拆分</button>' : ''}
      <button class="tab" data-tab="tobe-data">数据变更</button>
      <button class="tab" data-tab="tobe-api">API 契约</button>
      <button class="tab" data-tab="tobe-risk">风险与缓解</button>
      ${implementationPlan ? '<button class="tab" data-tab="tobe-raw">原始文档</button>' : ''}
    </div>
    <div class="tab-content active" id="tobe-overview">${renderPlanOverview(implementationPlan)}</div>
    <div class="tab-content" id="tobe-chain">${renderTraceabilityTree(traceabilityModel, taskDetails, { compact: false })}</div>
    ${changePoints.length ? `<div class="tab-content" id="tobe-cp">${renderChangePointPanel(changePoints, taskDetails)}</div>` : ''}
    ${tasks.length ? `<div class="tab-content" id="tobe-tasks">${renderTasksPanel(tasks, taskDetails)}</div>` : ''}
    <div class="tab-content" id="tobe-data">${renderDataChangePanel(dataChanges, taskDetails)}</div>
    <div class="tab-content" id="tobe-api">${renderApiChangePanel(apiChanges, taskDetails)}</div>
    <div class="tab-content" id="tobe-risk">${renderRiskCoverage(traceabilityModel, changePoints, taskDetails)}</div>
    ${implementationPlan ? `<div class="tab-content" id="tobe-raw">${mdToHtml(implementationPlan)}</div>` : ''}
  </div>`;
}

function renderPlanOverview(plan) {
  if (!plan) return '<p class="muted">无 implementation-plan.md</p>';
  const sections = ['目标行为', '非目标行为', '方案总览', '回滚方案'];
  let html = '';
  for (const sec of sections) {
    const m = plan.match(new RegExp('##\\s+' + sec + '[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)'));
    if (m) html += `<h3>${escHtml(sec)}</h3>${mdToHtml(m[1].trim())}`;
  }
  return html || mdToHtml(plan);
}

function renderTasksPanel(tasks, taskDetails) {
  return `<table><tr><th>ID</th><th>标题</th><th>CP Refs</th><th>风险</th><th>AC 数</th><th>Trace Refs</th></tr>
    ${tasks.map(t => `<tr>
      <td>${renderTaskChip(t.id, taskDetails)}</td>
      <td class="desc-cell">${escHtml(oneSentence(t.title || t.goal))}</td>
      <td>${renderRefChips(t.change_point_refs, 'cp')}</td>
      <td><span class="status s-${t.risk_level === 'high' ? 'fail' : t.risk_level === 'medium' ? 'coding' : 'approved'}">${escHtml(t.risk_level)}</span></td>
      <td>${(t.acceptance_criteria || []).length}</td>
      <td>${renderRefChips(t.trace_refs)}</td>
    </tr>`).join('')}
  </table>`;
}

function renderTraceabilitySection(model, taskDetails) {
  if (!model || model.total === 0 && model.riskItems.length === 0) return '';
  return `<div class="card" style="margin-bottom:16px">
    <h2>需求可追溯覆盖度 — ${model.percentage}%</h2>
    <p class="muted" style="font-size:.82rem;margin-bottom:10px">覆盖率只统计 REQ/AC/C/VC(VER) 等需求类项；RISK 单独展示为风险缓解链路，不计入需求覆盖。</p>
    <div class="progress-bar" style="height:12px;margin:8px 0">
      <div class="progress-fill ${model.percentage === 100 ? 'fill-success' : model.percentage >= 50 ? 'fill-warn' : 'fill-accent'}" style="width:${model.percentage}%"></div>
    </div>
    ${renderTraceabilityTree(model, taskDetails, { compact: true })}
  </div>`;
}

function renderTraceabilityTree(model, taskDetails, { compact } = {}) {
  if (!model || model.requirementItems.length === 0) return '<p class="muted">暂无需求追踪项</p>';
  return model.requirementItems.map(item => `<div class="trace-card">
    <div class="trace-head">
      <span class="trace-id">${escHtml(item.id)}</span>
      <span class="status s-${statusClassForCoverage(item.coverage)}">${escHtml(item.coverage)}</span>
      <span class="ref-chip">${escHtml(traceTypeLabel(item.type))}</span>
    </div>
    <div class="desc-cell">${escHtml(compact ? oneSentence(item.description || item.id) : (item.description || item.id))}</div>
    <div class="trace-chain">
      <div class="chain-node"><strong>来源</strong>${renderRefChips([item.source, ...(item.source_refs || [])].filter(Boolean))}</div>
      <div class="chain-node"><strong>CP 改造点</strong>${renderRefChips(item.cp_refs || [], 'cp')}</div>
      <div class="chain-node"><strong>E/L/D/S 影响面</strong>${renderRefChips(item.coverage_refs || [], 'coverage')}</div>
      <div class="chain-node"><strong>覆盖 Task</strong>${renderTaskChips(item.covered_by_tasks || [], taskDetails)}</div>
    </div>
  </div>`).join('');
}

function renderChangePointPanel(changePoints, taskDetails) {
  if (!changePoints.length) return '<p class="muted">暂无 CP 改造点</p>';
  return changePoints.map(cp => `<div class="trace-card">
    <div class="trace-head"><span class="trace-id">${escHtml(cp.id)}</span><span class="status s-${cp.decision === '删除' ? 'failed' : cp.decision === '新增' ? 'approved' : 'coding'}">${escHtml(cp.decision || '改造')}</span><span class="status s-${cp.risk_level === 'high' ? 'failed' : cp.risk_level === 'medium' ? 'needs_rework' : 'approved'}">${escHtml(cp.risk_level || 'low')}</span></div>
    <div class="trace-chain">
      <div class="chain-node"><strong>做什么</strong><div class="desc-cell">${escHtml(cp.summary || cp.node || cp.id)}</div></div>
      <div class="chain-node"><strong>影响</strong><div class="desc-cell">${escHtml(cp.impact || cp.risk_detail || '未声明影响')}</div></div>
      <div class="chain-node"><strong>Task</strong>${renderTaskChips(cp.tasks || [], taskDetails)}</div>
      <div class="chain-node"><strong>E/L/D/S</strong>${(cp.coverage_refs || []).length ? cp.coverage_refs.map(r => `<span class="ref-chip coverage" title="${escAttr(r.summary)}">${escHtml(r.id)} · ${escHtml(r.label)}</span>`).join('') : '<span class="muted">—</span>'}</div>
      <div class="chain-node"><strong>风险</strong>${(cp.risk_items || []).length ? cp.risk_items.map(r => `<span class="ref-chip" title="${escAttr(r.description || '')}">${escHtml(r.id || r.category)}</span>`).join('') : '<span class="muted">—</span>'}</div>
    </div>
  </div>`).join('');
}

function renderRiskCoverage(model, changePoints, taskDetails) {
  const risks = [...(model?.riskItems || [])];
  const cpRisks = changePoints.flatMap(cp => (cp.risk_items || []).map(r => ({ ...r, cp_id: cp.id, task_refs: cp.tasks || [] })));
  if (risks.length === 0 && cpRisks.length === 0) return '<p class="muted">暂无风险项。RISK 不作为需求统计项。</p>';
  return `<table><tr><th>风险</th><th>描述</th><th>关联 CP</th><th>缓解 Task</th><th>状态/级别</th></tr>
    ${risks.map(r => `<tr><td>${escHtml(r.id)}</td><td class="desc-cell">${escHtml(r.description)}</td><td>${renderRefChips(r.cp_refs || [], 'cp')}</td><td>${renderTaskChips(r.covered_by_tasks || [], taskDetails)}</td><td><span class="status s-${statusClassForCoverage(r.coverage)}">${escHtml(r.coverage)}</span></td></tr>`).join('')}
    ${cpRisks.map(r => `<tr><td>${escHtml(r.id || r.category)}</td><td class="desc-cell">${escHtml(r.description || r.mitigation || '')}</td><td>${renderRefChips([r.cp_id], 'cp')}</td><td>${renderTaskChips(r.task_refs || [], taskDetails)}</td><td><span class="status s-${r.severity === 'high' ? 'failed' : r.severity === 'medium' ? 'needs_rework' : 'approved'}">${escHtml(r.severity || r.likelihood || 'risk')}</span></td></tr>`).join('')}
  </table>`;
}

function renderRefChips(refs = [], cls = '') {
  const vals = [...new Set(refs.filter(Boolean))];
  if (vals.length === 0) return '<span class="muted">—</span>';
  return vals.map(r => `<span class="ref-chip ${cls}">${escHtml(r)}</span>`).join('');
}

function renderDataChangePanel(dataChanges, taskDetails) {
  if (!dataChanges) return '<p class="muted">未声明 DB 字段/表关系变更；如涉及 DB，请在 to-be/data-change-plan.json 中表达以生成 ER diff。</p>';
  if (dataChanges.kind === 'markdown') return `<p class="muted">当前仅发现 Markdown 计划；建议补充 to-be/data-change-plan.json 以启用结构化 ER diff。</p>${mdToHtml(dataChanges.markdown)}`;
  const changedFields = dataChanges.entities.flatMap(e => (e.fields || []).map(f => ({ ...f, entity: e.name || e.display_name || '' })));
  return `<div class="change-summary"><div><strong>${dataChanges.summary.change_count ?? changedFields.length}</strong><br><span class="muted">字段/实体变更</span></div><div><strong>${escHtml(dataChanges.summary.compatibility || 'unknown')}</strong><br><span class="muted">兼容性</span></div><div class="desc-cell">${escHtml(dataChanges.summary.notes || '')}</div></div>
    ${renderErChangeDiagram(dataChanges)}
    <h3>字段 diff</h3>
    <table><tr><th>实体</th><th>字段</th><th>变更</th><th>Before</th><th>After</th><th>影响</th><th>CP</th><th>Task</th></tr>
      ${changedFields.map(f => `<tr><td>${escHtml(f.entity)}</td><td>${escHtml(f.name)}</td><td><span class="status s-${f.change_type === 'delete' ? 'failed' : f.change_type === 'modify' ? 'coding' : 'approved'}">${escHtml(f.change_type)}</span></td><td><code>${escHtml(formatFieldSpec(f.before))}</code></td><td><code>${escHtml(formatFieldSpec(f.after))}</code></td><td class="desc-cell">${escHtml(f.impact || '')}</td><td>${renderRefChips(f.cp_refs || [], 'cp')}</td><td>${renderTaskChips(f.task_refs || [], taskDetails)}</td></tr>`).join('')}
    </table>`;
}

function renderErChangeDiagram(dataChanges) {
  const entities = dataChanges.entities || [];
  if (entities.length === 0) return '';
  let mermaid = 'erDiagram\n';
  for (const e of entities) {
    const eid = mermaidId(e.name || e.display_name);
    mermaid += `  ${eid} {\n`;
    const fields = e.fields && e.fields.length ? e.fields : [{ name: 'id', after: { type: 'unknown' }, change_type: e.change_type || 'unchanged' }];
    for (const f of fields) {
      const spec = f.after || f.before || {};
      const type = String(spec.type || 'unknown').replace(/[^A-Za-z0-9_]/g, '_');
      mermaid += `    ${type} ${mermaidId(f.name)} "${String(f.change_type || '').replace(/"/g, "'")}"\n`;
    }
    mermaid += '  }\n';
    for (const r of e.relations || []) {
      const to = mermaidId(r.to || r.target);
      if (to) mermaid += `  ${eid} ||--o{ ${to} : "${String(r.description || r.type || 'relates').replace(/"/g, "'")}"\n`;
    }
  }
  return `<pre class="mermaid">${escHtml(mermaid)}</pre>`;
}

function renderApiChangePanel(apiChanges, taskDetails) {
  if (!apiChanges) return '<p class="muted">未声明 API 出入参变更；如涉及 API，请在 to-be/api-change-plan.json 中表达以生成契约 diff。</p>';
  if (apiChanges.kind === 'markdown') return `<p class="muted">当前仅发现 Markdown 计划；建议补充 to-be/api-change-plan.json 以启用结构化 API 契约 diff。</p>${mdToHtml(apiChanges.markdown)}`;
  return `<div class="change-summary"><div><strong>${apiChanges.summary.change_count ?? apiChanges.endpoints.length}</strong><br><span class="muted">接口变更</span></div><div><strong>${escHtml(apiChanges.summary.compatibility || 'unknown')}</strong><br><span class="muted">兼容性</span></div><div class="desc-cell">${escHtml(apiChanges.summary.notes || '')}</div></div>
    <table><tr><th>接口</th><th>变更</th><th>描述</th><th>兼容性</th><th>CP</th><th>Task</th></tr>
    ${(apiChanges.endpoints || []).map(ep => `<tr><td><code>${escHtml([ep.method, ep.path].filter(Boolean).join(' '))}</code></td><td><span class="status s-${ep.change_type === 'delete' ? 'failed' : ep.change_type === 'modify' ? 'coding' : 'approved'}">${escHtml(ep.change_type)}</span></td><td class="desc-cell">${escHtml(ep.description || '')}</td><td>${escHtml(ep.compatibility || '')}</td><td>${renderRefChips(ep.cp_refs || [], 'cp')}</td><td>${renderTaskChips(ep.task_refs || [], taskDetails)}</td></tr>`).join('')}
    </table>
    ${(apiChanges.endpoints || []).map(ep => renderEndpointFields(ep, taskDetails)).join('')}`;
}

function renderEndpointFields(ep) {
  const reqFields = flattenApiFields(ep.request);
  const resFields = flattenApiFields(ep.response);
  const renderRows = (title, rows) => rows.length ? `<h3>${escHtml(title)} — ${escHtml([ep.method, ep.path].filter(Boolean).join(' '))}</h3><table><tr><th>位置</th><th>字段</th><th>变更</th><th>Before</th><th>After</th><th>影响</th></tr>${rows.map(f => `<tr><td>${escHtml(f.location)}</td><td><code>${escHtml(f.name)}</code></td><td><span class="status s-${f.change_type === 'delete' ? 'failed' : f.change_type === 'modify' ? 'coding' : 'approved'}">${escHtml(f.change_type)}</span></td><td><code>${escHtml(formatFieldSpec(f.before))}</code></td><td><code>${escHtml(formatFieldSpec(f.after))}</code></td><td class="desc-cell">${escHtml(f.impact || '')}</td></tr>`).join('')}</table>` : '';
  return renderRows('Request diff', reqFields) + renderRows('Response diff', resFields);
}

function flattenApiFields(section = {}) {
  const out = [];
  for (const key of ['params', 'query', 'headers', 'body', 'status_codes']) {
    for (const f of section?.[key] || []) out.push({ ...f, location: key });
  }
  return out;
}

function formatFieldSpec(spec) {
  if (!spec) return '—';
  if (typeof spec === 'string') return spec;
  return Object.entries(spec).map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : String(v)}`).join('; ');
}

// --- Utility functions (exported for testing) ---

function detectComplexity(ideaDir) {
  const req = readMd(ideaDir, 'requirement.md');
  if (!req) return 'standard';
  const m = req.match(/^##\s*复杂度[：:]\s*(trivial|standard|complex)\s*$/m);
  if (m) return m[1];
  return 'standard';
}

// --- Step Outputs ---

const STEP_OUTPUTS_MAP = {
  'receive-requirement': [{ label: '需求文档', file: 'requirement.md' }],
  'understand:explore': [
    { label: '概览', file: 'as-is/overview.md' },
    { label: '核心走查', file: 'as-is/core-walkthrough.md' },
    { label: '证据索引', file: 'as-is/evidence-index.md' },
    { label: '仓库地图', file: 'as-is/repo-map.json' },
    { label: '质量评分', file: 'as-is/quality-score.json' },
  ],
  'understand:confirm': [
    { label: '澄清记录', file: 'clarifications.json' },
    { label: 'As-Is 确认', file: 'confirmations/as-is.json' },
  ],
  'understand:generate-ai-input': [
    { label: 'AI 输入', file: 'as-is/ai-input/', isDir: true },
  ],
  'clarify:requirement': [
    { label: '需求澄清', file: 'requirement-clarification.json' },
  ],
  'quick-dev:init': [
    { label: 'Task 工作流', file: 'task-workflow-state.yaml' },
    { label: 'Worktree 决策', file: 'worktree-decision.json' },
    { label: '追溯矩阵', file: 'to-be/traceability-matrix.json' },
  ],
  'plan:design': [
    { label: '实现方案', file: 'to-be/implementation-plan.md' },
    { label: 'Tasks', file: 'to-be/tasks.json' },
    { label: '追溯矩阵', file: 'to-be/traceability-matrix.json' },
    { label: '影响风险', file: 'to-be/impact-risk-report.json' },
  ],
  'plan:confirm': [
    { label: 'To-Be 确认', file: 'confirmations/to-be.json' },
  ],
  'knowledge:extract': [
    { label: '知识候选', file: 'knowledge-candidates/', isDir: true },
    { label: '提取完成标记', file: '.knowledge-extracted' },
  ],
  'worktree:setup': [
    { label: 'Worktree 决策', file: 'worktree-decision.json' },
  ],
  'tasks:init': [
    { label: 'Task 工作流', file: 'task-workflow-state.yaml' },
  ],
  'implement:code': [
    { label: 'Task 报告', file: 'task-reports/', isDir: true },
  ],
  'review:cr': [
    { label: 'CR 结果', file: 'cr/', isDir: true },
  ],
  'review:cr-light': [
    { label: 'CR 结果', file: 'cr/', isDir: true },
  ],
  'repair:code': [
    { label: 'Task 报告', file: 'task-reports/', isDir: true },
  ],
  'final:summary': [
    { label: '最终摘要', file: 'final-summary.md' },
  ],
  'done': [],
};

function collectStepOutputs(ideaDir, steps, currentStep, stepHistory) {
  const visitedSteps = new Set((stepHistory || []).map(h => h.step));
  const toBeConf = readJson(ideaDir, 'confirmations/to-be.json');
  const knowledgeSkipped = toBeConf?.knowledge_extraction?.enabled === false;

  return steps.map(stepId => {
    if (stepId === 'knowledge:extract' && knowledgeSkipped) {
      return { step: stepId, status: 'skipped', outputs: [] };
    }
    const status = stepId === currentStep ? 'current'
                 : visitedSteps.has(stepId) ? 'done' : 'pending';
    const outputs = (STEP_OUTPUTS_MAP[stepId] || []).map(o => ({
      ...o,
      exists: existsSync(join(ideaDir, o.file))
    }));
    return { step: stepId, status, outputs };
  });
}

// --- Main execution ---

function main() {
const IDEA_DIR = process.argv[2];
if (!IDEA_DIR || !existsSync(IDEA_DIR)) {
  console.error('Usage: dashboard.mjs <idea-dir> [--no-open]');
  process.exit(1);
}

const workflowState = readWorkflowState(IDEA_DIR);
const taskState = readTaskState(taskStateFile(IDEA_DIR));
const crResults = collectCrResults(IDEA_DIR);
const traceability = collectTraceability(IDEA_DIR);
const impactRisk = readJson(IDEA_DIR, 'to-be/impact-risk-report.json');
const requirement = readMd(IDEA_DIR, 'requirement.md');
const overview = readMd(IDEA_DIR, 'as-is/overview.md');
const coreWalkthrough = readMd(IDEA_DIR, 'as-is/core-walkthrough.md');
const evidenceLedger = readJson(IDEA_DIR, 'as-is/evidence-ledger.json');
const qualityScore = readJson(IDEA_DIR, 'as-is/quality-score.json');
const coverageMatrix = readJson(IDEA_DIR, 'as-is/coverage-matrix.json');
const implementationPlan = readMd(IDEA_DIR, 'to-be/implementation-plan.md');
const tasksJson = readJson(IDEA_DIR, 'to-be/tasks.json');
const clarification = readJson(IDEA_DIR, 'requirement-clarification.json');
const dataChangePlanJson = readJson(IDEA_DIR, 'to-be/data-change-plan.json');
const dataChangePlanMd = readMd(IDEA_DIR, 'to-be/data-change-plan.md');
const apiChangePlanJson = readJson(IDEA_DIR, 'to-be/api-change-plan.json');
const apiChangePlanMd = readMd(IDEA_DIR, 'to-be/api-change-plan.md');
const normalizedTasks = normalizeTasksJson(tasksJson);
const taskDetails = collectTaskDetails(IDEA_DIR, taskState);
const coverageRefs = normalizeCoverageMatrixRefs(coverageMatrix || {});
const traceabilityTree = normalizeTraceabilityTree({ traceability, clarification, tasks: normalizedTasks, taskState });
const changePoints = normalizeChangePoints({ impactRisk, tasks: normalizedTasks, traceabilityModel: traceabilityTree, coverageRefs, implementationPlan });
const dataChanges = normalizeDataChangePlan(dataChangePlanJson, dataChangePlanMd);
const apiChanges = normalizeApiChangePlan(apiChangePlanJson, apiChangePlanMd);
const ideaName = basename(IDEA_DIR);
const complexity = detectComplexity(IDEA_DIR);

// --- Generate HTML ---

const DATA = {
  ideaName,
  complexity,
  currentStep: workflowState?.current_step || 'unknown',
  startedAt: workflowState?.started_at || '',
  lastUpdated: workflowState?.last_updated_at || '',
  phases: workflowState?.phases || {},
  stepHistory: workflowState?.step_history || [],
  tasks: taskState.tasks,
  normalizedTasks,
  taskDetails,
  crResults,
  traceability,
  traceabilityTree,
  changePoints,
  dataChanges,
  apiChanges,
};

const WORKFLOW_STEPS = complexity === 'trivial'
  ? ['receive-requirement', 'clarify:requirement', 'quick-dev:init', 'implement:code', 'review:cr-light', 'final:summary', 'done']
  : ['receive-requirement', 'understand:explore', 'understand:confirm', 'understand:generate-ai-input', 'clarify:requirement', 'plan:design', 'plan:confirm', 'knowledge:extract', 'worktree:setup', 'tasks:init', 'implement:code', 'review:cr', 'repair:code', 'final:summary', 'done'];

const currentIdx = WORKFLOW_STEPS.indexOf(DATA.currentStep);
const stepOutputs = collectStepOutputs(IDEA_DIR, WORKFLOW_STEPS, DATA.currentStep, DATA.stepHistory);

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Chisel Dashboard — ${escHtml(ideaName)}</title>
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"><\/script>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{--bg:#060a13;--bg2:#0b1120;--surface:#111827;--surface2:#1a2332;--surface-hover:#1f2b3d;--text:#e8ecf1;--text2:#7b8794;--accent:#3b82f6;--accent-dim:rgba(59,130,246,0.12);--success:#22c55e;--success-dim:rgba(34,197,94,0.12);--warn:#f59e0b;--warn-dim:rgba(245,158,11,0.12);--danger:#ef4444;--danger-dim:rgba(239,68,68,0.12);--purple:#a78bfa;--purple-dim:rgba(167,139,250,0.12);--border:rgba(255,255,255,0.06);--border-light:rgba(255,255,255,0.03);--radius:10px;--font-sans:'Inter',system-ui,-apple-system,sans-serif;--font-mono:'JetBrains Mono','Fira Code',monospace}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--font-sans);background:var(--bg);color:var(--text);line-height:1.6;padding:0;min-height:100vh}
body::before{content:'';position:fixed;top:0;left:0;right:0;height:2px;background:linear-gradient(90deg,var(--accent),#8b5cf6,#ec4899,var(--accent));background-size:200% 100%;animation:gradient-shift 4s linear infinite;z-index:100}
@keyframes gradient-shift{0%{background-position:0% 0}100%{background-position:200% 0}}
.container{max-width:1440px;margin:0 auto;padding:20px 24px 80px}

/* Header */
header{display:flex;align-items:center;gap:14px;margin-bottom:20px;flex-wrap:wrap;padding-top:6px}
header h1{font-size:1.25rem;font-weight:700;letter-spacing:-0.02em;display:flex;align-items:center;gap:10px}
.brand-mark{width:22px;height:22px;flex-shrink:0}
.header-meta{margin-left:auto;display:flex;align-items:center;gap:12px}
.live-dot{width:7px;height:7px;border-radius:50%;background:var(--success);box-shadow:0 0 6px var(--success);animation:pulse-dot 2s ease-in-out infinite}
@keyframes pulse-dot{0%,100%{opacity:1;box-shadow:0 0 6px var(--success)}50%{opacity:.5;box-shadow:0 0 2px var(--success)}}
.header-time{font-family:var(--font-mono);font-size:0.72rem;color:var(--text2)}

/* Badges */
.badge{padding:3px 10px;border-radius:100px;font-size:0.68rem;font-weight:600;text-transform:uppercase;letter-spacing:0.05em}
.badge-trivial{background:var(--success-dim);color:var(--success);border:1px solid rgba(34,197,94,0.2)}
.badge-standard{background:var(--accent-dim);color:var(--accent);border:1px solid rgba(59,130,246,0.2)}
.badge-complex{background:var(--purple-dim);color:var(--purple);border:1px solid rgba(167,139,250,0.2)}
.badge-step{background:var(--surface2);color:var(--text2);border:1px solid var(--border)}

/* Grid */
.grid{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:14px}
.grid-full{grid-column:1/-1}

/* Cards */
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:18px 20px;overflow:auto}
.card h2{font-size:0.7rem;font-weight:600;margin-bottom:14px;color:var(--text2);text-transform:uppercase;letter-spacing:0.08em}

/* Progress bars */
.progress-bar{height:6px;background:var(--surface2);border-radius:3px;overflow:hidden;margin:4px 0}
.progress-fill{height:100%;border-radius:3px;transition:width .3s}
.fill-success{background:linear-gradient(90deg,#16a34a,var(--success))}
.fill-warn{background:linear-gradient(90deg,#d97706,var(--warn))}
.fill-accent{background:linear-gradient(90deg,#2563eb,var(--accent))}

/* Tables */
table{width:100%;border-collapse:collapse;font-size:0.8rem}
th{padding:8px 12px;text-align:left;border-bottom:1px solid rgba(255,255,255,0.08);color:var(--text2);font-weight:500;font-size:0.68rem;text-transform:uppercase;letter-spacing:0.06em}
td{padding:8px 12px;text-align:left;border-bottom:1px solid var(--border-light)}
tr:hover td{background:var(--surface-hover)}

/* Status pills */
.status{display:inline-block;padding:2px 8px;border-radius:100px;font-size:0.68rem;font-weight:600;letter-spacing:0.02em}
.s-approved,.s-pass{background:var(--success-dim);color:var(--success);border:1px solid rgba(34,197,94,0.15)}
.s-coded,.s-coding{background:var(--accent-dim);color:var(--accent);border:1px solid rgba(59,130,246,0.15)}
.s-reviewing{background:var(--purple-dim);color:var(--purple);border:1px solid rgba(167,139,250,0.15)}
.s-needs_rework,.s-repairing{background:var(--warn-dim);color:var(--warn);border:1px solid rgba(245,158,11,0.15)}
.s-pending,.s-confirmed{background:rgba(255,255,255,0.04);color:var(--text2);border:1px solid var(--border)}
.s-blocked,.s-failed,.s-fail{background:var(--danger-dim);color:var(--danger);border:1px solid rgba(239,68,68,0.15)}

/* Tabs */
.tabs{display:inline-flex;gap:2px;margin-bottom:14px;background:rgba(255,255,255,0.03);border-radius:8px;padding:3px;border:1px solid var(--border)}
.tab{padding:5px 14px;border-radius:6px;cursor:pointer;font-size:0.75rem;font-weight:500;background:transparent;color:var(--text2);border:none;transition:all .15s;font-family:var(--font-sans)}
.tab:hover{color:var(--text);background:rgba(255,255,255,0.04)}
.tab.active{background:var(--accent-dim);color:var(--accent);font-weight:600}
.tab-content{display:none}
.tab-content.active{display:block}
.tab-content pre.mermaid{background:transparent;text-align:center}
.tab-content h1,.tab-content h2,.tab-content h3,.tab-content h4{margin:16px 0 8px;color:var(--text);text-transform:none;letter-spacing:normal}
.tab-content p{margin:4px 0}
.tab-content ul{margin:4px 0 4px 20px}
.tab-content li{margin:2px 0}
.tab-content code{background:var(--surface2);padding:2px 6px;border-radius:4px;font-size:0.82em;font-family:var(--font-mono)}
.tab-content pre>code{display:block;padding:12px;overflow-x:auto}
.tab-content table{margin:12px 0}
.tab-content a{color:var(--accent);text-decoration:none}
.tab-content a:hover{text-decoration:underline}

/* Workflow steps */
.workflow-steps{display:flex;gap:0;flex-wrap:wrap;align-items:center}
.wf-step{padding:4px 10px;border-radius:6px;font-size:0.66rem;font-family:var(--font-mono);font-weight:500;background:rgba(255,255,255,0.03);color:var(--text2);border:1px solid var(--border)}
.wf-step.done{background:var(--success-dim);color:var(--success);border-color:rgba(34,197,94,0.15)}
.wf-step.current{background:var(--accent-dim);color:var(--accent);border-color:rgba(59,130,246,0.3);font-weight:700;box-shadow:0 0 12px rgba(59,130,246,0.1)}
.wf-step.future{opacity:0.4}
.wf-connector{color:var(--text2);font-size:0.6rem;padding:0 4px;opacity:0.3}

/* Timeline */
.timeline{font-size:0.78rem}
.timeline-item{display:flex;gap:12px;padding:6px 0;margin-left:12px;padding-left:16px;position:relative;border-left:1px solid rgba(255,255,255,0.06)}
.timeline-item::before{content:'';position:absolute;left:-3px;top:12px;width:5px;height:5px;border-radius:50%;background:var(--accent);border:1px solid var(--bg)}
.timeline-item .time{color:var(--text2);min-width:140px;font-family:var(--font-mono);font-size:0.72rem}

/* Refresh indicator */
.refresh-indicator{position:fixed;bottom:16px;right:16px;background:var(--surface);border:1px solid var(--border);border-radius:100px;padding:6px 14px;font-size:0.68rem;font-family:var(--font-mono);color:var(--text2);display:flex;align-items:center;gap:8px;z-index:50;backdrop-filter:blur(8px);-webkit-backdrop-filter:blur(8px)}
.refresh-indicator .ri-bar{width:40px;height:3px;background:var(--surface2);border-radius:2px;overflow:hidden}
.refresh-indicator .ri-fill{height:100%;background:var(--accent);border-radius:2px;transition:width 1s linear}

canvas{max-height:260px}
@media(prefers-reduced-motion:reduce){body::before{animation:none}.live-dot{animation:none}}
@media(max-width:900px){.grid{grid-template-columns:1fr}.header-meta{margin-left:0;margin-top:4px}}
</style>
</head>
<body>
<div class="container">
<header>
  <h1><svg class="brand-mark" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>${escHtml(ideaName)}</h1>
  <span class="badge badge-${complexity}">${complexity}</span>
  <span class="badge badge-step">${escHtml(DATA.currentStep)}</span>
  <div class="header-meta">
    <span class="live-dot"></span>
    <span class="header-time">${DATA.lastUpdated ? escHtml(DATA.lastUpdated.slice(0, 16).replace('T', ' ')) : ''}</span>
  </div>
</header>

<!-- Workflow Progress -->
<div class="card grid-full" style="margin-bottom:16px">
  <h2>工作流进度</h2>
  <div class="workflow-steps">
    ${WORKFLOW_STEPS.map((s, i) => {
      const cls = i < currentIdx ? 'done' : i === currentIdx ? 'current' : 'future';
      return `<div class="wf-step ${cls}">${escHtml(s)}</div>`;
    }).join('<span class="wf-connector">&rarr;</span>')}
  </div>
</div>

<!-- Step Outputs -->
<div class="card grid-full" style="margin-bottom:16px">
  <h2>步骤产出详情</h2>
  <table>
    <tr><th>步骤</th><th>状态</th><th>产出文件</th></tr>
    ${stepOutputs.map(so => {
      const statusIcon = so.status === 'done' ? '<span style="color:var(--success)">&#x2713;</span>'
        : so.status === 'current' ? '<span style="color:var(--accent)">&#x25B6;</span>'
        : so.status === 'skipped' ? '<span style="color:var(--text2)">&#x2298;</span>'
        : '<span style="color:var(--text2)">&#x2015;</span>';
      const rowStyle = so.status === 'current' ? ' style="background:var(--accent-dim)"' : so.status === 'skipped' ? ' style="opacity:0.5"' : '';
      const outputsHtml = so.status === 'skipped' ? '<span style="color:var(--text2);font-size:0.75rem">已跳过</span>'
        : so.outputs.length === 0 ? ''
        : so.outputs.map(o => `<span style="font-size:0.75rem;margin-right:8px">${o.exists ? '<span style="color:var(--success)">&#x2713;</span>' : '<span style="color:var(--text2)">&mdash;</span>'} ${escHtml(o.label)}</span>`).join('');
      return `<tr${rowStyle}><td style="white-space:nowrap;font-size:0.8rem">${escHtml(so.step)}</td><td>${statusIcon}</td><td>${outputsHtml}</td></tr>`;
    }).join('')}
  </table>
</div>

<div class="grid">
<!-- Task Status -->
<div class="card">
  <h2>Task 状态矩阵</h2>
  <table>
    <tr><th>Task</th><th>状态</th><th>返修</th><th>描述</th></tr>
    ${Object.entries(DATA.tasks).map(([id, t]) => `
    <tr>
      <td>${renderTaskChip(id, taskDetails)}</td>
      <td><span class="status s-${t.status || 'pending'}">${escHtml(t.status || 'pending')}</span></td>
      <td>${t.rework_count || 0}</td>
      <td class="desc-cell muted">${escHtml(oneSentence(t.description || ''))}</td>
    </tr>`).join('')}
  </table>
</div>

<!-- CR Radar -->
<div class="card">
  <h2>CR 维度结果</h2>
  ${crResults.length > 0 ? `
  <canvas id="crRadar" style="max-height:240px"></canvas>
  ${(() => {
    const totalFindings = crResults.reduce((s, r) => s + (r.reworkItems?.length || 0), 0);
    const totalObs = crResults.reduce((s, r) => s + (r.observations?.length || 0), 0);
    const highSev = crResults.reduce((s, r) => s + (r.reworkItems || []).filter(i => (i['严重度'] || i.severity || '').toLowerCase().includes('high')).length, 0);
    const allConf = crResults.flatMap(r => (r.reworkItems || []).map(i => parseInt(i['置信度'] || i.confidence || '0', 10)).filter(n => n > 0));
    const avgConf = allConf.length > 0 ? Math.round(allConf.reduce((a, b) => a + b, 0) / allConf.length) : 0;
    return `<div style="display:flex;gap:12px;flex-wrap:wrap;margin:12px 0">
      <div style="background:var(--surface2);padding:8px 16px;border-radius:8px;text-align:center;flex:1;min-width:80px">
        <div style="font-size:1.3rem;font-weight:700;color:${totalFindings > 0 ? 'var(--danger)' : 'var(--success)'}">${totalFindings}</div>
        <div style="font-size:0.68rem;color:var(--text2)">Rework Items</div>
      </div>
      <div style="background:var(--surface2);padding:8px 16px;border-radius:8px;text-align:center;flex:1;min-width:80px">
        <div style="font-size:1.3rem;font-weight:700;color:${highSev > 0 ? 'var(--danger)' : 'var(--text)'}">${highSev}</div>
        <div style="font-size:0.68rem;color:var(--text2)">High 严重度</div>
      </div>
      <div style="background:var(--surface2);padding:8px 16px;border-radius:8px;text-align:center;flex:1;min-width:80px">
        <div style="font-size:1.3rem;font-weight:700">${avgConf || '—'}</div>
        <div style="font-size:0.68rem;color:var(--text2)">平均置信度</div>
      </div>
      <div style="background:var(--surface2);padding:8px 16px;border-radius:8px;text-align:center;flex:1;min-width:80px">
        <div style="font-size:1.3rem;font-weight:700;color:var(--text2)">${totalObs}</div>
        <div style="font-size:0.68rem;color:var(--text2)">Observations</div>
      </div>
    </div>`;
  })()}
  <div class="tabs" data-group="cr-detail">
    <button class="tab active" data-tab="cr-summary">总览</button>
    <button class="tab" data-tab="cr-rework">Rework Items</button>
    <button class="tab" data-tab="cr-obs">Observations</button>
  </div>
  <div class="tab-content active" id="cr-summary">
    <table>
      <tr><th>维度</th><th>结果</th><th>Rework</th><th>Obs</th></tr>
      ${crResults.map(r => `<tr><td>${escHtml(r.dimension)}</td><td><span class="status s-${r.result}">${escHtml(r.result)}</span></td><td>${r.reworkItems?.length || 0}</td><td>${r.observations?.length || 0}</td></tr>`).join('')}
    </table>
  </div>
  <div class="tab-content" id="cr-rework">
    ${(() => {
      const allRework = crResults.flatMap(r => (r.reworkItems || []).map(i => ({ ...i, dim: r.dimension })));
      if (allRework.length === 0) return '<p style="color:var(--text2)">无 Rework Items</p>';
      return `<table><tr><th>ID</th><th>维度</th><th>问题</th><th>严重度</th><th>置信度</th><th>Task</th></tr>
        ${allRework.map(i => `<tr><td style="font-family:var(--font-mono);font-size:0.75rem">${escHtml(i.id || i.ID || '')}</td><td>${escHtml(i.dim)}</td><td style="font-size:0.8rem;max-width:300px">${escHtml(oneSentence(i['问题描述'] || i.description || ''))}</td><td><span class="status s-${(i['严重度'] || i.severity || '') === 'high' ? 'fail' : 'coding'}">${escHtml(i['严重度'] || i.severity || '')}</span></td><td>${escHtml(i['置信度'] || i.confidence || '')}</td><td style="font-family:var(--font-mono);font-size:0.75rem">${renderTaskChips([i.affected_task_id || i['affected_task_id'] || ''], taskDetails)}</td></tr>`).join('')}
      </table>`;
    })()}
  </div>
  <div class="tab-content" id="cr-obs">
    ${(() => {
      const allObs = crResults.flatMap(r => (r.observations || []).map(i => ({ ...i, dim: r.dimension })));
      if (allObs.length === 0) return '<p style="color:var(--text2)">无 Observations</p>';
      return `<table><tr><th>ID</th><th>维度</th><th>描述</th><th>置信度</th><th>Task</th></tr>
        ${allObs.map(i => `<tr><td style="font-family:var(--font-mono);font-size:0.75rem">${escHtml(i.id || i.ID || '')}</td><td>${escHtml(i.dim)}</td><td style="font-size:0.8rem;max-width:400px">${escHtml(oneSentence(i['描述'] || i.description || ''))}</td><td>${escHtml(i['置信度'] || i.confidence || '')}</td><td style="font-family:var(--font-mono);font-size:0.75rem">${renderTaskChips([i.affected_task_id || i['affected_task_id'] || ''], taskDetails)}</td></tr>`).join('')}
      </table>`;
    })()}
  </div>` : '<p style="color:var(--text2)">暂无 CR 结果</p>'}
</div>
</div>

<!-- To-Be 方案视图 -->
${renderToBeSection({ implementationPlan, tasks: normalizedTasks, traceabilityModel: traceabilityTree, changePoints, dataChanges, apiChanges, taskDetails })}

<!-- Traceability -->
${renderTraceabilitySection(traceabilityTree, taskDetails)}

<!-- Impact & Risk -->
${impactRisk ? `
<div class="card" style="margin-bottom:16px">
  <h2>影响范围与风险评估</h2>
  <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:16px">
    <div style="background:var(--surface2);padding:12px 20px;border-radius:8px;text-align:center">
      <div style="font-size:1.5rem;font-weight:700">${impactRisk.summary?.total_change_points || 0}</div>
      <div style="font-size:0.75rem;color:var(--text2)">改造点</div>
    </div>
    <div style="background:var(--surface2);padding:12px 20px;border-radius:8px;text-align:center">
      <div style="font-size:1.5rem;font-weight:700">${impactRisk.summary?.total_affected_files || 0}</div>
      <div style="font-size:0.75rem;color:var(--text2)">影响文件</div>
    </div>
    <div style="background:var(--surface2);padding:12px 20px;border-radius:8px;text-align:center">
      <div style="font-size:1.5rem;font-weight:700">${impactRisk.summary?.total_affected_symbols || 0}</div>
      <div style="font-size:0.75rem;color:var(--text2)">影响符号</div>
    </div>
    <div style="background:var(--surface2);padding:12px 20px;border-radius:8px;text-align:center">
      <span class="badge badge-${impactRisk.summary?.risk_level === 'high' ? 'complex' : impactRisk.summary?.risk_level === 'medium' ? 'standard' : 'trivial'}" style="font-size:0.9rem">${escHtml(impactRisk.summary?.risk_level || 'low')}</span>
      <div style="font-size:0.75rem;color:var(--text2);margin-top:4px">总风险</div>
    </div>
  </div>
  ${impactRisk.summary?.highest_risk ? `<p style="color:var(--warn);font-size:0.85rem;margin-bottom:12px">⚠ ${escHtml(impactRisk.summary.highest_risk)}</p>` : ''}
  <div class="tabs" id="riskTabs">
    <button class="tab active" data-tab="risk-flow">全链路图</button>
    <button class="tab" data-tab="risk-cps">改造点</button>
    <button class="tab" data-tab="risk-matrix">风险矩阵</button>
    <button class="tab" data-tab="risk-reuse">复用节点</button>
  </div>
  <div class="tab-content active" id="risk-flow">
    ${impactRisk.flow_graph ? renderFlowGraph(impactRisk.flow_graph) : '<p style="color:var(--text2)">暂无全链路图数据（需 planner 产出 flow_graph）</p>'}
  </div>
  <div class="tab-content" id="risk-cps">
    <table>
      <tr><th>ID</th><th>节点</th><th>决策</th><th>影响文件</th><th>风险</th></tr>
      ${(impactRisk.change_points || []).map(cp => `
      <tr>
        <td><strong>${escHtml(cp.id)}</strong></td>
        <td>${escHtml(cp.node)}</td>
        <td><span class="status s-${cp.decision === '改造' ? 'coding' : cp.decision === '新增' ? 'approved' : 'failed'}">${escHtml(cp.decision)}</span></td>
        <td style="font-size:0.8rem">${escHtml((cp.affected_files || []).join(', '))}</td>
        <td><span class="status s-${cp.risk_level === 'high' ? 'failed' : cp.risk_level === 'medium' ? 'needs_rework' : 'approved'}">${escHtml(cp.risk_level || 'low')}</span></td>
      </tr>`).join('')}
    </table>
  </div>
  <div class="tab-content" id="risk-matrix">
    <table>
      <tr><th>ID</th><th>类别</th><th>描述</th><th>严重度</th><th>可能性</th><th>关联 CP</th><th>缓解</th></tr>
      ${(impactRisk.risk_matrix || []).map(r => `
      <tr>
        <td>${escHtml(r.id)}</td>
        <td>${escHtml(r.category)}</td>
        <td style="font-size:0.85rem">${escHtml(r.description)}</td>
        <td><span class="status s-${r.severity === 'high' ? 'failed' : r.severity === 'medium' ? 'needs_rework' : 'approved'}">${escHtml(r.severity)}</span></td>
        <td>${escHtml(r.likelihood)}</td>
        <td style="font-size:0.8rem">${escHtml((r.affected_cps || []).join(', '))}</td>
        <td style="font-size:0.8rem">${escHtml(r.mitigation)}</td>
      </tr>`).join('')}
    </table>
  </div>
  <div class="tab-content" id="risk-reuse">
    <table>
      <tr><th>节点</th><th>保留原因</th><th>置信度</th></tr>
      ${(impactRisk.reuse_nodes || []).map(n => `
      <tr>
        <td>${escHtml(n.node)}</td>
        <td style="font-size:0.85rem">${escHtml(n.reason)}</td>
        <td><span class="status s-${n.confidence === 'high' ? 'approved' : n.confidence === 'medium' ? 'coding' : 'pending'}">${escHtml(n.confidence)}</span></td>
      </tr>`).join('')}
    </table>
  </div>
</div>` : ''}

<!-- As-Is Viewer -->
${(overview || coreWalkthrough || evidenceLedger || qualityScore || coverageMatrix) ? `
<div class="card" style="margin-bottom:16px">
  <h2>As-Is 查看器</h2>
  <div class="tabs" id="asIsTabs">
    ${overview ? '<button class="tab active" data-tab="as-overview">概览</button>' : ''}
    ${coreWalkthrough ? '<button class="tab" data-tab="as-walkthrough">核心走查</button>' : ''}
    ${evidenceLedger ? '<button class="tab" data-tab="as-evidence">证据</button>' : ''}
    ${qualityScore ? '<button class="tab" data-tab="as-quality">质量评分</button>' : ''}
    ${coverageMatrix ? '<button class="tab" data-tab="as-coverage">覆盖矩阵</button>' : ''}
  </div>
  ${overview ? `<div class="tab-content active" id="as-overview">${mdToHtml(overview)}</div>` : ''}
  ${coreWalkthrough ? `<div class="tab-content" id="as-walkthrough">${mdToHtml(coreWalkthrough)}</div>` : ''}
  ${evidenceLedger ? `<div class="tab-content" id="as-evidence">${renderEvidenceTable(evidenceLedger)}</div>` : ''}
  ${qualityScore ? `<div class="tab-content" id="as-quality"><canvas id="qualityRadar" style="max-height:300px"></canvas>${renderQualityDetails(qualityScore)}</div>` : ''}
  ${coverageMatrix ? `<div class="tab-content" id="as-coverage">${renderCoverageMatrix(coverageMatrix)}</div>` : ''}
</div>` : ''}

<!-- Timeline -->
${DATA.stepHistory.length > 0 ? `
<div class="card" style="margin-bottom:16px">
  <h2>时间线</h2>
  <div class="timeline">
    ${DATA.stepHistory.map(h => `
    <div class="timeline-item">
      <span class="time">${escHtml((h.entered_at || '').slice(0, 16).replace('T', ' '))}</span>
      <span>${escHtml(h.step)}</span>
    </div>`).join('')}
  </div>
</div>` : ''}



<div class="modal-backdrop" id="taskModalBackdrop" role="presentation">
  <div class="modal" role="dialog" aria-modal="true" aria-labelledby="taskModalTitle">
    <div class="modal-header">
      <div>
        <div class="modal-title" id="taskModalTitle">Task</div>
        <div class="muted" id="taskModalMeta" style="font-size:.78rem"></div>
      </div>
      <button type="button" class="modal-close" id="taskModalClose">关闭</button>
    </div>
    <div class="modal-body">
      <div class="tabs" id="taskModalTabs">
        <button class="tab active" data-tab="task-modal-task">Task</button>
        <button class="tab" data-tab="task-modal-report">Report</button>
        <button class="tab" data-tab="task-modal-cr">CR</button>
      </div>
      <div class="tab-content active" id="task-modal-task"></div>
      <div class="tab-content" id="task-modal-report"></div>
      <div class="tab-content" id="task-modal-cr"></div>
    </div>
  </div>
</div>

<div class="refresh-indicator" id="refreshIndicator">
  <div class="ri-bar"><div class="ri-fill" id="riFill"></div></div>
  <span id="riText">30s</span>
</div>

</div><!-- container -->

<script>
mermaid.initialize({startOnLoad:true,theme:'dark',themeVariables:{darkMode:true,background:'#111827',primaryColor:'#3b82f6',primaryTextColor:'#e8ecf1',lineColor:'#475569',secondaryColor:'#1a2332',tertiaryColor:'#1a2332'}});

// --- Tab state persistence + switching ---
const TAB_STORAGE_KEY='chisel-dash-tab-state';
function saveTabState(){
  const state={};
  document.querySelectorAll('.tabs').forEach((tg,i)=>{
    const active=tg.querySelector('.tab.active');
    if(active)state['g'+i]=active.dataset.tab;
  });
  try{localStorage.setItem(TAB_STORAGE_KEY,JSON.stringify(state));}catch{}
}
function restoreTabState(){
  let state;
  try{state=JSON.parse(localStorage.getItem(TAB_STORAGE_KEY));}catch{}
  if(!state)return;
  document.querySelectorAll('.tabs').forEach((tg,i)=>{
    const savedTab=state['g'+i];
    if(!savedTab)return;
    const btn=tg.querySelector('.tab[data-tab="'+savedTab+'"]');
    if(!btn)return;
    tg.querySelectorAll('.tab').forEach(b=>b.classList.remove('active'));
    btn.classList.add('active');
    const card=tg.closest('.card')||tg.parentElement;
    card.querySelectorAll('.tab-content').forEach(c=>c.classList.remove('active'));
    const target=card.querySelector('#'+savedTab);
    if(target)target.classList.add('active');
  });
}

document.querySelectorAll('.tabs').forEach(tabGroup=>{
  tabGroup.querySelectorAll('.tab').forEach(btn=>{
    btn.addEventListener('click',()=>{
      tabGroup.querySelectorAll('.tab').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      const card=tabGroup.closest('.card')||tabGroup.parentElement;
      card.querySelectorAll('.tab-content').forEach(c=>c.classList.remove('active'));
      const target=card.querySelector('#'+btn.dataset.tab);
      if(target)target.classList.add('active');
      saveTabState();
    });
  });
});

restoreTabState();


// --- Task detail modal ---
const TASK_DETAILS=${scriptJson(taskDetails)};
const taskBackdrop=document.getElementById('taskModalBackdrop');
const taskClose=document.getElementById('taskModalClose');
function setModalTab(tabId){
  const group=document.getElementById('taskModalTabs');
  if(!group)return;
  group.querySelectorAll('.tab').forEach(b=>b.classList.toggle('active',b.dataset.tab===tabId));
  ['task-modal-task','task-modal-report','task-modal-cr'].forEach(id=>{
    const el=document.getElementById(id);
    if(el)el.classList.toggle('active',id===tabId);
  });
}
function openTaskModal(taskId){
  const detail=TASK_DETAILS[taskId];
  if(!detail||!taskBackdrop)return;
  document.getElementById('taskModalTitle').textContent=taskId;
  document.getElementById('taskModalMeta').textContent=(detail.status||'')+' · '+(detail.file||'');
  document.getElementById('task-modal-task').innerHTML=detail.task_html||'';
  document.getElementById('task-modal-report').innerHTML=detail.report_html||'';
  document.getElementById('task-modal-cr').innerHTML=detail.cr_html||'';
  setModalTab('task-modal-task');
  taskBackdrop.classList.add('open');
  taskClose?.focus();
  try{mermaid.run({nodes:taskBackdrop.querySelectorAll('.mermaid')});}catch{}
}
function closeTaskModal(){taskBackdrop?.classList.remove('open');}
document.querySelectorAll('.task-chip[data-task-id]').forEach(btn=>btn.addEventListener('click',()=>openTaskModal(btn.dataset.taskId)));
taskClose?.addEventListener('click',closeTaskModal);
taskBackdrop?.addEventListener('click',e=>{if(e.target===taskBackdrop)closeTaskModal();});
document.addEventListener('keydown',e=>{if(e.key==='Escape')closeTaskModal();});
document.getElementById('taskModalTabs')?.querySelectorAll('.tab').forEach(btn=>btn.addEventListener('click',()=>setModalTab(btn.dataset.tab)));

// --- Scroll position persistence ---
try{
  const savedScroll=sessionStorage.getItem('chisel-dash-scroll');
  if(savedScroll)requestAnimationFrame(()=>window.scrollTo(0,parseInt(savedScroll,10)));
}catch{}
window.addEventListener('beforeunload',()=>{
  try{sessionStorage.setItem('chisel-dash-scroll',String(window.scrollY));}catch{}
  saveTabState();
});

// --- Refresh countdown ---
(function(){
  const INTERVAL=30;
  let remaining=INTERVAL;
  const fill=document.getElementById('riFill');
  const text=document.getElementById('riText');
  setInterval(()=>{
    remaining--;
    if(remaining<=0){location.reload();return;}
    const pct=((INTERVAL-remaining)/INTERVAL)*100;
    if(fill)fill.style.width=pct+'%';
    if(text)text.textContent=remaining+'s';
  },1000);
})();

// CR Radar Chart
${crResults.length > 0 ? `
(function(){
  const dims=${JSON.stringify(crResults.map(r => r.dimension))};
  const scores=${JSON.stringify(crResults.map(r => { const n = (r.reworkItems?.length || 0); return n === 0 ? 1.0 : n === 1 ? 0.7 : n === 2 ? 0.4 : 0.1; }))};
  const ctx=document.getElementById('crRadar');
  if(ctx){new Chart(ctx,{type:'radar',data:{labels:dims,datasets:[{label:'CR',data:scores,backgroundColor:'rgba(59,130,246,0.15)',borderColor:'#3b82f6',pointBackgroundColor:'#3b82f6',borderWidth:1.5}]},options:{scales:{r:{min:0,max:1,ticks:{stepSize:1,display:false},grid:{color:'rgba(255,255,255,0.06)'},pointLabels:{color:'#e8ecf1',font:{size:11,family:'Inter'}}}},plugins:{legend:{display:false}}}});}
})();` : ''}

// Quality Radar Chart
${qualityScore ? `
(function(){
  const qs=${JSON.stringify(qualityScore)};
  const dims=Object.keys(qs.dimensions||qs.scores||{});
  const scores=Object.values(qs.dimensions||qs.scores||{}).map(v=>typeof v==='number'?v:(v?.score||0));
  const ctx=document.getElementById('qualityRadar');
  if(ctx&&dims.length>0){new Chart(ctx,{type:'radar',data:{labels:dims,datasets:[{label:'质量',data:scores,backgroundColor:'rgba(34,197,94,0.15)',borderColor:'#22c55e',pointBackgroundColor:'#22c55e',borderWidth:1.5}]},options:{scales:{r:{min:0,max:1,ticks:{stepSize:0.2,color:'#7b8794',backdropColor:'transparent'},grid:{color:'rgba(255,255,255,0.06)'},pointLabels:{color:'#e8ecf1',font:{size:11,family:'Inter'}}}},plugins:{legend:{display:false}}}});}
})();` : ''}
<\/script>
</body>
</html>`;

function renderEvidenceTable(ledger) {
  const items = Array.isArray(ledger) ? ledger : (ledger.facts || ledger.items || []);
  if (items.length === 0) return '<p style="color:var(--text2)">无证据记录</p>';
  return `<table>
    <tr><th>ID</th><th>声明</th><th>状态</th><th>来源</th></tr>
    ${items.map(e => `<tr>
      <td>${escHtml(e.id || '')}</td>
      <td class="desc-cell">${escHtml(oneSentence(e.claim || e.description || ''))}</td>
      <td><span class="status s-${(e.status || 'pending') === 'confirmed' ? 'approved' : 'pending'}">${escHtml(e.status || 'pending')}</span></td>
      <td class="desc-cell muted">${escHtml(formatEvidence(e.source || e.evidence || ''))}</td>
    </tr>`).join('')}
  </table>`;
}

function renderQualityDetails(qs) {
  const dims = qs.dimensions || qs.scores || {};
  const weakItems = Object.entries(dims).filter(([, v]) => (typeof v === 'number' ? v : v?.score || 0) < 0.6);
  if (weakItems.length === 0) return '<p style="margin-top:12px;color:var(--success)">所有维度评分良好</p>';
  return `<div style="margin-top:12px"><strong style="color:var(--warn)">弱项：</strong><ul>${weakItems.map(([k, v]) => {
    const raw = typeof v === 'number' ? v : v?.score || 0;
    return '<li>' + escHtml(k) + ': ' + (raw * 100).toFixed(0) + '%</li>';
  }).join('')}</ul></div>`;
}

function renderFlowGraph(flowGraph) {
  if (!flowGraph || !flowGraph.nodes || flowGraph.nodes.length === 0) return '';
  const DECISION_COLORS = { '保留': '#4b5563', '改造': '#2563eb', '新增': '#16a34a', '删除': '#dc2626' };
  const DECISION_LABELS = { '保留': 'Keep', '改造': 'Modify', '新增': 'Add', '删除': 'Remove' };
  let mermaid = 'flowchart TD\n';
  for (const n of flowGraph.nodes) {
    const safeLabel = String(n.label || n.id).replace(/"/g, "'");
    const cpTag = n.cp_ref && n.cp_ref !== 'null' ? ` [${n.cp_ref}]` : '';
    mermaid += `  ${n.id}["${safeLabel}${cpTag}"]\n`;
  }
  for (const e of (flowGraph.edges || [])) {
    const label = e.label ? `-- "${String(e.label).replace(/"/g, "'")}" -->` : '-->';
    mermaid += `  ${e.from} ${label} ${e.to}\n`;
  }
  for (const n of flowGraph.nodes) {
    const color = DECISION_COLORS[n.decision] || '#4b5563';
    const textColor = n.decision === '保留' ? '#9ca3af' : '#ffffff';
    mermaid += `  style ${n.id} fill:${color},stroke:${color},color:${textColor}\n`;
  }
  const legendHtml = Object.entries(DECISION_COLORS).map(([k, c]) =>
    `<span style="display:inline-flex;align-items:center;gap:5px;margin-right:16px"><span style="width:12px;height:12px;border-radius:3px;background:${c};display:inline-block"></span><span style="font-size:0.78rem;color:var(--text2)">${k} (${DECISION_LABELS[k]})</span></span>`
  ).join('');
  return `<div style="margin-bottom:10px">${legendHtml}</div><pre class="mermaid">${escHtml(mermaid)}</pre>`;
}

function renderCoverageMatrix(matrix) {
  if (!matrix) return '';
  const structuredKeys = ['entrypoints', 'links', 'data', 'side_effects'];
  if (structuredKeys.some(k => Array.isArray(matrix[k]))) {
    const refs = normalizeCoverageMatrixRefs(matrix);
    return Object.entries(refs.groups).map(([key, items]) => {
      const title = ({ entrypoints: '入口 E', links: '链路 L', data: '数据 D', side_effects: '副作用 S' })[key];
      return `<h3>${title}</h3>${items.length ? `<table><tr><th>ID</th><th>一句话说明</th><th>证据</th></tr>${items.map(i => `<tr><td><span class="ref-chip coverage">${escHtml(i.id)}</span></td><td class="desc-cell">${escHtml(i.summary)}</td><td class="desc-cell muted">${escHtml(formatEvidence(i.evidence || i.source || i.covered_by_facts || ''))}</td></tr>`).join('')}</table>` : '<p class="muted">未适用或无条目</p>'}`;
    }).join('');
  }
  if (matrix.rows && matrix.columns && matrix.cells) {
    return `<table>
      <tr><th></th>${matrix.columns.map(c => `<th style="font-size:0.75rem;writing-mode:vertical-lr">${escHtml(oneSentence(c))}</th>`).join('')}</tr>
      ${matrix.rows.map((r, ri) => `<tr><td class="desc-cell">${escHtml(oneSentence(r))}</td>${(matrix.cells[ri] || []).map(cell => {
        const val = typeof cell === 'number' ? cell : (cell ? 1 : 0);
        const bg = val > 0 ? 'background:rgba(34,197,94,0.3)' : '';
        return `<td style="text-align:center;${bg}">${val > 0 ? '✓' : '·'}</td>`;
      }).join('')}</tr>`).join('')}
    </table>`;
  }
  return `<pre><code>${escHtml(JSON.stringify(matrix, null, 2))}</code></pre>`;
}

// --- Write output ---

const outPath = join(IDEA_DIR, 'dashboard.html');
atomicWriteFile(outPath, html);

// Auto-open in browser
const absPath = resolve(outPath);
const noOpen = process.argv.includes('--no-open');
if (!noOpen) {
  try {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    execSync(`${cmd} "${absPath}"`, { stdio: 'ignore' });
  } catch { /* ignore open failure */ }
}

console.log(JSON.stringify({ generated: true, path: absPath }));
} // end main

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { collectCrResults, collectTraceability, detectComplexity, parseTableSection, normalizeTaskItem, normalizeTasksJson, normalizeTraceabilityTree, normalizeCoverageMatrixRefs, normalizeDataChangePlan, normalizeApiChangePlan, oneSentence, formatEvidence };
