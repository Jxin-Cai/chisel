import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkGate } from '../scripts/gate-check.mjs';
import {
  generateMergeReview,
  recordMergeReviewDecision,
  validateMergeReviewConfirmation,
  validateMergeReviewReport,
} from '../scripts/merge-review.mjs';
import { workspaceIdentity } from '../scripts/verification-lib.mjs';
import { initTaskState } from '../scripts/workflow-lib.mjs';
import { generateReports } from '../scripts/reports.mjs';
import { recordReportConfirmation } from '../scripts/report-confirm.mjs';

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

describe('pre-merge current change report', () => {
  let root;
  let ideaDir;
  let base;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'chisel-merge-review-'));
    ideaDir = join(root, '.chisel', 'idea');
    mkdirSync(ideaDir, { recursive: true });
    git(root, 'init');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Chisel Test');
    writeFileSync(join(root, 'app.js'), 'export const value = 1;\n');
    git(root, 'add', 'app.js');
    git(root, 'commit', '-m', 'initial');
    base = git(root, 'rev-parse', 'HEAD');

    initTaskState(ideaDir, 'idea', [{
      taskId: 'task-001',
      status: 'approved',
      description: 'change exported value',
      changed_files: ['app.js'],
    }]);
    mkdirSync(join(ideaDir, 'tasks'), { recursive: true });
    mkdirSync(join(ideaDir, 'to-be'), { recursive: true });
    writeFileSync(join(ideaDir, 'tasks/task-001.md'), '---\ntask_id: task-001\ntrace_refs: [AC-001]\n---\n# Task\n');
    writeFileSync(join(ideaDir, 'to-be/traceability-matrix.json'), JSON.stringify({
      schema_version: 2,
      items: [{ id: 'AC-001', type: 'acceptance_criteria', description: 'change exported value', covered_by_tasks: ['task-001'] }],
    }));
    writeFileSync(join(ideaDir, 'final-summary.md'), [
      '# Final',
      '## 变更摘要',
      'Changed the exported value.',
      '## Scope Control Summary',
      'scope-check passed; expected file only.',
    ].join('\n'));
    writeFileSync(join(ideaDir, 'worktree-decision.json'), JSON.stringify({
      schema_version: 1,
      base_commit: base,
      repos: [{ path: root, base_commit: base }],
    }));
    writeFileSync(join(root, 'app.js'), 'export const value = 2;\n');
    const identity = workspaceIdentity(root);
    writeFileSync(join(ideaDir, 'verify-result.json'), JSON.stringify({
      schema_version: 2,
      status: 'pass',
      generated_at: new Date().toISOString(),
      repositories: [{
        project_root: root,
        status: 'pass',
        git_head: identity.head,
        workspace_fingerprint: identity.fingerprint,
        checks: [{ id: 'unit', command: 'node', args: ['--test'], status: 'pass', exit_code: 0, duration_ms: 12 }],
      }],
    }));
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function generateCrHtml() {
    return generateReports(ideaDir, ['cr']).generated[0];
  }

  function confirmTaskTimeReport() {
    const generated = generateReports(ideaDir, ['task-time']).generated[0];
    recordReportConfirmation(ideaDir, 'task-time', generated.sha256);
  }

  it('generates a reviewable report and requires explicit approval', () => {
    const report = generateMergeReview(ideaDir, root);

    assert.equal(report.readiness.status, 'ready_for_human_review');
    assert.equal(report.repositories[0].head_commit, base);
    assert.equal(report.repositories[0].files[0].path, 'app.js');
    assert.equal(report.verification.repositories[0].checks[0].id, 'unit');
    assert.equal(validateMergeReviewReport(ideaDir), '');
    assert.match(checkGate(ideaDir, 'merge-review-confirmed').reason, /missing/);
    assert.match(readFileSync(join(ideaDir, 'cr/current-change-report.md'), 'utf8'), /## Human Review Decision/);

    generateCrHtml();
    recordMergeReviewDecision(ideaDir, 'approve', 'reviewed exact snapshot');
    assert.equal(validateMergeReviewConfirmation(ideaDir), '');
    confirmTaskTimeReport();
    assert.equal(checkGate(ideaDir, 'done').pass, true);
  });

  it('does not treat comments or requested changes as merge approval', () => {
    generateMergeReview(ideaDir, root);
    generateCrHtml();
    recordMergeReviewDecision(ideaDir, 'comment', 'please explain compatibility');
    assert.match(validateMergeReviewConfirmation(ideaDir), /decision is comment/);

    recordMergeReviewDecision(ideaDir, 'request_changes', 'add a regression test');
    assert.match(validateMergeReviewConfirmation(ideaDir), /decision is request_changes/);
  });

  it('invalidates approval when the working tree changes', () => {
    generateMergeReview(ideaDir, root);
    generateCrHtml();
    recordMergeReviewDecision(ideaDir, 'approve');
    appendFileSync(join(ideaDir, 'cr/current-change-report.md'), '\nchanged after approval\n');
    assert.match(validateMergeReviewConfirmation(ideaDir), /does not match/);

    generateMergeReview(ideaDir, root);
    generateCrHtml();
    recordMergeReviewDecision(ideaDir, 'approve');
    writeFileSync(join(root, 'app.js'), 'export const value = 3;\n');

    assert.match(validateMergeReviewConfirmation(ideaDir), /working tree changed/);
    assert.equal(checkGate(ideaDir, 'done').pass, false);
  });
});
