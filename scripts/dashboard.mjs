#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, basename, resolve } from 'node:path';
import { atomicWriteFile, readTaskState, taskStateFile, readFrontmatter } from './workflow-lib.mjs';

const IDEA_DIR = process.argv[2];
if (!IDEA_DIR || !existsSync(IDEA_DIR)) {
  process.stderr.write('用法: node dashboard.mjs <idea-dir>\n');
  process.exit(1);
}

// --- Data collection ---

function readJson(rel) {
  const p = join(IDEA_DIR, rel);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function readMd(rel) {
  const p = join(IDEA_DIR, rel);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf8');
}

function readWorkflowState() {
  const p = join(IDEA_DIR, 'workflow-state.yaml');
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

function collectCrResults() {
  const crDir = join(IDEA_DIR, 'cr');
  if (!existsSync(crDir)) return [];
  const files = readdirSync(crDir).filter(f => /^dim-.*-cr\.md$/.test(f));
  return files.map(f => {
    const text = readFileSync(join(crDir, f), 'utf8');
    const fm = readFrontmatter(text);
    return { file: f, dimension: fm.dimension || f.replace('dim-', '').replace('-cr.md', ''), result: fm.result || 'unknown', ...fm };
  });
}

function collectTraceability() {
  const matrix = readJson('to-be/traceability-matrix.json');
  if (!matrix) return null;
  const state = readTaskState(taskStateFile(IDEA_DIR));
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

// --- Collect all data ---

const workflowState = readWorkflowState();
const taskState = readTaskState(taskStateFile(IDEA_DIR));
const crResults = collectCrResults();
const traceability = collectTraceability();
const impactRisk = readJson('to-be/impact-risk-report.json');
const requirement = readMd('requirement.md');
const overview = readMd('as-is/overview.md');
const coreWalkthrough = readMd('as-is/core-walkthrough.md');
const evidenceLedger = readJson('as-is/evidence-ledger.json');
const qualityScore = readJson('as-is/quality-score.json');
const coverageMatrix = readJson('as-is/coverage-matrix.json');
const ideaName = basename(IDEA_DIR);

// Detect complexity
function detectComplexity() {
  if (!requirement) return 'standard';
  const m = requirement.match(/^##\s*复杂度[：:]\s*(trivial|standard|complex)\s*$/m);
  if (m) return m[1];
  return 'standard';
}
const complexity = detectComplexity();

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
  crResults,
  traceability,
};

const WORKFLOW_STEPS = complexity === 'trivial'
  ? ['receive-requirement', 'clarify:requirement', 'quick-dev:init', 'implement:code', 'review:cr-light', 'final:summary', 'done']
  : ['receive-requirement', 'understand:explore', 'understand:confirm', 'understand:generate-ai-input', 'clarify:requirement', 'plan:design', 'plan:confirm', 'knowledge:extract', 'worktree:setup', 'tasks:init', 'implement:code', 'review:cr', 'repair:code', 'final:summary', 'done'];

const currentIdx = WORKFLOW_STEPS.indexOf(DATA.currentStep);

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>Chisel Dashboard — ${escHtml(ideaName)}</title>
<script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"><\/script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4/dist/chart.umd.min.js"><\/script>
<style>
:root{--bg:#0f172a;--surface:#1e293b;--surface2:#334155;--text:#e2e8f0;--text2:#94a3b8;--accent:#3b82f6;--success:#22c55e;--warn:#eab308;--danger:#ef4444;--border:#475569}
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:var(--bg);color:var(--text);line-height:1.6;padding:24px}
.container{max-width:1400px;margin:0 auto}
header{display:flex;align-items:center;gap:16px;margin-bottom:24px;flex-wrap:wrap}
header h1{font-size:1.5rem;font-weight:700}
.badge{padding:4px 12px;border-radius:12px;font-size:0.75rem;font-weight:600;text-transform:uppercase}
.badge-trivial{background:#065f46;color:#6ee7b7}
.badge-standard{background:#1e3a5f;color:#93c5fd}
.badge-complex{background:#581c87;color:#d8b4fe}
.badge-step{background:var(--surface2);color:var(--text)}
.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:16px}
.grid-full{grid-column:1/-1}
.card{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;overflow:auto}
.card h2{font-size:1rem;font-weight:600;margin-bottom:12px;color:var(--text2)}
.progress-bar{height:8px;background:var(--surface2);border-radius:4px;overflow:hidden;margin:4px 0}
.progress-fill{height:100%;border-radius:4px;transition:width .3s}
.fill-success{background:var(--success)}
.fill-warn{background:var(--warn)}
.fill-accent{background:var(--accent)}
table{width:100%;border-collapse:collapse;font-size:0.85rem}
th,td{padding:8px 12px;text-align:left;border-bottom:1px solid var(--border)}
th{color:var(--text2);font-weight:600}
.status{display:inline-block;padding:2px 8px;border-radius:4px;font-size:0.75rem;font-weight:600}
.s-approved{background:#065f46;color:#6ee7b7}
.s-coded,.s-coding{background:#1e3a5f;color:#93c5fd}
.s-reviewing{background:#4c1d95;color:#d8b4fe}
.s-needs_rework,.s-repairing{background:#7c2d12;color:#fdba74}
.s-pending,.s-confirmed{background:var(--surface2);color:var(--text2)}
.s-blocked,.s-failed{background:#7f1d1d;color:#fca5a5}
.s-pass{background:#065f46;color:#6ee7b7}
.s-fail{background:#7f1d1d;color:#fca5a5}
.tabs{display:flex;gap:4px;margin-bottom:12px;flex-wrap:wrap}
.tab{padding:6px 14px;border-radius:8px;cursor:pointer;font-size:0.8rem;background:var(--surface2);color:var(--text2);border:none;transition:all .2s}
.tab.active{background:var(--accent);color:#fff}
.tab-content{display:none}
.tab-content.active{display:block}
.tab-content pre.mermaid{background:transparent;text-align:center}
.tab-content h1,.tab-content h2,.tab-content h3,.tab-content h4{margin:16px 0 8px;color:var(--text)}
.tab-content p{margin:4px 0}
.tab-content ul{margin:4px 0 4px 20px}
.tab-content li{margin:2px 0}
.tab-content code{background:var(--surface2);padding:2px 6px;border-radius:4px;font-size:0.85em}
.tab-content pre>code{display:block;padding:12px;overflow-x:auto}
.tab-content table{margin:12px 0}
.tab-content a{color:var(--accent)}
.workflow-steps{display:flex;gap:2px;flex-wrap:wrap;align-items:center}
.wf-step{padding:4px 10px;border-radius:6px;font-size:0.7rem;background:var(--surface2);color:var(--text2)}
.wf-step.done{background:#065f46;color:#6ee7b7}
.wf-step.current{background:var(--accent);color:#fff;font-weight:700}
.wf-step.future{opacity:0.5}
.timeline{font-size:0.8rem}
.timeline-item{display:flex;gap:12px;padding:4px 0;border-left:2px solid var(--border);margin-left:8px;padding-left:12px}
.timeline-item .time{color:var(--text2);min-width:140px}
canvas{max-height:260px}
@media(max-width:900px){.grid{grid-template-columns:1fr}}
</style>
</head>
<body>
<div class="container">
<header>
  <h1>🔨 ${escHtml(ideaName)}</h1>
  <span class="badge badge-${complexity}">${complexity}</span>
  <span class="badge badge-step">${escHtml(DATA.currentStep)}</span>
  ${DATA.lastUpdated ? `<span style="color:var(--text2);font-size:0.8rem">更新于 ${escHtml(DATA.lastUpdated.slice(0, 16).replace('T', ' '))}</span>` : ''}
</header>

<!-- Workflow Progress -->
<div class="card grid-full" style="margin-bottom:16px">
  <h2>工作流进度</h2>
  <div class="workflow-steps">
    ${WORKFLOW_STEPS.map((s, i) => {
      const cls = i < currentIdx ? 'done' : i === currentIdx ? 'current' : 'future';
      return `<div class="wf-step ${cls}">${escHtml(s)}</div>`;
    }).join('<span style="color:var(--text2)">→</span>')}
  </div>
</div>

<div class="grid">
<!-- Task Status -->
<div class="card">
  <h2>Task 状态矩阵</h2>
  <table>
    <tr><th>Task</th><th>状态</th><th>返修</th><th>描述</th></tr>
    ${Object.entries(DATA.tasks).map(([id, t]) => `
    <tr>
      <td><strong>${escHtml(id)}</strong></td>
      <td><span class="status s-${t.status || 'pending'}">${escHtml(t.status || 'pending')}</span></td>
      <td>${t.rework_count || 0}</td>
      <td style="color:var(--text2);font-size:0.8rem">${escHtml(String(t.description || '').slice(0, 60))}</td>
    </tr>`).join('')}
  </table>
</div>

<!-- CR Radar -->
<div class="card">
  <h2>CR 维度结果</h2>
  ${crResults.length > 0 ? `
  <canvas id="crRadar"></canvas>
  <table style="margin-top:12px">
    <tr><th>维度</th><th>结果</th></tr>
    ${crResults.map(r => `<tr><td>${escHtml(r.dimension)}</td><td><span class="status s-${r.result}">${escHtml(r.result)}</span></td></tr>`).join('')}
  </table>` : '<p style="color:var(--text2)">暂无 CR 结果</p>'}
</div>
</div>

<!-- Traceability -->
${traceability ? `
<div class="card" style="margin-bottom:16px">
  <h2>需求可追溯覆盖度 — ${traceability.percentage}%</h2>
  <div class="progress-bar" style="height:12px;margin:8px 0">
    <div class="progress-fill ${traceability.percentage === 100 ? 'fill-success' : traceability.percentage >= 50 ? 'fill-warn' : 'fill-accent'}" style="width:${traceability.percentage}%"></div>
  </div>
  <table>
    <tr><th>需求 ID</th><th>描述</th><th>覆盖 Tasks</th><th>状态</th></tr>
    ${traceability.items.map(item => `
    <tr>
      <td>${escHtml(item.id || item.requirement_id || '')}</td>
      <td style="font-size:0.8rem">${escHtml(String(item.description || item.requirement || '').slice(0, 80))}</td>
      <td style="font-size:0.8rem">${escHtml((item.covered_by_tasks || []).join(', '))}</td>
      <td><span class="status s-${item.coverage === 'complete' ? 'approved' : item.coverage === 'missing' ? 'failed' : 'coding'}">${escHtml(item.coverage)}</span></td>
    </tr>`).join('')}
  </table>
</div>` : ''}

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
    <button class="tab active" data-tab="risk-cps">改造点</button>
    <button class="tab" data-tab="risk-matrix">风险矩阵</button>
    <button class="tab" data-tab="risk-reuse">复用节点</button>
  </div>
  <div class="tab-content active" id="risk-cps">
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

</div><!-- container -->

<script>
mermaid.initialize({startOnLoad:true,theme:'dark'});

// Tab switching
document.querySelectorAll('.tabs').forEach(tabGroup=>{
  tabGroup.querySelectorAll('.tab').forEach(btn=>{
    btn.addEventListener('click',()=>{
      tabGroup.querySelectorAll('.tab').forEach(b=>b.classList.remove('active'));
      btn.classList.add('active');
      const card=tabGroup.closest('.card');
      card.querySelectorAll('.tab-content').forEach(c=>c.classList.remove('active'));
      const target=card.querySelector('#'+btn.dataset.tab);
      if(target)target.classList.add('active');
    });
  });
});

// CR Radar Chart
${crResults.length > 0 ? `
(function(){
  const dims=${JSON.stringify(crResults.map(r => r.dimension))};
  const scores=${JSON.stringify(crResults.map(r => r.result === 'pass' ? 1 : 0))};
  const ctx=document.getElementById('crRadar');
  if(ctx){new Chart(ctx,{type:'radar',data:{labels:dims,datasets:[{label:'CR',data:scores,backgroundColor:'rgba(59,130,246,0.2)',borderColor:'#3b82f6',pointBackgroundColor:'#3b82f6'}]},options:{scales:{r:{min:0,max:1,ticks:{stepSize:1,display:false},grid:{color:'#475569'},pointLabels:{color:'#e2e8f0'}}},plugins:{legend:{display:false}}}});}
})();` : ''}

// Quality Radar Chart
${qualityScore ? `
(function(){
  const qs=${JSON.stringify(qualityScore)};
  const dims=Object.keys(qs.dimensions||qs.scores||{});
  const scores=Object.values(qs.dimensions||qs.scores||{}).map(v=>typeof v==='number'?v:(v?.score||0));
  const ctx=document.getElementById('qualityRadar');
  if(ctx&&dims.length>0){new Chart(ctx,{type:'radar',data:{labels:dims,datasets:[{label:'质量',data:scores,backgroundColor:'rgba(34,197,94,0.2)',borderColor:'#22c55e',pointBackgroundColor:'#22c55e'}]},options:{scales:{r:{min:0,max:100,ticks:{stepSize:20,color:'#94a3b8'},grid:{color:'#475569'},pointLabels:{color:'#e2e8f0'}}},plugins:{legend:{display:false}}}});}
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
      <td style="font-size:0.85rem">${escHtml(String(e.claim || e.description || '').slice(0, 120))}</td>
      <td><span class="status s-${(e.status || 'pending') === 'confirmed' ? 'approved' : 'pending'}">${escHtml(e.status || 'pending')}</span></td>
      <td style="font-size:0.8rem;color:var(--text2)">${escHtml(String(e.source || e.evidence || '').slice(0, 60))}</td>
    </tr>`).join('')}
  </table>`;
}

function renderQualityDetails(qs) {
  const dims = qs.dimensions || qs.scores || {};
  const weakItems = Object.entries(dims).filter(([, v]) => (typeof v === 'number' ? v : v?.score || 0) < 60);
  if (weakItems.length === 0) return '<p style="margin-top:12px;color:var(--success)">所有维度评分良好</p>';
  return `<div style="margin-top:12px"><strong style="color:var(--warn)">弱项：</strong><ul>${weakItems.map(([k, v]) => `<li>${escHtml(k)}: ${typeof v === 'number' ? v : v?.score || 0}/100</li>`).join('')}</ul></div>`;
}

function renderCoverageMatrix(matrix) {
  if (!matrix) return '';
  // matrix can be {rows, columns, cells} or array format
  if (matrix.rows && matrix.columns && matrix.cells) {
    return `<table>
      <tr><th></th>${matrix.columns.map(c => `<th style="font-size:0.75rem;writing-mode:vertical-lr">${escHtml(String(c).slice(0, 20))}</th>`).join('')}</tr>
      ${matrix.rows.map((r, ri) => `<tr><td style="font-size:0.8rem">${escHtml(String(r).slice(0, 30))}</td>${(matrix.cells[ri] || []).map(cell => {
        const val = typeof cell === 'number' ? cell : (cell ? 1 : 0);
        const bg = val > 0 ? 'background:rgba(34,197,94,0.3)' : '';
        return `<td style="text-align:center;${bg}">${val > 0 ? '✓' : '·'}</td>`;
      }).join('')}</tr>`).join('')}
    </table>`;
  }
  // Fallback: just render as JSON
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
