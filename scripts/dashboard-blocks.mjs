#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, basename, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  atomicWriteFile, readTaskState, taskStateFile, readFrontmatter, detectComplexity
} from './workflow-lib.mjs';
import { WORKFLOW_PATHS } from './workflow-definition.mjs';
import {
  collectCrResults, collectTraceability, computeDashboardSummary,
  countCrFindings, countTasksByStatus, normalizeApiChangePlan,
  normalizeCoverageMatrixRefs, normalizeDataChangePlan, normalizeStepTimings,
  normalizeTasksJson, normalizeTraceabilityTree, oneSentence,
  formatDuration, formatEvidence, parseTableSection
} from './dashboard.mjs';

const __scriptDir = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(__scriptDir, 'assets', 'dashboard-template.html');
let _tplCache = null;
function getTemplate() {
  if (!_tplCache) _tplCache = readFileSync(TEMPLATE_PATH, 'utf8');
  return _tplCache;
}

// --- Data loading (mirrored from dashboard.mjs main) ---

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
    'plan:design': [
      { label: '实现方案', file: 'to-be/implementation-plan.md' },
      { label: 'Tasks', file: 'to-be/tasks.json' },
    ],
    'implement:code': [{ label: 'Task 报告', file: 'task-reports/', isDir: true }],
    'review:cr': [{ label: 'CR 结果', file: 'cr/', isDir: true }],
    'final:summary': [{ label: '最终摘要', file: 'final-summary.md' }],
  };
  const visited = new Set((stepHistory || []).map(h => h.step));
  return steps.map(stepId => {
    const status = stepId === currentStep ? 'current' : visited.has(stepId) ? 'done' : 'pending';
    const outputs = (STEP_OUTPUTS_MAP[stepId] || []).map(o => ({ ...o, exists: existsSync(join(ideaDir, o.file)) }));
    return { step: stepId, status, outputs };
  });
}

// --- HTML utilities ---

function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }

function wrapHtml(title, body) {
  return getTemplate().replace('{{TITLE}}', esc(title)).replace('{{BODY_HTML}}', body);
}

function blockHero(icon, title, subtitle) {
  return `<div class="block-hero animate-in"><h1 class="block-hero-title">${icon} ${esc(title)}</h1>${subtitle ? `<p class="block-hero-subtitle">${esc(subtitle)}</p>` : ''}</div>\n`;
}

function pillClass(status) {
  if (['approved', 'pass', 'complete', 'done'].includes(status)) return 'pill-success';
  if (['coding', 'coded', 'reviewing', 'in_progress'].includes(status)) return 'pill-accent';
  if (['needs_rework', 'repairing', 'medium'].includes(status)) return 'pill-warn';
  if (['blocked', 'failed', 'fail', 'high', 'critical'].includes(status)) return 'pill-danger';
  return 'pill-muted';
}

function metric(label, value, hint = '', tone = '') {
  const cls = tone === 'accent' ? 'v-accent' : tone === 'success' ? 'v-success' : tone === 'warn' ? 'v-warn' : tone === 'danger' ? 'v-danger' : '';
  return `<div class="metric animate-in"><div class="metric-value ${cls}">${esc(value)}</div><div class="metric-label">${esc(label)}</div>${hint ? `<div class="metric-hint">${esc(hint)}</div>` : ''}</div>`;
}

