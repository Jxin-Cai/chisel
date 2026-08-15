#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, basename, resolve } from 'node:path';
import { readFrontmatter, atomicWriteFile, detectComplexity } from './workflow-lib.mjs';
import { resolveExistingIdeaDirectory } from './control-plane.mjs';

const DIM_NAMES = {
  spec: 'Spec 合规',
  d2: '并发与分布式安全',
  d3: '代码去重',
  d4: '设计原则符合性',
  d5: '风格一致性',
  d6: '可维护性',
  d7: '无效代码清除',
  d8: '影响面追踪',
  d9: '安全审查',
  integration: '集成审查',
};

const ORDERED_DIMS = ['spec', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9', 'integration'];

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

function collectDimResultsFromDir(crDir, cycle = 'final') {
  if (!existsSync(crDir)) return [];

  const files = readdirSync(crDir).filter(f => /^dim-.*-cr\.md$/.test(f));
  const results = [];

  for (const f of files) {
    const dimMatch = f.match(/^dim-(.+)-cr\.md$/);
    if (!dimMatch) continue;
    const dim = dimMatch[1];
    if (!ORDERED_DIMS.includes(dim)) continue;

    const content = readFileSync(join(crDir, f), 'utf8');
    const fm = readFrontmatter(content);
    const reworkItems = parseTableSection(content, 'Rework Items');
    const observations = parseTableSection(content, 'Observations (non-blocking)');

    results.push({
      dimension: dim,
      name: DIM_NAMES[dim] || dim,
      result: fm.result || 'unknown',
      affected_tasks: Array.isArray(fm.affected_tasks) ? fm.affected_tasks : [],
      rework_count: Number(fm.rework_count || 0),
      cycle,
      reworkItems,
      observations,
    });
  }

  results.sort((a, b) => ORDERED_DIMS.indexOf(a.dimension) - ORDERED_DIMS.indexOf(b.dimension));
  return results;
}

function collectDimResults(ideaDir) {
  return collectDimResultsFromDir(join(ideaDir, 'cr'));
}

function collectHistoricalDimResults(ideaDir) {
  const historyDir = join(ideaDir, 'cr', 'history');
  if (!existsSync(historyDir)) return [];
  return readdirSync(historyDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && /^cycle-\d+$/.test(entry.name))
    .sort((a, b) => Number(a.name.slice(6)) - Number(b.name.slice(6)))
    .flatMap(entry => collectDimResultsFromDir(join(historyDir, entry.name), entry.name));
}

function normalizeSeverity(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.includes('critical')) return 'critical';
  if (s.includes('high')) return 'high';
  if (s.includes('medium') || s.includes('med')) return 'medium';
  if (s.includes('low')) return 'low';
  return 'medium';
}

