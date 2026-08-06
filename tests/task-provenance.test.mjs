import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildFinishedTaskRun,
  buildStartedTaskRun,
  changedFilesForProject,
  finishTaskRun,
  heartbeatTaskRun,
  previewTaskChanges,
  readTaskRun,
  startTaskRun,
} from '../scripts/task-provenance.mjs';

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

describe('task provenance', () => {
  let root;
  let ideaDir;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'chisel-provenance-'));
    ideaDir = join(root, '.chisel', 'ideas', 'idea');
    mkdirSync(ideaDir, { recursive: true });
    git(root, 'init');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    writeFileSync(join(root, 'a.js'), 'a0\n');
    writeFileSync(join(root, 'b.js'), 'b0\n');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'initial');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('attributes only changes made after the task baseline', () => {
    writeFileSync(join(root, 'a.js'), 'pre-existing\n');
    const attempt = startTaskRun(ideaDir, 'task-001', { projectRoots: [root] });
    writeFileSync(join(root, 'b.js'), 'task change\n');

    const preview = previewTaskChanges(ideaDir, 'task-001');
    assert.deepEqual(preview.repositories[0].changed_files, ['b.js']);
    assert.deepEqual(changedFilesForProject(ideaDir, 'task-001', root), ['b.js']);

    const finished = finishTaskRun(ideaDir, 'task-001', attempt.run_id);
    assert.deepEqual(finished.changed_files, ['b.js']);
  });

  it('attributes files committed during the task', () => {
    const attempt = startTaskRun(ideaDir, 'task-001', { projectRoots: [root] });
    writeFileSync(join(root, 'b.js'), 'committed task change\n');
    git(root, 'add', 'b.js');
    git(root, 'commit', '-m', 'task change');

    assert.deepEqual(finishTaskRun(ideaDir, 'task-001', attempt.run_id).changed_files, ['b.js']);
  });

  it('does not claim a pre-existing dirty file merely because it was committed', () => {
    writeFileSync(join(root, 'a.js'), 'pre-existing\n');
    const attempt = startTaskRun(ideaDir, 'task-001', { projectRoots: [root] });
    git(root, 'add', 'a.js');
    git(root, 'commit', '-m', 'commit pre-existing work');
    assert.deepEqual(finishTaskRun(ideaDir, 'task-001', attempt.run_id).changed_files, []);
  });

  it('creates a new immutable attempt after a finished run', () => {
    const first = startTaskRun(ideaDir, 'task-001', { projectRoots: [root] });
    finishTaskRun(ideaDir, 'task-001', first.run_id);
    const second = startTaskRun(ideaDir, 'task-001', { projectRoots: [root] });
    assert.equal(second.attempt, 2);
  });

  it('leases a task to one owner and lets that owner resume it', () => {
    const first = buildStartedTaskRun(ideaDir, 'task-001', {
      projectRoots: [root], owner: 'agent-a', leaseSeconds: 120, now: '2026-01-01T00:00:00.000Z',
    });
    mkdirSync(join(ideaDir, 'task-runs'), { recursive: true });
    writeFileSync(join(ideaDir, 'task-runs', 'task-001.json'), `${JSON.stringify(first.run)}\n`);
    assert.throws(() => buildStartedTaskRun(ideaDir, 'task-001', {
      projectRoots: [root], owner: 'agent-b', leaseSeconds: 120, now: '2026-01-01T00:01:00.000Z',
    }), /leased by agent-a/);
    const resumed = buildStartedTaskRun(ideaDir, 'task-001', {
      projectRoots: [root], owner: 'agent-a', leaseSeconds: 120, now: '2026-01-01T00:01:00.000Z',
    });
    assert.equal(resumed.resumed, true);
    assert.equal(resumed.attempt.run_id, first.attempt.run_id);
    assert.equal(resumed.attempt.lease_until, '2026-01-01T00:03:00.000Z');
  });

  it('abandons an expired lease before assigning a new run', () => {
    const first = startTaskRun(ideaDir, 'task-001', {
      projectRoots: [root], owner: 'agent-a', leaseSeconds: 60, now: '2026-01-01T00:00:00.000Z',
    });
    const second = startTaskRun(ideaDir, 'task-001', {
      projectRoots: [root], owner: 'agent-b', leaseSeconds: 60, now: '2026-01-01T00:02:00.000Z',
    });
    const run = readTaskRun(ideaDir, 'task-001');
    assert.notEqual(second.run_id, first.run_id);
    assert.equal(run.attempts[0].abandon_reason, 'lease_expired');
    assert.equal(run.attempts[1].owner, 'agent-b');
  });

  it('heartbeats only the owning run and rejects a stale finisher', () => {
    const attempt = startTaskRun(ideaDir, 'task-001', {
      projectRoots: [root], owner: 'agent-a', leaseSeconds: 60, now: '2026-01-01T00:00:00.000Z',
    });
    assert.throws(() => heartbeatTaskRun(ideaDir, 'task-001', 'wrong-id'), /ownership mismatch/);
    const heartbeat = heartbeatTaskRun(ideaDir, 'task-001', attempt.run_id, {
      leaseSeconds: 120, now: '2026-01-01T00:00:30.000Z',
    });
    assert.equal(heartbeat.lease_until, '2026-01-01T00:02:30.000Z');
    assert.throws(() => buildFinishedTaskRun(ideaDir, 'task-001', 'wrong-id'), /ownership mismatch/);
    assert.throws(() => buildFinishedTaskRun(ideaDir, 'task-001', attempt.run_id, { now: '2026-01-01T00:03:00.000Z' }), /lease expired/);
  });
});
