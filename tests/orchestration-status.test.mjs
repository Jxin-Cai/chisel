import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initTaskState, initWorkflowState } from '../scripts/workflow-lib.mjs';

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'chisel-orchestration-'));
}

function writeTrivialRequirement(ideaDir) {
  writeFileSync(join(ideaDir, 'requirement.md'), [
    '# Req',
    '## 复杂度: trivial',
    '## 涉及范围',
    '- src/a.js',
    '- src/b.js',
    '实现一个小改动'
  ].join('\n'));
}

function writeTrivialClarification(ideaDir) {
  writeFileSync(join(ideaDir, 'requirement-clarification.json'), JSON.stringify({
    schema_version: 1,
    source_step: 'clarify:requirement',
    clarified_at: '2026-01-01T00:00:00Z',
    dimensions: {
      functional_scope: { in_scope: ['src/a.js'] },
      acceptance_criteria: ['AC-001: works']
    }
  }));
}

function runOrchestration(ideaDir) {
  return spawnSync('node', ['scripts/orchestration-status.mjs', ideaDir], {
    cwd: process.cwd(),
    encoding: 'utf8'
  });
}

describe('orchestration review recovery', () => {
  let ideaDir;

  beforeEach(() => {
    ideaDir = makeTmpDir();
    writeTrivialRequirement(ideaDir);
    writeTrivialClarification(ideaDir);
  });

  afterEach(() => {
    rmSync(ideaDir, { recursive: true, force: true });
  });

  it('resumes trivial workflow from reviewing task', () => {
    initTaskState(ideaDir, 'idea', [
      { taskId: 'task-002', status: 'reviewing' }
    ]);

    const result = runOrchestration(ideaDir);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /resume_step: review:cr-light/);
    assert.match(result.stdout, /next_tasks: task-002/);
    assert.doesNotMatch(result.stdout, /no executable next step found/);
  });

  it('prioritizes review recovery before coding new tasks', () => {
    initTaskState(ideaDir, 'idea', [
      { taskId: 'task-001', status: 'confirmed' },
      { taskId: 'task-002', status: 'reviewing' }
    ]);

    const result = runOrchestration(ideaDir);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /resume_step: review:cr-light/);
    assert.match(result.stdout, /next_tasks: task-002/);
  });

  it('resumes trivial workflow from coding task before it is stale', () => {
    initTaskState(ideaDir, 'idea', [
      { taskId: 'task-001', status: 'coding' }
    ]);

    const result = runOrchestration(ideaDir);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /resume_step: implement:code/);
    assert.match(result.stdout, /in_progress_tasks: task-001/);
    assert.doesNotMatch(result.stdout, /no executable next step found/);
  });

  it('resumes trivial workflow from repairing task before it is stale', () => {
    initTaskState(ideaDir, 'idea', [
      { taskId: 'task-001', status: 'repairing' }
    ]);

    const result = runOrchestration(ideaDir);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /resume_step: repair:code/);
    assert.match(result.stdout, /in_progress_tasks: task-001/);
    assert.doesNotMatch(result.stdout, /no executable next step found/);
  });

  it('is side-effect-free when queried repeatedly', () => {
    initWorkflowState(ideaDir, 'idea');
    initTaskState(ideaDir, 'idea', [
      { taskId: 'task-001', status: 'reviewing' }
    ]);
    const statePath = join(ideaDir, 'workflow-state.yaml');
    const before = readFileSync(statePath, 'utf8');
    runOrchestration(ideaDir);
    runOrchestration(ideaDir);
    assert.equal(readFileSync(statePath, 'utf8'), before);
    assert.equal(existsSync(join(ideaDir, 'metrics.json')), false);
    assert.equal(existsSync(join(ideaDir, 'dashboard.html')), false);
    assert.equal(existsSync(join(ideaDir, 'snapshots')), false);
  });
});
