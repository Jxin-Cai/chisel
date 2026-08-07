import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { controlRoot } from '../scripts/control-plane.mjs';
import { classifyChange, getStaleCodingTasks, initTaskState, readTaskState, taskStateFile } from '../scripts/workflow-lib.mjs';
import { planReview } from '../scripts/review-budget.mjs';

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

describe('long-running resilience', () => {
  let root;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'chisel-resilience-'));
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    writeFileSync(join(root, 'app.js'), 'export const value = 1;\n');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'initial');
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('uses one control plane across the main checkout and linked worktrees', () => {
    const worktree = join(root, 'linked-worktree');
    git(root, 'worktree', 'add', '-q', '-b', 'test-worktree', worktree);
    assert.equal(controlRoot(worktree), controlRoot(root));
  });

  it('persists a runner lease and rejects a concurrent owner', () => {
    const ideaDir = join(root, '.chisel', 'idea');
    const first = spawnSync('node', ['scripts/orchestration-runner.mjs', '--start', '--idea-dir', ideaDir, '--owner', 'agent-a'], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    const second = spawnSync('node', ['scripts/orchestration-runner.mjs', '--next', '--idea-dir', ideaDir, '--owner', 'agent-b'], { cwd: process.cwd(), encoding: 'utf8' });
    assert.notEqual(second.status, 0);
    assert.match(second.stderr, /leased by agent-a/);
    assert.ok(existsSync(join(ideaDir, 'runner-state.json')));
  });

  it('returns the completed phase files when the runner advances', () => {
    const ideaDir = join(root, '.chisel', 'delivery');
    const first = spawnSync('node', ['scripts/orchestration-runner.mjs', '--start', '--idea-dir', ideaDir, '--owner', 'agent-a'], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    writeFileSync(join(ideaDir, 'requirement.md'), '# Req\n## 复杂度: trivial\n## 目标\n实现小改动\n');
    const next = spawnSync('node', ['scripts/orchestration-runner.mjs', '--next', '--idea-dir', ideaDir, '--owner', 'agent-a'], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(next.status, 0, next.stderr);
    const output = JSON.parse(next.stdout);
    assert.equal(output.completed_step_delivery.step, 'receive-requirement');
    assert.equal(output.completed_step_delivery.artifacts[0].label, 'requirement.md');
    assert.match(output.completed_step_delivery.markdown, /\[requirement\.md\]\(<\//);
  });

  it('rolls a crashed task start transaction forward without duplicating the run', () => {
    const ideaDir = join(root, '.chisel', 'idea');
    mkdirSync(ideaDir, { recursive: true });
    initTaskState(ideaDir, 'idea', [{ taskId: 'task-001', status: 'confirmed' }]);
    const command = ['scripts/workflow-status.mjs', ideaDir, '--start-task', 'task-001', '--project-root', root, '--owner', 'agent-a'];
    const failed = spawnSync('node', command, { cwd: process.cwd(), encoding: 'utf8', env: { ...process.env, CHISEL_TX_FAIL_AFTER_WRITES: '1' } });
    assert.notEqual(failed.status, 0);
    assert.equal(readTaskState(taskStateFile(ideaDir)).tasks['task-001'].status, 'confirmed');
    const recovered = spawnSync('node', command, { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(recovered.status, 0, recovered.stderr);
    const run = JSON.parse(readFileSync(join(ideaDir, 'task-runs', 'task-001.json'), 'utf8'));
    assert.equal(run.attempts.length, 1);
    assert.equal(readTaskState(taskStateFile(ideaDir)).tasks['task-001'].status, 'coding');
  });

  it('uses task leases instead of a fixed coding timeout', () => {
    const ideaDir = join(root, '.chisel', 'lease');
    mkdirSync(join(ideaDir, 'task-runs'), { recursive: true });
    initTaskState(ideaDir, 'lease', [{ taskId: 'task-001', status: 'coding' }]);
    const run = { attempts: [{ run_id: 'run-1', owner: 'agent-a', started_at: '2000-01-01T00:00:00.000Z', lease_until: '2999-01-01T00:00:00.000Z' }] };
    writeFileSync(join(ideaDir, 'task-runs', 'task-001.json'), JSON.stringify(run));
    assert.deepEqual(getStaleCodingTasks(ideaDir), []);
    run.attempts[0].lease_until = '2000-01-01T00:01:00.000Z';
    writeFileSync(join(ideaDir, 'task-runs', 'task-001.json'), JSON.stringify(run));
    assert.equal(getStaleCodingTasks(ideaDir)[0].run_id, 'run-1');
  });

  it('separates delivery size from risk and uncertainty when routing', () => {
    const ideaDir = join(root, '.chisel', 'risk');
    mkdirSync(ideaDir, { recursive: true });
    writeFileSync(join(ideaDir, 'requirement.md'), '# Req\n## 复杂度: trivial\n## 风险: high\n## 涉及范围\n- 修改登录 token\n');
    assert.deepEqual(classifyChange(ideaDir), {
      delivery_complexity: 'trivial', risk_level: 'high', uncertainty_level: 'low', routing_complexity: 'standard',
      reasons: ['route promoted from trivial to standard'],
    });
  });

  it('caps review concurrency and skeptic fan-out', () => {
    const plan = planReview({ dimensions: ['d2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9'], findingCount: 20, riskLevel: 'high' });
    assert.ok(plan.dimension_batches.every(batch => batch.length <= 3));
    assert.equal(plan.skeptic_votes_per_finding, 3);
    assert.equal(plan.skeptic_finding_budget, 3);
    assert.equal(plan.overflow_findings, 17);
  });

  it('blocks direct Bash writes to protected machine state', () => {
    const result = spawnSync('node', ['hooks/pre-tool-write-guard.mjs'], {
      cwd: process.cwd(), encoding: 'utf8',
      input: JSON.stringify({ tool_name: 'Bash', cwd: root, tool_input: { command: 'printf hacked > .chisel/idea/workflow-state.yaml' } }),
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, 'deny');
  });
});
