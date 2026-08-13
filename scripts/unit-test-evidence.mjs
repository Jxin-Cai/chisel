#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { durableAtomicWrite } from './file-transaction.mjs';
import { PROJECT_MODES, readProjectProfile } from './project-profile.mjs';
import { validateVerificationResult, workspaceIdentity } from './verification-lib.mjs';

const RESULT_FILE = 'unit-test-result.json';
const HISTORY_FILE = 'unit-test-runs.json';

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function sha256File(path) {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : '';
}

function isUnitTestCheck(check = {}) {
  return /(?:^|[-_:])(test|tests|unit|coverage)(?:$|[-_:])/i.test(String(check.id || ''))
    || /(?:test|pytest|jest|vitest|mocha|coverage)/i.test([check.command, ...(check.args || [])].join(' '));
}

function failedTestNames(output = '') {
  const names = [];
  for (const line of String(output).split('\n')) {
    const match = line.match(/^\s*(?:not ok\s+\d+\s+-|FAIL(?:ED)?[:\s]|✗|×)\s*(.+?)\s*$/i);
    if (match?.[1]) names.push(match[1].trim().slice(0, 300));
  }
  return [...new Set(names)];
}

export function appendUnitTestRun(ideaDir, verificationResult) {
  const repositories = (verificationResult.repositories || []).map(repo => {
    const checks = (repo.checks || []).filter(isUnitTestCheck).map(check => ({
      id: check.id,
      status: check.status,
      exit_code: check.exit_code,
      duration_ms: check.duration_ms || 0,
      failed_tests: failedTestNames(check.output),
      output_tail: check.status === 'pass' ? '' : String(check.output || '').slice(-3000),
    }));
    const requirementCaseEvidence = Array.isArray(repo.requirement_case_evidence) ? repo.requirement_case_evidence : [];
    const status = checks.length > 0 && checks.every(check => check.status === 'pass')
      && requirementCaseEvidence.length > 0 && requirementCaseEvidence.every(testCase => testCase.status === 'pass') ? 'pass' : 'fail';
    return { project_root: repo.project_root, status, checks, requirement_case_evidence: requirementCaseEvidence };
  }).filter(repo => repo.checks.length > 0);
  if (repositories.length === 0) return null;

  const path = join(ideaDir, HISTORY_FILE);
  const history = readJson(path, { schema_version: 1, runs: [] });
  if (history.schema_version !== 1 || !Array.isArray(history.runs)) throw new Error(`${HISTORY_FILE} invalid`);
  history.runs.push({
    run: history.runs.length + 1,
    generated_at: verificationResult.generated_at || new Date().toISOString(),
    status: repositories.every(repo => repo.status === 'pass') ? 'pass' : 'fail',
    repositories,
  });
  durableAtomicWrite(path, `${JSON.stringify(history, null, 2)}\n`);
  return history.runs.at(-1);
}

function metric(value) {
  if (value && typeof value === 'object') {
    const total = Number(value.total || 0);
    const covered = Number(value.covered || 0);
    const pct = Number(value.pct ?? (total ? covered / total * 100 : 0));
    return { total, covered, skipped: Number(value.skipped || 0), pct: Number.isFinite(pct) ? pct : 0 };
  }
  return { total: 0, covered: 0, skipped: 0, pct: 0 };
}

