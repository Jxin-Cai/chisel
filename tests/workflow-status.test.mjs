import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  getReviewBacklogTasks,
  initTaskState,
  initWorkflowState,
  parseWorkflowStepHistory,
  readTaskState,
  taskStateFile,
  updateWorkflowPhase
} from '../scripts/workflow-lib.mjs';

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'chisel-workflow-'));
}

function runWorkflowStatus(ideaDir, ...args) {
  return spawnSync('node', ['scripts/workflow-status.mjs', ideaDir, ...args], {
    cwd: process.cwd(),
    encoding: 'utf8'
  });
}

describe('workflow review recovery', () => {
  let ideaDir;

  beforeEach(() => {
    ideaDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(ideaDir, { recursive: true, force: true });
  });

  it('returns reviewing tasks as review backlog', () => {
    initTaskState(ideaDir, 'idea', [
      { taskId: 'task-001', status: 'reviewing' },
      { taskId: 'task-002', status: 'confirmed' }
    ]);

    assert.deepEqual(getReviewBacklogTasks(ideaDir), ['task-001']);
  });

  it('returns reviewing tasks before coded tasks', () => {
    initTaskState(ideaDir, 'idea', [
      { taskId: 'task-001', status: 'coded' },
      { taskId: 'task-002', status: 'reviewing' }
    ]);

    assert.deepEqual(getReviewBacklogTasks(ideaDir), ['task-002', 'task-001']);
  });

  it('includes reviewing tasks in --next-tasks review', () => {
    initTaskState(ideaDir, 'idea', [
      { taskId: 'task-001', status: 'reviewing' }
    ]);

    const result = runWorkflowStatus(ideaDir, '--next-tasks', 'review');

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { next_tasks: ['task-001'] });
  });

  it('keeps --start-review idempotent for reviewing tasks', () => {
    initTaskState(ideaDir, 'idea', [
      { taskId: 'task-001', status: 'reviewing' }
    ]);

    const result = runWorkflowStatus(ideaDir, '--start-review', 'task-001');

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { updated: true, task_id: 'task-001', status: 'reviewing' });
    assert.equal(readTaskState(taskStateFile(ideaDir)).tasks['task-001'].status, 'reviewing');
  });

  it('keeps --start-task idempotent for repairing tasks', () => {
    initTaskState(ideaDir, 'idea', [
      { taskId: 'task-001', status: 'repairing' }
    ]);

    const result = runWorkflowStatus(ideaDir, '--start-task', 'task-001');

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { updated: true, task_id: 'task-001', status: 'repairing' });
    assert.equal(readTaskState(taskStateFile(ideaDir)).tasks['task-001'].status, 'repairing');
  });
});

describe('workflow step timing', () => {
  let ideaDir;

  beforeEach(() => {
    ideaDir = makeTmpDir();
  });

  afterEach(() => {
    rmSync(ideaDir, { recursive: true, force: true });
  });

  function readWorkflowText() {
    return readFileSync(join(ideaDir, 'workflow-state.yaml'), 'utf8');
  }

  it('does not append duplicate history for repeated same step updates', () => {
    initWorkflowState(ideaDir, 'idea');

    updateWorkflowPhase(ideaDir, 'receive-requirement');
    updateWorkflowPhase(ideaDir, 'receive-requirement');

    const history = parseWorkflowStepHistory(readWorkflowText());
    assert.equal(history.length, 1);
    assert.equal(history[0].step, 'receive-requirement');
    assert.equal(history[0].exited_at, undefined);
  });

  it('closes the previous step when entering a different step', () => {
    initWorkflowState(ideaDir, 'idea');

    updateWorkflowPhase(ideaDir, 'receive-requirement');
    updateWorkflowPhase(ideaDir, 'clarify:requirement');

    const history = parseWorkflowStepHistory(readWorkflowText());
    assert.equal(history.length, 2);
    assert.equal(history[0].step, 'receive-requirement');
    assert.match(history[0].exited_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(typeof history[0].duration_ms, 'number');
    assert.ok(history[0].duration_ms >= 0);
    assert.equal(history[1].step, 'clarify:requirement');
    assert.equal(history[1].exited_at, undefined);
  });
});
