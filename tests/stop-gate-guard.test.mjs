import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evaluateStop, findActiveWorkflows } from '../hooks/stop-gate-guard.mjs';
import { initTaskState } from '../scripts/workflow-lib.mjs';

function workflow(root, name, step) {
  const dir = join(root, '.chisel', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'workflow-state.yaml'), `idea: ${name}\ncurrent_step: ${step}\nrevision: 0\n`);
  return dir;
}

describe('Stop gate guard', () => {
  let root;
  beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'chisel-stop-')); });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('enumerates every active workflow instead of selecting the first', () => {
    workflow(root, 'a-human', 'clarify:requirement');
    workflow(root, 'b-auto', 'receive-requirement');
    assert.equal(findActiveWorkflows(join(root, '.chisel')).length, 2);
    const result = evaluateStop(join(root, '.chisel'), { projectRoot: root });
    assert.equal(result.blockers.length, 1);
    assert.match(result.blockers[0], /b-auto/);
  });

  it('allows human decision steps to yield', () => {
    workflow(root, 'idea', 'plan:confirm');
    assert.deepEqual(evaluateStop(join(root, '.chisel'), { projectRoot: root }).blockers, []);
  });

  it('does not recursively block the retry turn', () => {
    workflow(root, 'idea', 'receive-requirement');
    const result = evaluateStop(join(root, '.chisel'), { projectRoot: root, stopHookActive: true });
    assert.equal(result.recursive_retry, true);
    assert.deepEqual(result.blockers, []);
  });

  it('prioritizes joining live coding Agents over an incomplete implementation gate', () => {
    const ideaDir = workflow(root, 'idea', 'implement:code');
    initTaskState(ideaDir, 'idea', [
      { taskId: 'task-005', status: 'coding' },
      { taskId: 'task-006', status: 'coding' },
    ]);
    const result = evaluateStop(join(root, '.chisel'), { projectRoot: root });
    assert.equal(result.blockers.length, 1);
    assert.match(result.blockers[0], /task-005, task-006 still have live coding leases/);
    assert.match(result.blockers[0], /TaskOutput\(task_id, block: true\)/);
    assert.doesNotMatch(result.blockers[0], /implementation-verified/);
  });

  it('keeps a recursive Stop retry alive while coding Agents still have live leases', () => {
    const ideaDir = workflow(root, 'idea', 'implement:code');
    initTaskState(ideaDir, 'idea', [{ taskId: 'task-005', status: 'coding' }]);
    const result = evaluateStop(join(root, '.chisel'), { projectRoot: root, stopHookActive: true });
    assert.equal(result.recursive_retry, true);
    assert.match(result.blockers[0], /do not yield/);
  });

  it('allows a recursive Stop retry when the coding lease has expired', () => {
    const ideaDir = workflow(root, 'idea', 'implement:code');
    initTaskState(ideaDir, 'idea', [{ taskId: 'task-005', status: 'coding' }]);
    mkdirSync(join(ideaDir, 'task-runs'), { recursive: true });
    writeFileSync(join(ideaDir, 'task-runs', 'task-005.json'), JSON.stringify({
      attempts: [{ run_id: 'run-1', lease_until: '2000-01-01T00:00:00.000Z' }],
    }));
    const result = evaluateStop(join(root, '.chisel'), { projectRoot: root, stopHookActive: true });
    assert.deepEqual(result.blockers, []);
  });

  it('fails closed when an automated gate is incomplete', () => {
    workflow(root, 'idea', 'receive-requirement');
    const result = evaluateStop(join(root, '.chisel'), { projectRoot: root });
    assert.match(result.blockers[0], /requirement-exists.*failed/);
  });

  it('emits the Claude Stop decision contract from the command entrypoint', () => {
    workflow(root, 'idea', 'receive-requirement');
    const result = spawnSync('node', [join(process.cwd(), 'hooks/stop-gate-guard.mjs')], {
      input: JSON.stringify({ cwd: root, hook_event_name: 'Stop', stop_hook_active: false }),
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.decision, 'block');
    assert.match(output.reason, /requirement-exists/);
  });
});