function generateReport(ideaDir) {
  const ideaName = basename(ideaDir);
  const complexity = detectComplexity(ideaDir);
  const dimResults = collectDimResults(ideaDir);
  const historicalResults = collectHistoricalDimResults(ideaDir);

  if (dimResults.length === 0) {
    return { generated: false, reason: 'no CR dimension results found' };
  }

  const allReworkItems = dimResults.flatMap(r =>
    r.reworkItems.map((item, idx) => ({
      ...item,
      dimension: r.dimension,
      dimName: r.name,
      index: idx,
    }))
  );
  const repairedItems = historicalResults.flatMap(r => r.reworkItems.map(item => ({ ...item, dimension: r.dimension, dimName: r.name, cycle: r.cycle })));

  const allObservations = dimResults.flatMap(r =>
    r.observations.map((item, idx) => ({
      ...item,
      dimension: r.dimension,
      dimName: r.name,
      index: idx,
    }))
  );

  const bySeverity = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const item of allReworkItems) {
    const sev = normalizeSeverity(item['严重度'] || item.severity || '');
    bySeverity[sev] = (bySeverity[sev] || 0) + 1;
  }

  const highestSeverity = bySeverity.critical > 0 ? 'critical'
    : bySeverity.high > 0 ? 'high'
    : bySeverity.medium > 0 ? 'medium'
    : bySeverity.low > 0 ? 'low' : 'none';

  const hasFailDim = dimResults.some(r => r.result === 'fail');
  const verdict = hasFailDim ? 'needs_rework' : 'approved';

  const reviewed = dimResults.filter(r => r.result !== 'unknown');
  const skipped = ORDERED_DIMS.filter(d => !dimResults.find(r => r.dimension === d));
  const skippedLabel = skipped.length > 0 ? ` (${skipped.map(d => d.toUpperCase()).join(',')} skipped)` : '';

  const now = new Date().toISOString();

  let md = '';
  md += '---\n';
  md += `generated_at: ${now}\n`;
  md += `idea: ${ideaName}\n`;
  md += `complexity: ${complexity}\n`;
  md += `total_findings: ${allReworkItems.length}\n`;
  md += `by_severity:\n`;
  md += `  critical: ${bySeverity.critical}\n`;
  md += `  high: ${bySeverity.high}\n`;
  md += `  medium: ${bySeverity.medium}\n`;
  md += `  low: ${bySeverity.low}\n`;
  md += `verdict: ${verdict}\n`;
  md += '---\n\n';

  md += '# Code Review Report\n\n';

  md += '## Summary\n\n';
  md += '| Metric | Value |\n';
  md += '|--------|-------|\n';
  md += `| Dimensions Reviewed | ${reviewed.length}/${ORDERED_DIMS.length}${skippedLabel} |\n`;
  md += `| Findings (rework) | ${allReworkItems.length} |\n`;
  md += `| Observations | ${allObservations.length} |\n`;
  md += `| Highest Severity | ${highestSeverity} |\n`;
  md += `| Verdict | ${verdict} |\n`;
  md += `| CR Repair Rounds | ${new Set(historicalResults.map(item => item.cycle)).size} |\n`;
  md += `| Repaired Findings | ${repairedItems.length} |\n`;
  md += '\n';

  md += '## Dimension Results\n\n';
  md += '| Dim | Name | Result | Rework | Obs |\n';
  md += '|-----|------|--------|--------|-----|\n';
  for (const r of dimResults) {
    md += `| ${r.dimension} | ${r.name} | ${r.result} | ${r.reworkItems.length} | ${r.observations.length} |\n`;
  }
  md += '\n';

  if (allReworkItems.length > 0) {
    md += '## Findings\n\n';
    for (let i = 0; i < allReworkItems.length; i++) {
      const item = allReworkItems[i];
      const severity = normalizeSeverity(item['严重度'] || item.severity || '');
      const id = item.id || item.ID || `CR-${String(i + 1).padStart(3, '0')}`;
      const taskId = item.affected_task_id || item['affected_task_id'] || '';
      const desc = item['问题描述'] || item.description || item.problem || '';
      const suggestion = item['修复建议'] || item.suggestion || item.fix || '';
      const confidence = item['置信度'] || item.confidence || '';

      md += `### #${i + 1} — [${severity}] ${oneLine(desc, 80)}\n\n`;
      md += `- **Dimension**: ${item.dimension.toUpperCase()} (${item.dimName})\n`;
      if (taskId) md += `- **Task**: ${taskId}\n`;
      if (confidence) md += `- **Confidence**: ${confidence}/100\n`;
      md += `- **ID**: ${id}\n`;
      md += '\n';
      md += `**Problem**: ${desc}\n\n`;
      if (suggestion) md += `**Suggestion**: ${suggestion}\n\n`;
      md += '---\n\n';
    }
  }

  if (repairedItems.length > 0) {
    md += '## Repaired Findings History\n\n';
    md += '| Cycle | Dimension | Problem | Repair Status |\n';
    md += '|-------|-----------|---------|---------------|\n';
    for (const item of repairedItems) {
      const desc = item['问题描述'] || item.description || item.problem || '';
      md += `| ${item.cycle} | ${item.dimension} | ${oneLine(desc, 100)} | fixed and re-reviewed |\n`;
    }
    md += '\n';
  }

  if (allObservations.length > 0) {
    md += '## Observations (Non-blocking)\n\n';
    md += '| # | Dim | Description | Confidence |\n';
    md += '|---|-----|-------------|------------|\n';
    for (let i = 0; i < allObservations.length; i++) {
      const item = allObservations[i];
      const desc = item['描述'] || item.description || '';
      const confidence = item['置信度'] || item.confidence || '';
      md += `| ${i + 1} | ${item.dimension.toUpperCase()} | ${oneLine(desc, 100)} | ${confidence} |\n`;
    }
    md += '\n';
  }

  const outPath = join(ideaDir, 'cr', 'review-report.md');
  atomicWriteFile(outPath, md);

  return {
    generated: true,
    path: resolve(outPath),
    findings: allReworkItems.length,
    observations: allObservations.length,
    verdict,
  };
}

function oneLine(text, maxLen = 120) {
  const clean = String(text || '').replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
  if (clean.length <= maxLen) return clean;
  return clean.slice(0, maxLen - 1) + '…';
}

function main() {
  const ideaDir = process.argv[2] ? resolveExistingIdeaDirectory(process.argv[2], process.cwd()) : '';
  if (!ideaDir || !existsSync(ideaDir)) {
    process.stderr.write('Usage: cr-report.mjs <idea-dir>\n');
    process.exit(1);
  }

  const result = generateReport(ideaDir);
  console.log(JSON.stringify(result));
}

export { generateReport, collectDimResults, collectHistoricalDimResults, normalizeSeverity, parseTableSection };

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
