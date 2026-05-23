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

// --- Utility functions (exported for testing) ---

function detectComplexity(ideaDir) {
  const req = readMd(ideaDir, 'requirement.md');
  if (!req) return 'standard';
  const m = req.match(/^##\s*复杂度[：:]\s*(trivial|standard|complex)\s*$/m);
  if (m) return m[1];
  return 'standard';
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
    <button class="tab active" onclick="switchTab(this,'cr-detail','cr-summary')">总览</button>
    <button class="tab" onclick="switchTab(this,'cr-detail','cr-rework')">Rework Items</button>
    <button class="tab" onclick="switchTab(this,'cr-detail','cr-obs')">Observations</button>
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
        ${allRework.map(i => `<tr><td style="font-family:var(--font-mono);font-size:0.75rem">${escHtml(i.id || i.ID || '')}</td><td>${escHtml(i.dim)}</td><td style="font-size:0.8rem;max-width:300px">${escHtml((i['问题描述'] || i.description || '').slice(0, 100))}</td><td><span class="status s-${(i['严重度'] || i.severity || '') === 'high' ? 'fail' : 'coding'}">${escHtml(i['严重度'] || i.severity || '')}</span></td><td>${escHtml(i['置信度'] || i.confidence || '')}</td><td style="font-family:var(--font-mono);font-size:0.75rem">${escHtml(i.affected_task_id || i['affected_task_id'] || '')}</td></tr>`).join('')}
      </table>`;
    })()}
  </div>
  <div class="tab-content" id="cr-obs">
    ${(() => {
      const allObs = crResults.flatMap(r => (r.observations || []).map(i => ({ ...i, dim: r.dimension })));
      if (allObs.length === 0) return '<p style="color:var(--text2)">无 Observations</p>';
      return `<table><tr><th>ID</th><th>维度</th><th>描述</th><th>置信度</th><th>Task</th></tr>
        ${allObs.map(i => `<tr><td style="font-family:var(--font-mono);font-size:0.75rem">${escHtml(i.id || i.ID || '')}</td><td>${escHtml(i.dim)}</td><td style="font-size:0.8rem;max-width:400px">${escHtml((i['描述'] || i.description || '').slice(0, 120))}</td><td>${escHtml(i['置信度'] || i.confidence || '')}</td><td style="font-family:var(--font-mono);font-size:0.75rem">${escHtml(i.affected_task_id || i['affected_task_id'] || '')}</td></tr>`).join('')}
      </table>`;
    })()}
  </div>` : '<p style="color:var(--text2)">暂无 CR 结果</p>'}
</div>
</div>

<!-- To-Be 方案视图 -->
${(implementationPlan || tasksJson) ? `
<div class="card" style="margin-bottom:16px">
  <h2>To-Be 方案</h2>
  <div class="tabs" data-group="tobe">
    <button class="tab active" onclick="switchTab(this,'tobe','tobe-overview')">方案概览</button>
    ${implementationPlan && implementationPlan.includes('## 改造点') ? `<button class="tab" onclick="switchTab(this,'tobe','tobe-cp')">改造点映射</button>` : ''}
    ${tasksJson ? `<button class="tab" onclick="switchTab(this,'tobe','tobe-tasks')">Task 拆分</button>` : ''}
    ${(traceability && tasksJson) ? `<button class="tab" onclick="switchTab(this,'tobe','tobe-matrix')">覆盖矩阵</button>` : ''}
  </div>
  <div class="tab-content active" id="tobe-overview">
    ${(() => {
      if (!implementationPlan) return '<p style="color:var(--text2)">无 implementation-plan.md</p>';
      const sections = ['目标行为', '非目标行为', '方案总览', '回滚方案'];
      let html = '';
      for (const sec of sections) {
        const re = new RegExp('##\\\\s+' + sec + '[^\\n]*\\n([\\\\s\\\\S]*?)(?=\\n##\\\\s|$)');
        const m = implementationPlan.match(new RegExp('##\\s+' + sec + '[^\\n]*\\n([\\s\\S]*?)(?=\\n## |$)'));
        if (m) html += '<h3>' + sec + '</h3>' + mdToHtml(m[1].trim());
      }
      return html || mdToHtml(implementationPlan.slice(0, 2000));
    })()}
  </div>
  ${implementationPlan && implementationPlan.includes('## 改造点') ? `<div class="tab-content" id="tobe-cp">
    ${(() => {
      const m = implementationPlan.match(/## 改造点[^\n]*\n([\s\S]*?)(?=\n## |$)/);
      return m ? mdToHtml(m[1].trim()) : '<p style="color:var(--text2)">无改造点章节</p>';
    })()}
  </div>` : ''}
  ${tasksJson ? `<div class="tab-content" id="tobe-tasks">
    <table>
      <tr><th>ID</th><th>标题</th><th>CP Refs</th><th>风险</th><th>AC 数</th></tr>
      ${(tasksJson.tasks || tasksJson || []).map(t => `<tr>
        <td style="font-family:var(--font-mono);font-size:0.75rem">${escHtml(t.id || '')}</td>
        <td style="font-size:0.8rem">${escHtml(String(t.title || '').slice(0, 60))}</td>
        <td style="font-size:0.75rem">${escHtml((t.change_point_refs || t.cp_refs || []).join(', '))}</td>
        <td><span class="status s-${(t.risk || '') === 'high' ? 'fail' : (t.risk || '') === 'medium' ? 'coding' : 'approved'}">${escHtml(t.risk || 'low')}</span></td>
        <td>${(t.acceptance_criteria || t.ac || []).length}</td>
      </tr>`).join('')}
    </table>
  </div>` : ''}
  ${(traceability && tasksJson) ? `<div class="tab-content" id="tobe-matrix">
    <table>
      <tr><th>需求 AC</th><th>覆盖 Task</th><th>关联 CP</th></tr>
      ${(traceability.items || []).map(item => {
        const tasks = item.covered_by_tasks || [];
        const cps = tasks.flatMap(tid => {
          const t = (tasksJson.tasks || tasksJson || []).find(x => x.id === tid);
          return t ? (t.change_point_refs || t.cp_refs || []) : [];
        });
        return `<tr>
          <td style="font-size:0.8rem">${escHtml(String(item.description || item.requirement || item.id || '').slice(0, 60))}</td>
          <td style="font-family:var(--font-mono);font-size:0.75rem">${escHtml(tasks.join(', '))}</td>
          <td style="font-family:var(--font-mono);font-size:0.75rem">${escHtml([...new Set(cps)].join(', '))}</td>
        </tr>`;
      }).join('')}
    </table>
  </div>` : ''}
</div>` : ''}

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
      <td style="font-size:0.85rem">${escHtml(String(e.claim || e.description || '').slice(0, 120))}</td>
      <td><span class="status s-${(e.status || 'pending') === 'confirmed' ? 'approved' : 'pending'}">${escHtml(e.status || 'pending')}</span></td>
      <td style="font-size:0.8rem;color:var(--text2)">${escHtml(String(e.source || e.evidence || '').slice(0, 60))}</td>
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
} // end main

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { collectCrResults, collectTraceability, detectComplexity, parseTableSection };
