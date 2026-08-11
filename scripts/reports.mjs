#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFile } from './workflow-lib.mjs';
import { REPORT_SECTIONS, loadData } from './report-renderers.mjs';
import { fileSha256, reportSourceFingerprint, reportStatus } from './report-confirm.mjs';
import { recordDuration } from './session-metrics.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const assetDir = join(scriptDir, 'assets');
const styles = readFileSync(join(assetDir, 'report-styles.css'), 'utf8');

export const REPORTS = Object.freeze({
  'as-is': { file: 'as-is-report.html', template: 'as-is-report-template.html', blocks: ['as-is'] },
  'to-be': { file: 'to-be-report.html', template: 'to-be-report-template.html', blocks: ['to-be'] },
  cr: { file: 'cr-report.html', template: 'cr-report-template.html', blocks: ['cr-results', 'current-change'] },
  'task-time': { file: 'task-time-report.html', template: 'task-time-report-template.html', blocks: ['overview', 'progress', 'timeline'] },
});

function esc(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function themeToggle() {
  return `<button class="theme-toggle" type="button" aria-label="切换明暗主题" onclick="var h=document.documentElement;h.dataset.theme=h.dataset.theme==='dark'?'light':'dark'">
  <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"/></svg></button>`;
}

export function renderReport(reportName, data, sourceFingerprint) {
  const report = REPORTS[reportName];
  if (!report) throw new Error(`未知报告: ${reportName}`);
  const sections = report.blocks.map((block, index) => {
    const body = REPORT_SECTIONS[block](data);
    if (report.blocks.length === 1) return body;
    const labels = { overview: '工作总览', progress: 'Task 执行情况', timeline: '阶段产出与耗时', 'cr-results': '自动审查结果', 'current-change': '合并前当前变更' };
    return `${index ? `<div class="report-section-label">${labels[block]}</div>` : ''}${body}`;
  }).join('\n');
  return readFileSync(join(assetDir, report.template), 'utf8')
    .replace('<!doctype html>', `<!doctype html><!-- report-generation:${randomUUID()} --><!-- report-source:${sourceFingerprint} -->`)
    .replaceAll('{{IDEA_NAME}}', esc(data.ideaName))
    .replace('{{GENERATED_AT}}', esc(new Date().toISOString()))
    .replace('{{STYLES}}', styles)
    .replace('{{BODY_HTML}}', sections)
    .replace('{{THEME_TOGGLE}}', themeToggle());
}

export function generateReports(ideaDir, requested) {
  const startedAt = Date.now();
  if (!ideaDir || !existsSync(ideaDir)) throw new Error(`idea-dir 不存在: ${ideaDir || '(empty)'}`);
  if (!Array.isArray(requested) || requested.length !== 1) throw new Error('每次必须且只能生成一份报告；确认后再生成下一份');
  const unknown = requested.filter(name => !REPORTS[name]);
  if (unknown.length) throw new Error(`未知报告: ${unknown.join(', ')}`);
  const outDir = join(ideaDir, 'reports');
  mkdirSync(outDir, { recursive: true });
  const data = loadData(ideaDir);
  const generated = requested.map(name => {
    const path = join(outDir, REPORTS[name].file);
    atomicWriteFile(path, renderReport(name, data, reportSourceFingerprint(ideaDir, name)));
    const status = reportStatus(ideaDir, name);
    return {
      report_type: name,
      path: resolve(path),
      sha256: fileSha256(path),
      confirmation_required: true,
      confirmed: status.valid,
      confirmation_file: status.confirmation_file || null,
    };
  });
  const result = { dir: resolve(outDir), generated };
  try { recordDuration(ideaDir, 'report_generation', requested[0], Date.now() - startedAt, { output: generated[0]?.path || '' }); } catch { /* metrics are non-critical */ }
  return result;
}

function main() {
  const args = process.argv.slice(2);
  const ideaDir = args[0];
  const reportsIndex = args.indexOf('--reports');
  const requested = reportsIndex >= 0 ? String(args[reportsIndex + 1] || '').split(',').map(v => v.trim()).filter(Boolean) : [];
  if (!ideaDir) {
    process.stderr.write('用法: reports.mjs <idea-dir> --reports <as-is|to-be|cr|task-time>（一次一份，确认后再继续）\n');
    process.exit(1);
  }
  try {
    console.log(JSON.stringify(generateReports(ideaDir, requested)));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) main();