function readIstanbulSummary(projectRoot) {
  const candidates = ['coverage/coverage-summary.json', 'coverage-summary.json'];
  for (const rel of candidates) {
    const path = join(projectRoot, rel);
    const doc = readJson(path);
    const total = doc?.total;
    if (!total) continue;
    return {
      source: resolve(path),
      format: 'istanbul-summary',
      lines: metric(total.lines),
      statements: metric(total.statements),
      functions: metric(total.functions),
      branches: metric(total.branches),
    };
  }
  const pythonPath = join(projectRoot, 'coverage.json');
  const python = readJson(pythonPath);
  if (python?.totals) {
    const totals = python.totals;
    const linesTotal = Number(totals.num_statements || 0);
    const linesCovered = Number(totals.covered_lines ?? Math.max(0, linesTotal - Number(totals.missing_lines || 0)));
    const branchTotal = Number(totals.num_branches || 0);
    const branchCovered = Number(totals.covered_branches ?? Math.max(0, branchTotal - Number(totals.missing_branches || 0)));
    return {
      source: resolve(pythonPath), format: 'coverage.py-json',
      lines: metric({ total: linesTotal, covered: linesCovered, pct: totals.percent_covered }),
      statements: metric({ total: linesTotal, covered: linesCovered, pct: totals.percent_covered }),
      functions: metric({}),
      branches: metric({ total: branchTotal, covered: branchCovered, pct: branchTotal ? branchCovered / branchTotal * 100 : 0 }),
    };
  }
  const xmlCandidates = ['coverage.xml', 'target/site/jacoco/jacoco.xml', 'build/reports/jacoco/test/jacocoTestReport.xml'];
  for (const rel of xmlCandidates) {
    const path = join(projectRoot, rel);
    if (!existsSync(path)) continue;
    const xml = readFileSync(path, 'utf8');
    const counters = {};
    for (const match of xml.matchAll(/<counter\s+type="([A-Z]+)"\s+missed="(\d+)"\s+covered="(\d+)"\s*\/>/g)) {
      const [, type, missed, covered] = match;
      counters[type] = metric({ total: Number(missed) + Number(covered), covered: Number(covered) });
    }
    if (Object.keys(counters).length > 0) {
      return {
        source: resolve(path), format: 'jacoco-xml',
        lines: counters.LINE || metric({}),
        statements: counters.INSTRUCTION || counters.LINE || metric({}),
        functions: counters.METHOD || metric({}),
        branches: counters.BRANCH || metric({}),
      };
    }
    const lineRate = Number(xml.match(/line-rate="([0-9.]+)"/)?.[1]);
    const branchRate = Number(xml.match(/branch-rate="([0-9.]+)"/)?.[1]);
    if (Number.isFinite(lineRate)) {
      return {
        source: resolve(path), format: 'cobertura-xml',
        lines: metric({ pct: lineRate * 100 }), statements: metric({ pct: lineRate * 100 }),
        functions: metric({}), branches: metric({ pct: Number.isFinite(branchRate) ? branchRate * 100 : 0 }),
      };
    }
  }
  return null;
}