function mdToSimpleHtml(md) {
  if (!md) return '';
  return md.split('\n').map(line => {
    if (/^###\s/.test(line)) return `<h3>${esc(line.replace(/^###\s*/, ''))}</h3>`;
    if (/^##\s/.test(line)) return `<h2>${esc(line.replace(/^##\s*/, ''))}</h2>`;
    if (/^#\s/.test(line)) return `<h1>${esc(line.replace(/^#\s*/, ''))}</h1>`;
    if (/^[-*]\s/.test(line)) return `<li>${esc(line.replace(/^[-*]\s*/, ''))}</li>`;
    if (line.trim() === '') return '';
    return `<p>${esc(line)}</p>`;
  }).join('\n');
}

// --- Block renderers ---

function renderOverviewBlock(data) {
  const { summary, workflowSteps, currentIdx, timingSummary, currentStep, impactRisk, stepOutputs } = data;
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

  if (impactRisk?.summary?.highest_risk) {
    body += `<div class="card animate-in card-accent-orange"><h2>风险关注</h2><p>${esc(impactRisk.summary.highest_risk)}</p></div>\n`;
  }

  return wrapHtml(`总览 — ${data.ideaName}`, body);
}

function renderAsIsBlock(data) {
  const { overview, coreWalkthrough, evidenceLedger, qualityScore, coverageMatrix } = data;
  let body = blockHero('📖', 'As-Is 现状理解', data.ideaName);

  if (!overview && !coreWalkthrough && !evidenceLedger && !qualityScore) {
    body += `<div class="card animate-in"><p class="muted">暂无 As-Is 产物。</p></div>`;
    return wrapHtml(`As-Is — ${data.ideaName}`, body);
  }

  if (overview) {
    body += `<div class="card animate-in"><h2>概览</h2><div class="section-md">${mdToSimpleHtml(overview)}</div></div>\n`;
  }
  if (coreWalkthrough) {
    body += `<div class="card animate-in"><h2>核心走查</h2><div class="section-md">${mdToSimpleHtml(coreWalkthrough)}</div></div>\n`;
  }
  if (qualityScore) {
    const dims = qualityScore.dimensions || qualityScore.scores || {};
    body += `<div class="card animate-in"><h2>质量评分</h2><table><tr><th>维度</th><th>评分</th></tr>`;
    for (const [k, v] of Object.entries(dims)) {
      const score = typeof v === 'number' ? v : v?.score || 0;
      const pct = Math.round(score * 100);
      const tone = pct >= 80 ? 'success' : pct >= 60 ? 'accent' : 'warn';
      body += `<tr><td>${esc(k)}</td><td><span class="pill pill-${tone === 'success' ? 'success' : tone === 'warn' ? 'warn' : 'accent'}">${pct}%</span></td></tr>`;
    }
    body += `</table></div>\n`;
  }
  if (evidenceLedger) {
    const items = Array.isArray(evidenceLedger) ? evidenceLedger : (evidenceLedger.facts || evidenceLedger.items || []);
    if (items.length > 0) {
      body += `<div class="card animate-in"><h2>证据索引</h2><table><tr><th>ID</th><th>声明</th><th>状态</th></tr>`;
      for (const e of items.slice(0, 20)) {
        body += `<tr><td>${esc(e.id || '')}</td><td class="desc">${esc(oneSentence(e.claim || e.description || ''))}</td><td><span class="pill ${pillClass(e.status || 'pending')}">${esc(e.status || 'pending')}</span></td></tr>`;
      }
      body += `</table></div>\n`;
    }
  }

  return wrapHtml(`As-Is — ${data.ideaName}`, body);
}

function renderToBeBlock(data) {
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

  if (normalizedTasks.length > 0) {
    body += `<div class="card animate-in"><h2>Task 拆分</h2><table><tr><th>Task</th><th>风险</th><th>关联需求</th><th>目标</th></tr>`;
    for (const t of normalizedTasks) {
      body += `<tr><td><strong>${esc(t.id)}</strong></td><td><span class="pill ${pillClass(t.risk_level)}">${esc(t.risk_level)}</span></td><td>${esc((t.trace_refs || []).join(', ') || '—')}</td><td class="desc">${esc(oneSentence(t.title || t.goal))}</td></tr>`;
    }
    body += `</table></div>\n`;
  }

  if (changePoints.length > 0) {
    body += `<div class="card animate-in"><h2>改造点</h2><table><tr><th>ID</th><th>决策</th><th>风险</th><th>说明</th></tr>`;
    for (const cp of changePoints.slice(0, 15)) {
      body += `<tr><td><strong>${esc(cp.id)}</strong></td><td><span class="pill ${pillClass(cp.decision === '删除' ? 'fail' : cp.decision === '新增' ? 'approved' : 'coding')}">${esc(cp.decision || '改造')}</span></td><td><span class="pill ${pillClass(cp.risk_level || 'low')}">${esc(cp.risk_level || 'low')}</span></td><td class="desc">${esc(cp.summary || cp.node || '')}</td></tr>`;
    }
    body += `</table></div>\n`;
  }

  if (impactRisk?.risk_matrix?.length) {
    body += `<div class="card animate-in card-accent-red"><h2>风险矩阵</h2><table><tr><th>ID</th><th>描述</th><th>严重度</th><th>缓解</th></tr>`;
    for (const r of impactRisk.risk_matrix.slice(0, 10)) {
      body += `<tr><td>${esc(r.id)}</td><td class="desc">${esc(oneSentence(r.description))}</td><td><span class="pill ${pillClass(r.severity)}">${esc(r.severity)}</span></td><td class="desc">${esc(oneSentence(r.mitigation))}</td></tr>`;
    }
    body += `</table></div>\n`;
  }

  if (implementationPlan) {
    body += `<div class="card animate-in"><h2>实施方案</h2><div class="section-md">${mdToSimpleHtml(implementationPlan.slice(0, 3000))}</div></div>\n`;
  }

  return wrapHtml(`To-Be — ${data.ideaName}`, body);
}

function renderProgressBlock(data) {
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

function renderCrBlock(data) {
  const { crResults, taskDetails, reviewReportMd } = data;
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
    body += `<div class="card animate-in"><h2>总报告</h2><div class="section-md">${mdToSimpleHtml(reviewReportMd.slice(0, 3000))}</div></div>\n`;
  }

  return wrapHtml(`CR — ${data.ideaName}`, body);
}

function renderTimelineBlock(data) {
  const { timingSummary, stepOutputs, stepHistory } = data;
  let body = blockHero('⏱️', '时间线与产出', data.ideaName);

  if (timingSummary.steps.length > 0) {
    const maxMs = Math.max(1, ...timingSummary.steps.map(s => s.duration_ms));
    body += `<div class="card animate-in"><h2>环节耗时 · 总计 ${esc(timingSummary.total_label)}</h2>`;
    for (const s of timingSummary.steps) {
      const pct = Math.max(2, Math.round((s.duration_ms / maxMs) * 100));
      body += `<div class="timing-row"><div class="timing-step">${esc(s.step)}${s.running ? ' ⏳' : ''}</div><div class="timing-bar"><div class="timing-fill" style="width:${pct}%"></div></div><div class="timing-val">${esc(s.duration_label)}</div></div>`;
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

// --- Main ---

function loadData(ideaDir) {
  const workflowState = readWorkflowState(ideaDir);
  const taskState = readTaskState(taskStateFile(ideaDir));
  const crResults = collectCrResults(ideaDir);
  const reviewReportMd = readMd(ideaDir, 'cr/review-report.md');
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
  const summary = computeDashboardSummary({
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
    crResults, reviewReportMd, impactRisk,
    overview, coreWalkthrough, evidenceLedger, qualityScore, coverageMatrix,
    implementationPlan, dataChanges, apiChanges,
    stepHistory: workflowState?.step_history || [],
  };
}

const BLOCKS = {
  overview: renderOverviewBlock,
  'as-is': renderAsIsBlock,
  'to-be': renderToBeBlock,
  progress: renderProgressBlock,
  'cr-results': renderCrBlock,
  timeline: renderTimelineBlock,
};

function main() {
  const ideaDir = process.argv[2];
  if (!ideaDir || !existsSync(ideaDir)) {
    process.stderr.write('用法: dashboard-blocks.mjs <idea-dir> [--blocks overview,progress,...]\n');
    process.exit(1);
  }

  const blocksArg = process.argv.find((a, i) => i > 0 && process.argv[i - 1] === '--blocks');
  const requestedBlocks = blocksArg ? blocksArg.split(',').map(s => s.trim()) : Object.keys(BLOCKS);

  const outDir = join(ideaDir, 'dashboard');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const data = loadData(ideaDir);
  const generated = [];

  for (const blockName of requestedBlocks) {
    const renderer = BLOCKS[blockName];
    if (!renderer) {
      process.stderr.write(`未知 block: ${blockName}\n`);
      continue;
    }
    const html = renderer(data);
    const fileName = `${blockName}.html`;
    const outPath = join(outDir, fileName);
    atomicWriteFile(outPath, html);
    generated.push(fileName);
  }

  const absDir = resolve(outDir);
  console.log(JSON.stringify({ generated, dir: absDir }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { BLOCKS, loadData };
