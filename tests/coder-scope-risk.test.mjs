import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkGate } from '../scripts/gate-check.mjs';
import { checkScope } from '../scripts/scope-check.mjs';
import { updateTaskMetrics } from '../scripts/task-metrics.mjs';
import { finishTaskRun, startTaskRun } from '../scripts/task-provenance.mjs';
import { initTaskState, readTaskState, taskStateFile, writeTaskState } from '../scripts/workflow-lib.mjs';

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

describe('coder scope risk semantics', () => {
  let root;
  let ideaDir;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'chisel-scope-risk-'));
    ideaDir = mkdtempSync(join(tmpdir(), 'chisel-scope-control-'));
    mkdirSync(join(root, 'src/secret'), { recursive: true });
    mkdirSync(join(ideaDir, 'tasks'), { recursive: true });
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    writeFileSync(join(root, 'src/start.js'), 'export const start = 1;\n');
    writeFileSync(join(root, 'src/discovered.js'), 'export const discovered = 1;\n');
    writeFileSync(join(root, 'src/secret/key.js'), 'export const key = 1;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'initial');
    writeFileSync(join(ideaDir, 'tasks/task-001.md'), `---
task_id: task-001
starting_points: [src/start.js]
forbidden_files: [src/secret/**]
trace_refs: []
---
## 目标行为

Implement behavior.

### Forbidden Files / Areas

- src/secret/**
`);
    initTaskState(ideaDir, 'feature', [{ taskId: 'task-001', file: 'tasks/task-001.md', expected_files: ['src/start.js'] }]);
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(ideaDir, { recursive: true, force: true });
  });

  it('allows discovered files, records expansion, and auto-generates the task inventory from provenance', () => {
    const run = startTaskRun(ideaDir, 'task-001', { projectRoots: [root] });
    writeFileSync(join(root, 'src/discovered.js'), 'export const discovered = 2;\n');
    finishTaskRun(ideaDir, 'task-001', run.run_id);

    const scope = checkScope(ideaDir, 'task-001', root);
    assert.equal(scope.pass, true);
    assert.equal(scope.violations.length, 0);
    assert.equal(scope.summary.files_outside_starting_points_count, 1);
    assert.equal(scope.scope_warnings[0].type, 'expanded_from_starting_points');

    const originalCwd = process.cwd();
    process.chdir(root);
    try { updateTaskMetrics(ideaDir, 'task-001'); } finally { process.chdir(originalCwd); }
    const report = readFileSync(join(ideaDir, 'task-reports/task-001-report.md'), 'utf8');
    assert.match(report, /report_schema_version: 4/);
    assert.match(report, /src\/discovered\.js \| discovered/);
    assert.doesNotMatch(report, /Invariant Proofs|Traceability Evidence|File-Level Implementation Report/);

    const state = readTaskState(taskStateFile(ideaDir));
    state.tasks['task-001'].status = 'coded';
    writeTaskState(taskStateFile(ideaDir), state);
    const cwd = process.cwd();
    process.chdir(root);
    try { assert.equal(checkGate(ideaDir, 'task-report-exists').pass, true); } finally { process.chdir(cwd); }
  });

  it('still fails on an explicit forbidden path', () => {
    const run = startTaskRun(ideaDir, 'task-001', { projectRoots: [root] });
    writeFileSync(join(root, 'src/secret/key.js'), 'export const key = 2;\n');
    finishTaskRun(ideaDir, 'task-001', run.run_id);
    const scope = checkScope(ideaDir, 'task-001', root);
    assert.equal(scope.pass, false);
    assert.equal(scope.violations[0].type, 'forbidden');
  });
});
