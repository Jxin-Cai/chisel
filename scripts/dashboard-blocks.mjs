#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
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
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Sans+SC:wght@400;500;600;700&display=swap" rel="stylesheet">
<style>
:root{--bg:#0f172a;--surface:#1e293b;--surface2:#334155;--text:#f1f5f9;--text2:#94a3b8;--text3:#64748b;--accent:#3b82f6;--success:#22c55e;--warn:#f59e0b;--danger:#ef4444;--purple:#a78bfa;--border:#334155;--radius:12px;--font:'Noto Sans SC','Inter',system-ui,sans-serif;--mono:ui-monospace,SFMono-Regular,Menlo,monospace}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:var(--font);background:var(--bg);color:var(--text);line-height:1.7;padding:32px 24px;min-height:100vh}
.container{max-width:960px;margin:0 auto}
h1{font-size:1.5rem;font-weight:700;margin-bottom:8px;letter-spacing:-0.02em}
h2{font-size:0.75rem;font-weight:600;text-transform:uppercase;letter-spacing:0.08em;color:var(--text2);margin:24px 0 12px}
.meta{font-size:0.8rem;color:var(--text3);margin-bottom:24px}
.card{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px;margin-bottom:16px}
.metric-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:12px;margin-bottom:20px}
.metric{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:16px;text-align:center}
.metric-value{font-size:1.8rem;font-weight:750;letter-spacing:-0.03em}
.metric-label{font-size:0.72rem;color:var(--text2);text-transform:uppercase;letter-spacing:0.06em;margin-top:2px}
.metric-hint{font-size:0.72rem;color:var(--text3);margin-top:4px}
.v-accent{color:var(--accent)}.v-success{color:var(--success)}.v-warn{color:var(--warn)}.v-danger{color:var(--danger)}
table{width:100%;border-collapse:collapse;font-size:0.82rem;margin:8px 0}
th{padding:8px 12px;text-align:left;border-bottom:1px solid var(--border);color:var(--text2);font-weight:500;font-size:0.7rem;text-transform:uppercase;letter-spacing:0.05em}
td{padding:8px 12px;border-bottom:1px solid rgba(255,255,255,0.04)}
tr:hover td{background:rgba(255,255,255,0.02)}
.pill{display:inline-block;padding:2px 8px;border-radius:100px;font-size:0.68rem;font-weight:600}
.pill-success{background:rgba(34,197,94,0.12);color:var(--success)}.pill-accent{background:rgba(59,130,246,0.12);color:var(--accent)}.pill-warn{background:rgba(245,158,11,0.12);color:var(--warn)}.pill-danger{background:rgba(239,68,68,0.12);color:var(--danger)}.pill-muted{background:rgba(255,255,255,0.04);color:var(--text3)}
.progress{height:8px;background:var(--surface2);border-radius:4px;overflow:hidden;margin:6px 0}
.progress-fill{height:100%;border-radius:4px}
.fill-accent{background:var(--accent)}.fill-success{background:var(--success)}.fill-warn{background:var(--warn)}
.wf-steps{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.wf-step{padding:4px 10px;border-radius:6px;font-size:0.68rem;font-family:var(--mono);background:rgba(255,255,255,0.03);color:var(--text3);border:1px solid var(--border)}
.wf-step.done{background:rgba(34,197,94,0.1);color:var(--success);border-color:rgba(34,197,94,0.2)}
.wf-step.current{background:rgba(59,130,246,0.12);color:var(--accent);border-color:rgba(59,130,246,0.3);font-weight:700}
.wf-arrow{color:var(--text3);font-size:0.6rem;padding:0 2px;opacity:0.4}
.timing-row{display:grid;grid-template-columns:minmax(140px,.6fr) 1fr 80px;gap:8px;align-items:center;margin:6px 0}
.timing-step{font-family:var(--mono);font-size:0.72rem;color:var(--text2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.timing-bar{height:8px;background:var(--surface2);border-radius:4px;overflow:hidden}
.timing-fill{height:100%;border-radius:4px;background:linear-gradient(90deg,var(--accent),var(--purple))}
.timing-val{font-family:var(--mono);font-size:0.72rem;color:var(--text);text-align:right}
.section-md{font-size:0.88rem;line-height:1.7;color:var(--text2)}
.section-md h1,.section-md h2,.section-md h3{color:var(--text);margin:16px 0 8px}
.section-md ul,.section-md ol{margin:4px 0 4px 20px}
.section-md code{background:var(--surface2);padding:2px 6px;border-radius:4px;font-family:var(--mono);font-size:0.82em}
.section-md pre{background:var(--surface2);padding:12px;border-radius:8px;overflow-x:auto;margin:8px 0}
.section-md pre code{background:none;padding:0}
.muted{color:var(--text3)}
.desc{max-width:400px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
@media(max-width:600px){body{padding:16px 12px}.metric-grid{grid-template-columns:1fr 1fr}.timing-row{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="container">
${body}
</div>
</body>
</html>`;
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
  return `<div class="metric"><div class="metric-value ${cls}">${esc(value)}</div><div class="metric-label">${esc(label)}</div>${hint ? `<div class="metric-hint">${esc(hint)}</div>` : ''}</div>`;
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

  let body = `<h1>📊 工作流总览</h1>\n<p class="meta">${esc(data.ideaName)} · ${esc(data.complexity)} · 当前步骤：${esc(currentStep)}</p>\n`;

  body += `<div class="metric-grid">\n`;
  body += metric('执行进度', `${summary.workflowPercentage}%`, `${summary.workflowDone}/${summary.workflowTotal} 步`, 'accent');
  body += metric('Task 完成', `${ts.percentage}%`, `${ts.approved}/${ts.total} approved`, ts.percentage === 100 ? 'success' : 'accent');
  body += metric('需求覆盖', `${summary.requirementCoverage}%`, summary.missingRequirements ? `${summary.missingRequirements} 项缺失` : '全覆盖', summary.requirementCoverage === 100 ? 'success' : 'warn');
  body += metric('CR Rework', String(cr.rework), `${cr.highSeverity} high`, cr.rework ? 'danger' : 'success');
  body += metric('总耗时', timingSummary.total_label, timingSummary.longest_step ? `最长：${timingSummary.longest_step.step}` : '', 'accent');
  body += `</div>\n`;

  body += `<div class="card"><h2>工作流进度</h2><div class="wf-steps">`;
  body += workflowSteps.map((s, i) => {
    const cls = i < currentIdx ? 'done' : i === currentIdx ? 'current' : '';
    return `<span class="wf-step ${cls}">${esc(s)}</span>`;
  }).join('<span class="wf-arrow">→</span>');
  body += `</div></div>\n`;

  if (timingSummary.steps.length > 0) {
    const maxMs = Math.max(1, ...timingSummary.steps.map(s => s.duration_ms));
    body += `<div class="card"><h2>环节耗时</h2>`;
    for (const s of timingSummary.steps) {
      const pct = Math.max(2, Math.round((s.duration_ms / maxMs) * 100));
      body += `<div class="timing-row"><div class="timing-step">${esc(s.step)}</div><div class="timing-bar"><div class="timing-fill" style="width:${pct}%"></div></div><div class="timing-val">${esc(s.duration_label)}</div></div>`;
    }
    body += `</div>\n`;
  }

  if (impactRisk?.summary?.highest_risk) {
    body += `<div class="card" style="border-left:3px solid var(--warn)"><h2>风险关注</h2><p>${esc(impactRisk.summary.highest_risk)}</p></div>\n`;
  }

  return wrapHtml(`总览 — ${data.ideaName}`, body);
}

function renderAsIsBlock(data) {
  const { overview, coreWalkthrough, evidenceLedger, qualityScore, coverageMatrix } = data;
  let body = `<h1>📖 As-Is 现状理解</h1>\n<p class="meta">${esc(data.ideaName)}</p>\n`;

  if (!overview && !coreWalkthrough && !evidenceLedger && !qualityScore) {
    body += `<div class="card"><p class="muted">暂无 As-Is 产物。</p></div>`;
    return wrapHtml(`As-Is — ${data.ideaName}`, body);
  }

  if (overview) {
    body += `<div class="card"><h2>概览</h2><div class="section-md">${mdToSimpleHtml(overview)}</div></div>\n`;
  }
  if (coreWalkthrough) {
    body += `<div class="card"><h2>核心走查</h2><div class="section-md">${mdToSimpleHtml(coreWalkthrough)}</div></div>\n`;
  }
  if (qualityScore) {
    const dims = qualityScore.dimensions || qualityScore.scores || {};
    body += `<div class="card"><h2>质量评分</h2><table><tr><th>维度</th><th>评分</th></tr>`;
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
      body += `<div class="card"><h2>证据索引</h2><table><tr><th>ID</th><th>声明</th><th>状态</th></tr>`;
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
  let body = `<h1>🎯 To-Be 方案</h1>\n<p class="meta">${esc(data.ideaName)}</p>\n`;

  if (!implementationPlan && normalizedTasks.length === 0) {
    body += `<div class="card"><p class="muted">暂无 To-Be 产物。</p></div>`;
    return wrapHtml(`To-Be — ${data.ideaName}`, body);
  }

  body += `<div class="metric-grid">`;
  body += metric('需求覆盖', `${traceabilityTree?.percentage || 0}%`, `${traceabilityTree?.covered || 0}/${traceabilityTree?.total || 0}`, (traceabilityTree?.percentage || 0) === 100 ? 'success' : 'accent');
  body += metric('改造点', String(changePoints.length), 'CP');
  body += metric('Task', String(normalizedTasks.length), '实现拆分');
  body += metric('数据/API', `${dataChanges ? 1 : 0}/${apiChanges ? 1 : 0}`, 'DB/API 计划');
  body += `</div>\n`;

  if (normalizedTasks.length > 0) {
    body += `<div class="card"><h2>Task 拆分</h2><table><tr><th>Task</th><th>风险</th><th>关联需求</th><th>目标</th></tr>`;
    for (const t of normalizedTasks) {
      body += `<tr><td><strong>${esc(t.id)}</strong></td><td><span class="pill ${pillClass(t.risk_level)}">${esc(t.risk_level)}</span></td><td>${esc((t.trace_refs || []).join(', ') || '—')}</td><td class="desc">${esc(oneSentence(t.title || t.goal))}</td></tr>`;
    }
    body += `</table></div>\n`;
  }

  if (changePoints.length > 0) {
    body += `<div class="card"><h2>改造点</h2><table><tr><th>ID</th><th>决策</th><th>风险</th><th>说明</th></tr>`;
    for (const cp of changePoints.slice(0, 15)) {
      body += `<tr><td><strong>${esc(cp.id)}</strong></td><td><span class="pill ${pillClass(cp.decision === '删除' ? 'fail' : cp.decision === '新增' ? 'approved' : 'coding')}">${esc(cp.decision || '改造')}</span></td><td><span class="pill ${pillClass(cp.risk_level || 'low')}">${esc(cp.risk_level || 'low')}</span></td><td class="desc">${esc(cp.summary || cp.node || '')}</td></tr>`;
    }
    body += `</table></div>\n`;
  }

  if (impactRisk?.risk_matrix?.length) {
    body += `<div class="card"><h2>风险矩阵</h2><table><tr><th>ID</th><th>描述</th><th>严重度</th><th>缓解</th></tr>`;
    for (const r of impactRisk.risk_matrix.slice(0, 10)) {
      body += `<tr><td>${esc(r.id)}</td><td class="desc">${esc(oneSentence(r.description))}</td><td><span class="pill ${pillClass(r.severity)}">${esc(r.severity)}</span></td><td class="desc">${esc(oneSentence(r.mitigation))}</td></tr>`;
    }
    body += `</table></div>\n`;
  }

  if (implementationPlan) {
    body += `<div class="card"><h2>实施方案</h2><div class="section-md">${mdToSimpleHtml(implementationPlan.slice(0, 3000))}</div></div>\n`;
  }

  return wrapHtml(`To-Be — ${data.ideaName}`, body);
}

function renderProgressBlock(data) {
  const { tasks, taskDetails, traceabilityTree } = data;
  const entries = Object.entries(tasks || {});
  let body = `<h1>🚀 实现进度</h1>\n<p class="meta">${esc(data.ideaName)}</p>\n`;

  const stats = countTasksByStatus(tasks);
  body += `<div class="metric-grid">`;
  body += metric('总计', String(stats.total), '', 'accent');
  body += metric('已通过', String(stats.approved), '', 'success');
  body += metric('返修中', String((stats.byStatus.needs_rework || 0) + (stats.byStatus.repairing || 0)), '', 'warn');
  body += metric('编码中', String((stats.byStatus.coding || 0) + (stats.byStatus.coded || 0)), '', 'accent');
  body += `</div>\n`;

  body += `<div class="progress"><div class="progress-fill ${stats.percentage === 100 ? 'fill-success' : 'fill-accent'}" style="width:${stats.percentage}%"></div></div>\n`;

  if (entries.length > 0) {
    body += `<div class="card"><h2>Task 状态矩阵</h2><table><tr><th>Task</th><th>状态</th><th>返修</th><th>描述</th></tr>`;
    for (const [id, t] of entries) {
      body += `<tr><td><strong>${esc(id)}</strong></td><td><span class="pill ${pillClass(t.status || 'pending')}">${esc(t.status || 'pending')}</span></td><td>${t.rework_count || 0}</td><td class="desc">${esc(oneSentence(t.description || ''))}</td></tr>`;
    }
    body += `</table></div>\n`;
  }

  if (traceabilityTree && traceabilityTree.total > 0) {
    body += `<div class="card"><h2>需求覆盖度 — ${traceabilityTree.percentage}%</h2>`;
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
  let body = `<h1>🔍 CR 审查结果</h1>\n<p class="meta">${esc(data.ideaName)}</p>\n`;

  if (crResults.length === 0) {
    body += `<div class="card"><p class="muted">暂无 CR 结果。</p></div>`;
    return wrapHtml(`CR — ${data.ideaName}`, body);
  }

  const stats = countCrFindings(crResults);
  body += `<div class="metric-grid">`;
  body += metric('Rework', String(stats.rework), '需返修', stats.rework ? 'danger' : 'success');
  body += metric('High 严重度', String(stats.highSeverity), '高风险', stats.highSeverity ? 'danger' : 'success');
  body += metric('平均置信度', stats.avgConfidence ? `${stats.avgConfidence}%` : '—', '');
  body += metric('Observations', String(stats.observations), '参考建议');
  body += `</div>\n`;

  body += `<div class="card"><h2>维度总览</h2><table><tr><th>维度</th><th>结果</th><th>Rework</th><th>Obs</th></tr>`;
  for (const r of crResults) {
    body += `<tr><td>${esc(r.dimension)}</td><td><span class="pill ${pillClass(r.result)}">${esc(r.result)}</span></td><td>${r.reworkItems?.length || 0}</td><td>${r.observations?.length || 0}</td></tr>`;
  }
  body += `</table></div>\n`;

  const reworkItems = crResults.flatMap(r => (r.reworkItems || []).map(i => ({ ...i, dim: r.dimension })));
  if (reworkItems.length > 0) {
    body += `<div class="card"><h2>Rework Items</h2><table><tr><th>维度</th><th>问题</th><th>严重度</th><th>置信度</th></tr>`;
    for (const i of reworkItems) {
      const desc = i['问题描述'] || i.description || '';
      const sev = i['严重度'] || i.severity || '';
      body += `<tr><td>${esc(i.dim)}</td><td class="desc">${esc(oneSentence(desc))}</td><td><span class="pill ${pillClass(sev)}">${esc(sev)}</span></td><td>${esc(i['置信度'] || i.confidence || '')}</td></tr>`;
    }
    body += `</table></div>\n`;
  }

  if (reviewReportMd) {
    body += `<div class="card"><h2>总报告</h2><div class="section-md">${mdToSimpleHtml(reviewReportMd.slice(0, 3000))}</div></div>\n`;
  }

  return wrapHtml(`CR — ${data.ideaName}`, body);
}

function renderTimelineBlock(data) {
  const { timingSummary, stepOutputs, stepHistory } = data;
  let body = `<h1>⏱️ 时间线与产出</h1>\n<p class="meta">${esc(data.ideaName)}</p>\n`;

  if (timingSummary.steps.length > 0) {
    const maxMs = Math.max(1, ...timingSummary.steps.map(s => s.duration_ms));
    body += `<div class="card"><h2>环节耗时 · 总计 ${esc(timingSummary.total_label)}</h2>`;
    for (const s of timingSummary.steps) {
      const pct = Math.max(2, Math.round((s.duration_ms / maxMs) * 100));
      body += `<div class="timing-row"><div class="timing-step">${esc(s.step)}${s.running ? ' ⏳' : ''}</div><div class="timing-bar"><div class="timing-fill" style="width:${pct}%"></div></div><div class="timing-val">${esc(s.duration_label)}</div></div>`;
    }
    body += `</div>\n`;
  }

  if (stepOutputs.length > 0) {
    body += `<div class="card"><h2>步骤产出</h2><table><tr><th>步骤</th><th>状态</th><th>产出</th></tr>`;
    for (const so of stepOutputs) {
      const statusText = so.status === 'done' ? '已完成' : so.status === 'current' ? '进行中' : '待执行';
      const outputs = so.outputs.length === 0 ? '—' : so.outputs.map(o => `${o.exists ? '✓' : '✗'} ${o.label}`).join(', ');
      body += `<tr><td style="font-family:var(--mono);font-size:0.72rem">${esc(so.step)}</td><td><span class="pill ${pillClass(so.status === 'done' ? 'approved' : so.status === 'current' ? 'coding' : 'pending')}">${statusText}</span></td><td style="font-size:0.78rem">${esc(outputs)}</td></tr>`;
    }
    body += `</table></div>\n`;
  }

  if (stepHistory.length > 0) {
    body += `<div class="card"><h2>时间线</h2>`;
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
