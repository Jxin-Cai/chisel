#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFile } from './workflow-lib.mjs';

export const REPORT_CONFIRMATIONS = Object.freeze({
  'as-is': { report: 'reports/as-is-report.html', confirmation: 'confirmations/as-is.json', phase: 'as-is', sources: ['requirement.md', 'as-is/'] },
  'to-be': { report: 'reports/to-be-report.html', confirmation: 'confirmations/to-be.json', phase: 'to-be', sources: ['requirement.md', 'requirement-original.md', 'requirement-inputs.json', 'requirement-clarification.json', 'confirmations/requirement.json', 'to-be/'] },
  test: { report: 'reports/test-report.html', confirmation: 'confirmations/test-report.json', phase: 'unit-test-report', sources: ['verify-result.json', 'unit-test-result.json', 'unit-test-runs.json', 'task-workflow-state.yaml', 'task-reports/'] },
  cr: { report: 'reports/cr-report.html', confirmation: 'confirmations/cr-report.json', phase: 'cr-report', sources: ['task-workflow-state.yaml', 'verify-result.json', 'unit-test-result.json', 'confirmations/test-report.json', 'cr/'] },
  'task-time': { report: 'reports/task-time-report.html', confirmation: 'confirmations/task-time-report.json', phase: 'task-time-report', sources: ['requirement.md', 'requirement-classification.json', 'requirement-clarification.json', 'to-be/', 'workflow-state.yaml', 'task-workflow-state.yaml', 'task-reports/', 'final-summary.md'] },
});

export function fileSha256(path) {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : '';
}

function readJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function filesBelow(path) {
  if (!existsSync(path)) return [];
  if (statSync(path).isFile()) return [path];
  return readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap(entry => filesBelow(join(path, entry.name)));
}

export function reportSourceFingerprint(ideaDir, reportType) {
  const config = REPORT_CONFIRMATIONS[reportType];
  if (!config) throw new Error(`unknown report type: ${reportType}`);
  const hash = createHash('sha256');
  for (const source of config.sources) {
    const path = join(ideaDir, source);
    const files = filesBelow(path);
    if (files.length === 0) hash.update(`${source}\0<missing>\0`);
    for (const file of files) hash.update(`${relative(ideaDir, file)}\0`).update(readFileSync(file)).update('\0');
  }
  return hash.digest('hex');
}

export function reportStatus(ideaDir, reportType) {
  const ready = reportReadyStatus(ideaDir, reportType);
  if (!ready.valid) return ready;
  const config = REPORT_CONFIRMATIONS[reportType];
  const reportPath = join(ideaDir, config.report);
  const confirmationPath = join(ideaDir, config.confirmation);
  const reportSha256 = ready.report_sha256;
  const currentSource = ready.source_fingerprint;
  const confirmation = readJson(confirmationPath);
  if (!confirmation) return {
    valid: false, reason: `${config.confirmation} missing or invalid`, report_type: reportType,
    report_file: config.report, report_sha256: reportSha256,
  };
  if (confirmation.schema_version !== 1 || confirmation.phase !== config.phase || confirmation.status !== 'confirmed') {
    return { valid: false, reason: `${config.confirmation} invalid report confirmation schema`, report_type: reportType, report_file: config.report, report_sha256: reportSha256 };
  }
  if (confirmation.confirmed_by !== 'user') return { valid: false, reason: `${config.confirmation} confirmed_by must be user`, report_type: reportType, report_file: config.report, report_sha256: reportSha256 };
  if (!Number.isFinite(Date.parse(confirmation.confirmed_at))) return { valid: false, reason: `${config.confirmation} confirmed_at must be ISO-8601`, report_type: reportType, report_file: config.report, report_sha256: reportSha256 };
  if (confirmation.report_file !== config.report) return { valid: false, reason: `${config.confirmation} report_file must be ${config.report}`, report_type: reportType, report_file: config.report, report_sha256: reportSha256 };
  if (confirmation.report_sha256 !== reportSha256) return { valid: false, reason: `${config.confirmation} is stale: report changed`, report_type: reportType, report_file: config.report, report_sha256: reportSha256 };
  if (confirmation.source_fingerprint !== currentSource) return { valid: false, reason: `${config.confirmation} is stale: source artifacts changed`, report_type: reportType, report_file: config.report, report_sha256: reportSha256 };
  return { valid: true, report_type: reportType, report_file: config.report, report_sha256: reportSha256, confirmation_file: config.confirmation };
}

