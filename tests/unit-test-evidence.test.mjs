import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { appendUnitTestRun, buildUnitTestEvidence, readNodeCoverage, validateUnitTestEvidence } from '../scripts/unit-test-evidence.mjs';
import { workspaceIdentity } from '../scripts/verification-lib.mjs';

describe('unit-test coverage evidence', () => {
  let root;
  let ideaDir;

  function caseEvidence(testFile, { id = 'CASE-001', name = 'implements the required behavior', traceRefs = ['AC-001'] } = {}) {
    return {
      id, test_file: testFile, test_name: name, trace_refs: traceRefs,
      given: 'a valid requirement input', when: 'the feature is executed', then: 'the observable requirement result is returned',
      failure_mode: 'a missing or incorrect feature result', check_id: 'test', pass_evidence: `ok 1 - ${name}`, status: 'pass',
      evidence: { command: 'node --test', exit_code: 0, duration_ms: 12, output_excerpt: `ok 1 - ${name}`, test_file_sha256: 'current-file-hash' },
    };
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'chisel-unit-evidence-repo-'));
    ideaDir = mkdtempSync(join(tmpdir(), 'chisel-unit-evidence-idea-'));
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    mkdirSync(join(root, 'tests'));
    writeFileSync(join(root, 'tests/base.test.mjs'), 'export const base = true;\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'base'], { cwd: root });
    writeFileSync(join(root, 'tests/requirement.test.mjs'), 'export const requirement = true;\n');
    mkdirSync(join(root, 'coverage'));
    writeFileSync(join(root, 'coverage/coverage-summary.json'), JSON.stringify({
      total: {
        lines: { total: 100, covered: 92, skipped: 0, pct: 92 },
        statements: { total: 100, covered: 91, skipped: 0, pct: 91 },
        functions: { total: 20, covered: 18, skipped: 0, pct: 90 },
        branches: { total: 30, covered: 25, skipped: 0, pct: 83.33 },
      },
    }));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(ideaDir, { recursive: true, force: true });
  });

  it('collects failed runs, changed requirement tests, coverage, and repair count', () => {
    const identity = workspaceIdentity(root);
    const failed = {
      schema_version: 2, status: 'fail', generated_at: '2026-08-11T00:00:00Z',
      repositories: [{ project_root: root, status: 'fail', git_head: identity.head, workspace_fingerprint: identity.fingerprint, checks: [{ id: 'test', status: 'fail', exit_code: 1, output: 'not ok 1 - rejects invalid input' }] }],
    };
    appendUnitTestRun(ideaDir, failed);
    const passed = {
      schema_version: 2, status: 'pass', generated_at: '2026-08-11T00:01:00Z',
      repositories: [{ project_root: root, status: 'pass', git_head: identity.head, workspace_fingerprint: identity.fingerprint, checks: [{ id: 'test', status: 'pass', exit_code: 0, output: 'ok 1 - rejects invalid input' }], requirement_case_evidence: [caseEvidence('tests/requirement.test.mjs', { name: 'rejects invalid input' })] }],
    };
    writeFileSync(join(ideaDir, 'verify-result.json'), `${JSON.stringify(passed, null, 2)}\n`);
    appendUnitTestRun(ideaDir, passed);

    const result = buildUnitTestEvidence(ideaDir, root);
    assert.equal(result.status, 'pass');
    assert.equal(result.run_summary.repair_count, 1);
    assert.equal(result.run_summary.anomalies[0].failed_tests[0], 'rejects invalid input');
    assert.equal(result.repositories[0].coverage.lines.pct, 92);
    assert.deepEqual(result.repositories[0].requirement_unit_tests, [{ status: '??', file: 'tests/requirement.test.mjs' }]);
    assert.equal(validateUnitTestEvidence(ideaDir, root), '');
    const history = JSON.parse(readFileSync(join(ideaDir, 'unit-test-runs.json'), 'utf8'));
    assert.equal(history.runs.length, 2);
    assert.equal(history.runs[1].repositories[0].requirement_case_evidence[0].evidence.output_excerpt, 'ok 1 - rejects invalid input');
  });

  it('collects untracked tests from a greenfield repository with no commits', () => {
    rmSync(root, { recursive: true, force: true });
    mkdirSync(root);
    execFileSync('git', ['init', '-q'], { cwd: root });
    mkdirSync(join(root, 'tests'));
    writeFileSync(join(root, 'tests/first-feature.test.mjs'), 'export const firstFeature = true;\n');
    mkdirSync(join(root, 'coverage'));
    writeFileSync(join(root, 'coverage/coverage-summary.json'), JSON.stringify({
      total: {
        lines: { pct: 100 }, statements: { pct: 100 }, functions: { pct: 100 }, branches: { pct: 100 },
      },
    }));
    const identity = workspaceIdentity(root);
    writeFileSync(join(ideaDir, 'verify-result.json'), JSON.stringify({
      schema_version: 2, status: 'pass', generated_at: '2026-08-11T00:01:00Z',
      repositories: [{ project_root: root, status: 'pass', git_head: identity.head, workspace_fingerprint: identity.fingerprint, checks: [{ id: 'test', status: 'pass', exit_code: 0 }], requirement_case_evidence: [caseEvidence('tests/first-feature.test.mjs')] }],
    }));

    const result = buildUnitTestEvidence(ideaDir, root);
    assert.deepEqual(result.repositories[0].requirement_unit_tests, [{ status: '??', file: 'tests/first-feature.test.mjs' }]);
  });

  it('collects committed tests when the recorded project baseline is greenfield', () => {
    mkdirSync(join(ideaDir, 'as-is'), { recursive: true });
    writeFileSync(join(ideaDir, 'as-is/repo-map.json'), JSON.stringify({
      schema_version: 4, project_mode: 'greenfield', stats: { source_files: 0 },
    }));
    execFileSync('git', ['add', 'tests/requirement.test.mjs'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'first implementation'], { cwd: root });
    const identity = workspaceIdentity(root);
    writeFileSync(join(ideaDir, 'verify-result.json'), JSON.stringify({
      schema_version: 2, status: 'pass', generated_at: '2026-08-11T00:01:00Z',
      repositories: [{ project_root: root, status: 'pass', git_head: identity.head, workspace_fingerprint: identity.fingerprint, checks: [{ id: 'test', status: 'pass', exit_code: 0 }], requirement_case_evidence: [caseEvidence('tests/base.test.mjs'), caseEvidence('tests/requirement.test.mjs', { id: 'CASE-002' })] }],
    }));

    const tests = buildUnitTestEvidence(ideaDir, root).repositories[0].requirement_unit_tests;
    assert.deepEqual(tests, [
      { status: 'A', file: 'tests/base.test.mjs' },
      { status: 'A', file: 'tests/requirement.test.mjs' },
    ]);
  });

  it('fails closed when no coverage summary exists', () => {
    rmSync(join(root, 'coverage'), { recursive: true, force: true });
    const identity = workspaceIdentity(root);
    const passed = { schema_version: 2, status: 'pass', generated_at: '2026-08-11T00:01:00Z', repositories: [{ project_root: root, status: 'pass', git_head: identity.head, workspace_fingerprint: identity.fingerprint, checks: [{ id: 'test', status: 'pass', exit_code: 0 }], requirement_case_evidence: [caseEvidence('tests/requirement.test.mjs')] }] };
    writeFileSync(join(ideaDir, 'verify-result.json'), JSON.stringify(passed));
    const result = buildUnitTestEvidence(ideaDir, root);
    assert.equal(result.status, 'fail');
    assert.match(result.reasons.join(' '), /coverage summary missing/);
  });

  it('parses Node built-in test coverage output', () => {
    const coverage = readNodeCoverage([{ output: '# all files | 91.2 | 82.3 | 88.4 |' }]);
    assert.equal(coverage.lines.pct, 91.2);
    assert.equal(coverage.branches.pct, 82.3);
    assert.equal(coverage.functions.pct, 88.4);
  });

  it('fails closed when a changed test has no requirement-level PASS evidence', () => {
    const identity = workspaceIdentity(root);
    writeFileSync(join(ideaDir, 'verify-result.json'), JSON.stringify({
      schema_version: 2, status: 'pass', generated_at: '2026-08-11T00:01:00Z',
      repositories: [{ project_root: root, status: 'pass', git_head: identity.head, workspace_fingerprint: identity.fingerprint, checks: [{ id: 'test', status: 'pass', exit_code: 0 }], requirement_case_evidence: [] }],
    }));
    const result = buildUnitTestEvidence(ideaDir, root);
    assert.equal(result.status, 'fail');
    assert.match(result.reasons.join(' '), /requirement case evidence missing/);
  });
});
