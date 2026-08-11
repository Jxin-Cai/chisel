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
      repositories: [{ project_root: root, status: 'pass', git_head: identity.head, workspace_fingerprint: identity.fingerprint, checks: [{ id: 'test', status: 'pass', exit_code: 0, output: 'ok 1 - rejects invalid input' }] }],
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
    assert.equal(JSON.parse(readFileSync(join(ideaDir, 'unit-test-runs.json'), 'utf8')).runs.length, 2);
  });

  it('fails closed when no coverage summary exists', () => {
    rmSync(join(root, 'coverage'), { recursive: true, force: true });
    const identity = workspaceIdentity(root);
    const passed = { schema_version: 2, status: 'pass', generated_at: '2026-08-11T00:01:00Z', repositories: [{ project_root: root, status: 'pass', git_head: identity.head, workspace_fingerprint: identity.fingerprint, checks: [{ id: 'test', status: 'pass', exit_code: 0 }] }] };
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
});