export function readNodeCoverage(checks = []) {
  for (const check of checks) {
    const output = String(check.output || check.output_tail || '');
    const line = output.split('\n').find(row => /^#?\s*all files\s*\|/i.test(row));
    if (!line) continue;
    const cells = line.replace(/^#\s*/, '').split('|').map(cell => cell.trim());
    const values = cells.slice(1, 4).map(Number);
    if (values.length < 3 || values.some(value => !Number.isFinite(value))) continue;
    return {
      source: 'node --experimental-test-coverage', format: 'node-test-coverage',
      lines: metric({ pct: values[0] }), branches: metric({ pct: values[1] }), functions: metric({ pct: values[2] }), statements: metric({ pct: values[0] }),
    };
  }
  return null;
}

function baseRefFor(ideaDir, projectRoot) {
  const decision = readJson(join(ideaDir, 'worktree-decision.json'));
  const repo = decision?.repos?.find(item => {
    const root = item.worktree_path || item.path || item.repo_path;
    return root && resolve(root) === resolve(projectRoot);
  }) || decision?.repos?.[0];
  return repo?.base_commit || repo?.base_ref || 'HEAD';
}

function changedUnitTests(ideaDir, projectRoot) {
  const lines = [];
  try {
    lines.push(execFileSync('git', ['diff', '--name-status', baseRefFor(ideaDir, projectRoot), '--'], {
      cwd: projectRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }));
  } catch { /* an unborn repository has no HEAD to diff against */ }
  try {
    lines.push(execFileSync('git', ['ls-files', '--others', '--exclude-standard'], {
      cwd: projectRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).split('\n').filter(Boolean).map(file => `??\t${file}`).join('\n'));
  } catch { /* not a Git repository */ }

  // A greenfield baseline has no historical implementation. If its first
  // implementation was already committed, every current tracked test still
  // belongs to this requirement even though `git diff HEAD` is empty.
  if (readProjectProfile(ideaDir).mode === PROJECT_MODES.GREENFIELD) {
    try {
      lines.push(execFileSync('git', ['ls-files'], {
        cwd: projectRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      }).split('\n').filter(Boolean).map(file => `A\t${file}`).join('\n'));
    } catch { /* not a Git repository */ }
  }

  const seen = new Set();
  return lines.join('\n').split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const [status, ...parts] = line.split(/\s+/);
    return { status, file: parts.at(-1) || '' };
  }).filter(item => /(^|\/)(?:test|tests|__tests__)(\/|$)|(?:\.test\.|\.spec\.)/i.test(item.file))
    .filter(item => item.file && !seen.has(item.file) && seen.add(item.file));
}

export function buildUnitTestEvidence(ideaDir, fallbackRoot = '.') {
  const verificationPath = join(ideaDir, 'verify-result.json');
  const verification = readJson(verificationPath);
  const verificationReason = validateVerificationResult(ideaDir, fallbackRoot);
  const history = readJson(join(ideaDir, HISTORY_FILE), { schema_version: 1, runs: [] });
  const anomalies = (history.runs || []).filter(run => run.status === 'fail').flatMap(run =>
    (run.repositories || []).flatMap(repo => [
      ...(repo.checks || []).filter(check => check.status !== 'pass').map(check => ({
        run: run.run, repository: repo.project_root, check: check.id,
        failed_tests: check.failed_tests || [], output_tail: check.output_tail || '', resolved: verificationReason === '',
      })),
      ...(repo.requirement_case_evidence || []).filter(testCase => testCase.status !== 'pass').map(testCase => ({
        run: run.run, repository: repo.project_root, check: `case:${testCase.id || 'unknown'}`,
        failed_tests: [testCase.test_name || testCase.id || 'unknown requirement case'], output_tail: testCase.reason || '', resolved: verificationReason === '',
      })),
    ])
  );
  const repositories = (verification?.repositories || []).map(repo => {
    const root = repo.project_root || fallbackRoot;
    const checks = (repo.checks || []).filter(isUnitTestCheck);
    const identity = workspaceIdentity(root);
    return {
      project_root: resolve(root),
      status: checks.length > 0 && checks.every(check => check.status === 'pass') ? 'pass' : 'fail',
      checks: checks.map(({ id, status, exit_code, duration_ms }) => ({ id, status, exit_code, duration_ms: duration_ms || 0 })),
      coverage: readIstanbulSummary(root) || readNodeCoverage((repo.checks || []).filter(isUnitTestCheck)),
      requirement_unit_tests: changedUnitTests(ideaDir, root),
      requirement_case_evidence: Array.isArray(repo.requirement_case_evidence) ? repo.requirement_case_evidence : [],
      git_head: identity.head || '',
      workspace_fingerprint: identity.fingerprint || '',
    };
  });
  const missingCoverage = repositories.filter(repo => !repo.coverage).map(repo => repo.project_root);
  const noUnitTests = repositories.filter(repo => repo.checks.length === 0).map(repo => repo.project_root);
  const missingCaseEvidence = repositories.filter(repo => repo.requirement_case_evidence.length === 0).map(repo => repo.project_root);
  const failedCaseEvidence = repositories.flatMap(repo => repo.requirement_case_evidence.filter(testCase => testCase.status !== 'pass').map(testCase => `${repo.project_root}:${testCase.id || testCase.test_name || 'unknown'}`));
  const uncoveredTestFiles = repositories.flatMap(repo => {
    const evidenced = new Set(repo.requirement_case_evidence.map(testCase => testCase.test_file));
    return repo.requirement_unit_tests.filter(test => !evidenced.has(test.file)).map(test => `${repo.project_root}:${test.file}`);
  });
  const status = !verificationReason && repositories.length > 0 && missingCoverage.length === 0 && noUnitTests.length === 0
    && missingCaseEvidence.length === 0 && failedCaseEvidence.length === 0 && uncoveredTestFiles.length === 0
    && repositories.every(repo => repo.status === 'pass') ? 'pass' : 'fail';
  const result = {
    schema_version: 1,
    status,
    generated_at: new Date().toISOString(),
    verification_result_sha256: sha256File(verificationPath),
    repositories,
    run_summary: {
      total_runs: (history.runs || []).length,
      failed_runs: (history.runs || []).filter(run => run.status === 'fail').length,
      repair_count: (history.runs || []).filter(run => run.status === 'fail').length,
      anomalies,
    },
    reasons: [
      verificationReason,
      missingCoverage.length ? `coverage summary missing: ${missingCoverage.join(', ')}` : '',
      noUnitTests.length ? `unit test command missing: ${noUnitTests.join(', ')}` : '',
      missingCaseEvidence.length ? `requirement case evidence missing: ${missingCaseEvidence.join(', ')}` : '',
      failedCaseEvidence.length ? `requirement cases did not produce PASS evidence: ${failedCaseEvidence.join(', ')}` : '',
      uncoveredTestFiles.length ? `changed requirement test files lack case evidence: ${uncoveredTestFiles.join(', ')}` : '',
    ].filter(Boolean),
  };
  durableAtomicWrite(join(ideaDir, RESULT_FILE), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

export function validateUnitTestEvidence(ideaDir, fallbackRoot = '.') {
  const path = join(ideaDir, RESULT_FILE);
  const result = readJson(path);
  if (!result) return `${RESULT_FILE} missing or invalid`;
  if (result.schema_version !== 1) return `${RESULT_FILE} schema_version must be 1`;
  if (result.status !== 'pass') return `${RESULT_FILE} status must be pass: ${(result.reasons || []).join('; ')}`;
  if (result.verification_result_sha256 !== sha256File(join(ideaDir, 'verify-result.json'))) return `${RESULT_FILE} is stale: verify-result.json changed`;
  const verificationReason = validateVerificationResult(ideaDir, fallbackRoot);
  if (verificationReason) return verificationReason;
  if (!Array.isArray(result.repositories) || result.repositories.length === 0) return `${RESULT_FILE} repositories must be non-empty`;
  for (const repo of result.repositories) {
    if (!repo.coverage) return `coverage summary missing for ${repo.project_root}`;
    if (!Array.isArray(repo.checks) || repo.checks.length === 0 || repo.checks.some(check => check.status !== 'pass' || check.exit_code !== 0)) return `unit tests did not pass for ${repo.project_root}`;
    if (!Array.isArray(repo.requirement_case_evidence) || repo.requirement_case_evidence.length === 0) return `requirement case evidence missing for ${repo.project_root}`;
    for (const testCase of repo.requirement_case_evidence) {
      if (testCase.status !== 'pass') return `requirement case did not pass: ${testCase.id || testCase.test_name || 'unknown'}`;
      if (!Array.isArray(testCase.trace_refs) || testCase.trace_refs.length === 0) return `requirement case missing trace_refs: ${testCase.id || 'unknown'}`;
      for (const field of ['test_file', 'test_name', 'given', 'when', 'then', 'failure_mode']) if (!String(testCase[field] || '').trim()) return `requirement case missing ${field}: ${testCase.id || 'unknown'}`;
      if (!testCase.evidence?.command || testCase.evidence.exit_code !== 0 || !testCase.evidence.output_excerpt || !testCase.evidence.test_file_sha256) return `requirement case PASS evidence incomplete: ${testCase.id || 'unknown'}`;
    }
    const evidencedFiles = new Set(repo.requirement_case_evidence.map(testCase => testCase.test_file));
    const uncovered = (repo.requirement_unit_tests || []).filter(test => !evidencedFiles.has(test.file));
    if (uncovered.length > 0) return `changed requirement test files lack case evidence: ${uncovered.map(test => test.file).join(', ')}`;
    const current = workspaceIdentity(repo.project_root || fallbackRoot);
    if (current.head !== repo.git_head || current.fingerprint !== repo.workspace_fingerprint) return `${RESULT_FILE} is stale: workspace changed for ${repo.project_root}`;
  }
  return '';
}

function main() {
  const ideaDir = process.argv[2];
  const projectRoot = process.argv[3] || '.';
  if (!ideaDir) {
    process.stderr.write('Usage: unit-test-evidence.mjs <idea-dir> [project-root]\n');
    process.exit(1);
  }
  const result = buildUnitTestEvidence(ideaDir, projectRoot);
  console.log(JSON.stringify(result));
  if (result.status !== 'pass') process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
