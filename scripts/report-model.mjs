#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, basename, resolve } from 'node:path';
import { atomicWriteFile, readTaskState, taskStateFile, readFrontmatter, detectComplexity } from './workflow-lib.mjs';
import { WORKFLOW_PATHS } from './workflow-definition.mjs';
import { generateReport as generateCrReport } from './cr-report.mjs';

// Shared report data model. No HTML page or workflow side effects live here.

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

function generateStatusSentence(currentStep, taskStats, crStats) {
  const STEP_LABELS = {
    'receive-requirement': '正在接收需求',
    'understand:explore': '正在探索 AS-IS 现状',
    'understand:confirm': '等待用户确认 AS-IS 理解',
    'clarify:requirement': '正在澄清需求细节',
    'quick-dev:init': '正在初始化快速开发',
    'plan:design': '正在设计 TO-BE 方案',
    'plan:confirm': '等待用户确认方案',
    'worktree:setup': '等待配置工作分支',
    'tasks:init': '正在初始化 Task',
    'implement:code': '正在编码实现',
    'test:unit': '正在执行单测、覆盖率与异常集中返修',
    'review:cr': '正在进行代码审查',
    'review:cr-light': '正在进行轻量审查',
    'review:cr-moderate': '正在进行中等审查',
    'repair:code': '正在修复 CR 发现的问题',
    'review:integration': '正在进行集成审查',
    'review:cr-report': '正在生成最终 CR 报告',
    'final:summary': '正在生成最终总结',
    'review:merge': '等待用户审阅当前变更并批准合并',
    'done': '需求已完成',
    'blocked': '流程被阻塞',
  };
  const stepLabel = STEP_LABELS[currentStep] || `当前步骤：${currentStep}`;
  const parts = [stepLabel];
  if (taskStats.total > 0) {
    parts.push(`${taskStats.approved}/${taskStats.total} task 已通过`);
  }
  if (crStats.rework > 0) {
    parts.push(`${crStats.rework} 个 CR 问题待修复`);
  }
  return parts.join('，');
}

function getTopChangePoints(changePoints, limit = 3) {
  const sorted = [...changePoints].sort((a, b) => {
    const riskOrder = { high: 0, medium: 1, low: 2 };
    const ra = riskOrder[a.risk_level] ?? 2;
    const rb = riskOrder[b.risk_level] ?? 2;
    if (ra !== rb) return ra - rb;
    const decOrder = { '删除': 0, '新增': 1, '改造': 2, '保留': 3 };
    return (decOrder[a.decision] ?? 3) - (decOrder[b.decision] ?? 3);
  });
  return { items: sorted.slice(0, limit), remaining: Math.max(0, sorted.length - limit) };
}

function getTopRisks(impactRisk, crResults, limit = 3) {
  const risks = [];
  for (const r of (impactRisk?.risk_matrix || [])) {
    if (String(r.severity || '').toLowerCase() === 'high') {
      risks.push({ severity: 'high', source: 'risk-matrix', description: r.description || r.mitigation || '' });
    }
  }
  for (const cr of crResults) {
    for (const item of (cr.reworkItems || [])) {
      const sev = String(item['严重度'] || item.severity || '').toLowerCase();
      if (sev.includes('high') || sev.includes('critical')) {
        risks.push({ severity: sev.includes('critical') ? 'critical' : 'high', source: `CR ${cr.dimension}`, description: item['问题描述'] || item.description || '' });
      }
    }
  }
  return { items: risks.slice(0, limit), remaining: Math.max(0, risks.length - limit) };
}

function renderFocusSummary({ currentStep, taskStats, crStats, changePoints, impactRisk, crResults }) {
  const sentence = generateStatusSentence(currentStep, taskStats, crStats);
  const topCPs = getTopChangePoints(changePoints);
  const topRisks = getTopRisks(impactRisk, crResults);

  const taskProgressParts = [];
  const byStatus = taskStats.byStatus || {};
  if (byStatus.approved) taskProgressParts.push(`${byStatus.approved} approved`);
  if (byStatus.coding || byStatus.coded) taskProgressParts.push(`${(byStatus.coding || 0) + (byStatus.coded || 0)} coding`);
  if (byStatus.needs_rework || byStatus.repairing) taskProgressParts.push(`${(byStatus.needs_rework || 0) + (byStatus.repairing || 0)} rework`);
  if (byStatus.pending || byStatus.confirmed) taskProgressParts.push(`${(byStatus.pending || 0) + (byStatus.confirmed || 0)} pending`);

  return `<section class="focus-summary" aria-label="状态聚焦">
    <div class="focus-sentence">${escHtml(sentence)}</div>
    <div class="focus-grid">
      <div class="focus-block">
        <div class="focus-block-title">关键变化点</div>
        ${topCPs.items.length > 0 ? `<ul class="focus-list-compact">${topCPs.items.map(cp => `<li><span class="ref-chip cp">${escHtml(cp.id)}</span><span class="status s-${cp.risk_level === 'high' ? 'failed' : cp.risk_level === 'medium' ? 'needs_rework' : 'approved'}">${escHtml(cp.risk_level || 'low')}</span><span class="focus-desc">${escHtml(oneSentence(cp.summary || cp.node || cp.id, 60))}</span></li>`).join('')}</ul>${topCPs.remaining > 0 ? `<div class="focus-more"><button type="button" class="view-link" onclick="activateView('view-to-be')">+${topCPs.remaining} more</button></div>` : ''}` : '<p class="muted">暂无改造点</p>'}
      </div>
      <div class="focus-block">
        <div class="focus-block-title">风险关注</div>
        ${topRisks.items.length > 0 ? `<ul class="focus-list-compact">${topRisks.items.map(r => `<li><span class="status s-${r.severity === 'critical' ? 'fail' : 'failed'}">${escHtml(r.severity)}</span><span class="focus-desc">${escHtml(oneSentence(r.description, 70))}</span></li>`).join('')}</ul>${topRisks.remaining > 0 ? `<div class="focus-more">+${topRisks.remaining} 项风险</div>` : ''}` : '<p class="muted">暂无高风险项</p>'}
      </div>
      <div class="focus-block">
        <div class="focus-block-title">Task 进度</div>
        ${taskStats.total > 0 ? `<div class="progress-bar" style="height:8px;margin:6px 0"><div class="progress-fill ${taskStats.percentage === 100 ? 'fill-success' : 'fill-accent'}" style="width:${taskStats.percentage}%"></div></div><div class="focus-task-status">${taskProgressParts.join(' · ')}</div>` : '<p class="muted">暂无 Task</p>'}
      </div>
    </div>
  </section>`;
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