// Non-decision reports are delivery artifacts, not workflow decisions.  This
// validates that the rendered HTML exists and is bound to the current source
// artifacts without requiring a user-authored confirmation record.
export function reportReadyStatus(ideaDir, reportType) {
  const config = REPORT_CONFIRMATIONS[reportType];
  if (!config) return { valid: false, reason: `unknown report type: ${reportType}` };
  const reportPath = join(ideaDir, config.report);
  if (!existsSync(reportPath)) return { valid: false, reason: `${config.report} missing`, report_type: reportType };
  const reportSha256 = fileSha256(reportPath);
  const reportHtml = readFileSync(reportPath, 'utf8');
  const embeddedSource = reportHtml.match(/<!-- report-source:([a-f0-9]{64}) -->/)?.[1] || '';
  const currentSource = reportSourceFingerprint(ideaDir, reportType);
  if (!embeddedSource || embeddedSource !== currentSource) {
    return { valid: false, reason: `${config.report} is stale: source artifacts changed`, report_type: reportType, report_file: config.report, report_sha256: reportSha256 };
  }
  return { valid: true, report_type: reportType, report_file: config.report, report_sha256: reportSha256, source_fingerprint: currentSource };
}

export function recordReportConfirmation(ideaDir, reportType, expectedSha256, comment = '') {
  const config = REPORT_CONFIRMATIONS[reportType];
  if (!config) throw new Error(`unknown report type: ${reportType}`);
  const reportPath = join(ideaDir, config.report);
  if (!existsSync(reportPath)) throw new Error(`${config.report} missing`);
  const actualSha256 = fileSha256(reportPath);
  if (!expectedSha256) throw new Error('--expected-sha is required; confirmation must bind to the link shown to the user');
  if (expectedSha256 !== actualSha256) throw new Error(`report changed before confirmation: expected ${expectedSha256}, actual ${actualSha256}`);
  const sourceFingerprint = reportSourceFingerprint(ideaDir, reportType);
  const embeddedSource = readFileSync(reportPath, 'utf8').match(/<!-- report-source:([a-f0-9]{64}) -->/)?.[1] || '';
  if (embeddedSource !== sourceFingerprint) throw new Error('report source artifacts changed; regenerate the report before confirmation');
  const confirmationPath = join(ideaDir, config.confirmation);
  const existing = readJson(confirmationPath) || {};
  const confirmation = {
    ...existing,
    schema_version: 1,
    phase: config.phase,
    status: 'confirmed',
    confirmed_by: 'user',
    confirmed_at: new Date().toISOString(),
    report_file: config.report,
    report_sha256: actualSha256,
    source_fingerprint: sourceFingerprint,
    report_comment: String(comment || ''),
  };
  atomicWriteFile(confirmationPath, `${JSON.stringify(confirmation, null, 2)}\n`);
  return { ...confirmation, confirmation_file: resolve(confirmationPath) };
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function main() {
  const args = process.argv.slice(2);
  const ideaDir = args[0];
  const reportType = args[1];
  if (!ideaDir || !REPORT_CONFIRMATIONS[reportType]) {
    process.stderr.write('用法: report-confirm.mjs <idea-dir> <as-is|to-be|test|cr|task-time> [--confirm --expected-sha <sha256>] [--comment text]\n');
    process.exit(1);
  }
  try {
    const result = args.includes('--confirm')
      ? recordReportConfirmation(resolve(ideaDir), reportType, option(args, '--expected-sha'), option(args, '--comment') || '')
      : reportStatus(resolve(ideaDir), reportType);
    console.log(JSON.stringify(result, null, 2));
    if (!args.includes('--confirm') && !result.valid) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exit(2);
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) main();
