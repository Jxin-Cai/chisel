import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  readTaskState,
  writeTaskState,
  initTaskState,
  parseTaskSpec,
  getNextTasks,
  getCodedTasksNeedingReview,
  getReworkTasks,
  getBlockedReworkTasks,
  allTasksApproved,
  updateTaskStatus,
  markCr,
  taskStateFile,
  getTasksFileOverlap,
  getTasksImpactOverlap,
  rollbackWorkflow,
  MAX_REWORK_COUNT
} from '../scripts/workflow-lib.mjs';

const TEST_DIR = join(import.meta.dirname, '.tmp-test-workflow');

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('parseTaskSpec', () => {
  it('parses a full spec', () => {
    const spec = parseTaskSpec('task-001:dep1,dep2:add login:tasks/task-001.md:src/a.ts,src/b.ts');
    assert.equal(spec.taskId, 'task-001');
    assert.deepEqual(spec.depends_on, ['dep1', 'dep2']);
    assert.equal(spec.description, 'add login');
    assert.equal(spec.file, 'tasks/task-001.md');
    assert.deepEqual(spec.expected_files, ['src/a.ts', 'src/b.ts']);
  });

  it('handles minimal spec', () => {
    const spec = parseTaskSpec('task-002');
    assert.equal(spec.taskId, 'task-002');
    assert.deepEqual(spec.depends_on, []);
    assert.equal(spec.file, 'tasks/task-002.md');
  });

  it('handles dash as empty depends', () => {
    const spec = parseTaskSpec('task-003:-:desc');
    assert.deepEqual(spec.depends_on, []);
    assert.equal(spec.description, 'desc');
  });

  it('parses JSON format', () => {
    const spec = parseTaskSpec('{"taskId":"task-004","depends_on":["task-001"],"description":"path with:colon","file":"tasks/task-004.md","expected_files":["src/c:d.ts"]}');
    assert.equal(spec.taskId, 'task-004');
    assert.deepEqual(spec.depends_on, ['task-001']);
    assert.equal(spec.description, 'path with:colon');
    assert.deepEqual(spec.expected_files, ['src/c:d.ts']);
  });

  it('JSON format defaults missing fields', () => {
    const spec = parseTaskSpec('{"taskId":"task-005"}');
    assert.equal(spec.taskId, 'task-005');
    assert.deepEqual(spec.depends_on, []);
    assert.equal(spec.file, 'tasks/task-005.md');
    assert.deepEqual(spec.expected_files, []);
  });
});

describe('task state read/write', () => {
  it('round-trips state', () => {
    const file = taskStateFile(TEST_DIR);
    const state = {
      idea: 'test-idea',
      tasks: {
        'task-001': {
          status: 'confirmed',
          depends_on: [],
          description: 'test',
          file: 'tasks/task-001.md',
          expected_files: ['src/a.ts'],
          report_file: 'task-reports/task-001-report.md',
          cr_file: 'cr/task-001-cr.md',
          rework_count: 0,
          changed_files: [],
          loc_added: 0,
          loc_deleted: 0
        }
      }
    };
    writeTaskState(file, state);
    const read = readTaskState(file);
    assert.equal(read.idea, 'test-idea');
    assert.equal(read.tasks['task-001'].status, 'confirmed');
    assert.deepEqual(read.tasks['task-001'].expected_files, ['src/a.ts']);
    assert.deepEqual(read.tasks['task-001'].impact_surface.files, ['src/a.ts']);
  });
});

describe('initTaskState', () => {
  it('creates tasks from specs', () => {
    const state = initTaskState(TEST_DIR, 'test', ['task-001:-:desc1:tasks/task-001.md:']);
    assert.equal(Object.keys(state.tasks).length, 1);
    assert.equal(state.tasks['task-001'].status, 'confirmed');
  });
});

describe('task scheduling', () => {
  function setupTasks(tasks) {
    const file = taskStateFile(TEST_DIR);
    writeTaskState(file, { idea: 'test', tasks });
  }

  it('getNextTasks returns confirmed tasks with resolved deps', () => {
    setupTasks({
      'task-001': { status: 'approved', depends_on: [] },
      'task-002': { status: 'confirmed', depends_on: ['task-001'] },
      'task-003': { status: 'confirmed', depends_on: ['task-002'] }
    });
    const next = getNextTasks(TEST_DIR);
    assert.deepEqual(next, ['task-002']);
  });

  it('getNextTasks returns nothing when deps not met', () => {
    setupTasks({
      'task-001': { status: 'coding', depends_on: [] },
      'task-002': { status: 'confirmed', depends_on: ['task-001'] }
    });
    assert.deepEqual(getNextTasks(TEST_DIR), []);
  });

  it('getCodedTasksNeedingReview returns coded tasks', () => {
    setupTasks({
      'task-001': { status: 'coded', depends_on: [] },
      'task-002': { status: 'confirmed', depends_on: [] }
    });
    assert.deepEqual(getCodedTasksNeedingReview(TEST_DIR), ['task-001']);
  });

  it('getReworkTasks returns needs_rework under limit', () => {
    setupTasks({
      'task-001': { status: 'needs_rework', depends_on: [], rework_count: 1 }
    });
    assert.deepEqual(getReworkTasks(TEST_DIR), ['task-001']);
  });

  it('getReworkTasks excludes tasks at limit', () => {
    setupTasks({
      'task-001': { status: 'needs_rework', depends_on: [], rework_count: MAX_REWORK_COUNT }
    });
    assert.deepEqual(getReworkTasks(TEST_DIR), []);
  });

  it('getBlockedReworkTasks returns tasks at limit', () => {
    setupTasks({
      'task-001': { status: 'needs_rework', depends_on: [], rework_count: MAX_REWORK_COUNT }
    });
    assert.deepEqual(getBlockedReworkTasks(TEST_DIR), ['task-001']);
  });

  it('allTasksApproved returns true when all approved', () => {
    setupTasks({
      'task-001': { status: 'approved', depends_on: [] },
      'task-002': { status: 'approved', depends_on: [] }
    });
    assert.equal(allTasksApproved(TEST_DIR), true);
  });

  it('allTasksApproved returns false when not all approved', () => {
    setupTasks({
      'task-001': { status: 'approved', depends_on: [] },
      'task-002': { status: 'coded', depends_on: [] }
    });
    assert.equal(allTasksApproved(TEST_DIR), false);
  });
});

describe('state transitions', () => {
  function setupTask(status) {
    const file = taskStateFile(TEST_DIR);
    writeTaskState(file, {
      idea: 'test',
      tasks: { 'task-001': { status, depends_on: [], rework_count: 0 } }
    });
  }

  it('valid transition confirmed → coding', () => {
    setupTask('confirmed');
    const task = updateTaskStatus(TEST_DIR, 'task-001', 'coding');
    assert.equal(task.status, 'coding');
  });

  it('invalid transition confirmed → approved throws', () => {
    setupTask('confirmed');
    assert.throws(() => updateTaskStatus(TEST_DIR, 'task-001', 'approved'), /invalid transition/);
  });
});

describe('markCr', () => {
  function setupReviewingTask(reworkCount = 0) {
    const file = taskStateFile(TEST_DIR);
    writeTaskState(file, {
      idea: 'test',
      tasks: { 'task-001': { status: 'reviewing', depends_on: [], rework_count: reworkCount } }
    });
  }

  it('approved sets status to approved', () => {
    setupReviewingTask();
    const task = markCr(TEST_DIR, 'task-001', 'approved');
    assert.equal(task.status, 'approved');
  });

  it('needs_rework increments rework_count', () => {
    setupReviewingTask(1);
    const task = markCr(TEST_DIR, 'task-001', 'needs_rework');
    assert.equal(task.status, 'needs_rework');
    assert.equal(task.rework_count, 2);
  });

  it('rework at max becomes blocked', () => {
    setupReviewingTask(MAX_REWORK_COUNT - 1);
    const task = markCr(TEST_DIR, 'task-001', 'needs_rework');
    assert.equal(task.status, 'blocked');
    assert.equal(task.rework_count, MAX_REWORK_COUNT);
  });
});

describe('workflow rollback', () => {
  function write(rel, content = '') {
    const file = join(TEST_DIR, rel);
    mkdirSync(join(file, '..'), { recursive: true });
    writeFileSync(file, content);
  }

  function setupWorkflowState() {
    write('workflow-state.yaml', [
      'idea: test',
      'started_at: 2026-05-19T00:00:00.000Z',
      'last_updated_at: 2026-05-19T00:00:00.000Z',
      'current_step: done',
      'phase:',
      '  requirement: done',
      '  understand: done',
      '  plan: done',
      '  tasks: done',
      '  implement: done',
      '  review: done',
      '  knowledge: done',
      '  final: done',
      ''
    ].join('\n'));
  }

  function setupTaskState(status = 'approved') {
    writeTaskState(taskStateFile(TEST_DIR), {
      idea: 'test',
      tasks: {
        'task-001': { status, depends_on: [], expected_files: ['src/a.ts'], rework_count: 1, changed_files: ['src/a.ts'], loc_added: 2, loc_deleted: 1 }
      }
    });
  }

  function writeLateArtifacts() {
    write('requirement.md', 'req');
    write('as-is/overview.md', 'as-is');
    write('as-is/ai-input/facts.md', 'facts');
    write('clarifications.json', '{}');
    write('clarifications.md', 'clarifications');
    write('confirmations/as-is.json', '{}');
    write('to-be/implementation-plan.md', 'plan');
    write('to-be/tasks.json', '{}');
    write('to-be/traceability-matrix.json', '{}');
    write('confirmations/to-be.json', '{}');
    write('.to-be-confirmed', '');
    write('tasks/task-001.md', 'task');
    write('task-reports/task-001-report.md', 'report');
    write('cr/task-001-cr.md', 'cr');
    write('knowledge-candidates/fz-001.json', '{}');
    write('.knowledge-extracted', '');
    write('final-summary.md', 'summary');
    write('.done', '');
  }

  it('dry-run previews rollback without changing files or audit log', () => {
    setupWorkflowState();
    setupTaskState('approved');
    writeLateArtifacts();
    const result = rollbackWorkflow(TEST_DIR, 'plan:design', { dryRun: true });
    assert.equal(result.rolled_back, false);
    assert.equal(result.dry_run, true);
    assert.ok(result.removed.includes('to-be'));
    assert.equal(existsSync(join(TEST_DIR, 'to-be/implementation-plan.md')), true);
    assert.equal(existsSync(join(TEST_DIR, 'audit-log.jsonl')), false);
    const stateText = readFileSync(join(TEST_DIR, 'workflow-state.yaml'), 'utf8');
    assert.match(stateText, /current_step: done/);
  });

  it('rolls back to plan:design by removing to-be and later artifacts', () => {
    setupWorkflowState();
    setupTaskState('approved');
    writeLateArtifacts();
    const result = rollbackWorkflow(TEST_DIR, 'plan:design');
    assert.equal(result.rolled_back, true);
    assert.equal(existsSync(join(TEST_DIR, 'to-be')), false);
    assert.equal(existsSync(join(TEST_DIR, 'task-workflow-state.yaml')), false);
    assert.equal(existsSync(join(TEST_DIR, 'task-reports')), false);
    assert.equal(existsSync(join(TEST_DIR, 'cr')), false);
    assert.equal(existsSync(join(TEST_DIR, 'as-is/ai-input/facts.md')), true);
    assert.match(readFileSync(join(TEST_DIR, 'workflow-state.yaml'), 'utf8'), /current_step: plan:design/);
  });

  it('rolls back to implement:code and resets later task states to confirmed', () => {
    setupWorkflowState();
    setupTaskState('approved');
    writeLateArtifacts();
    const result = rollbackWorkflow(TEST_DIR, 'implement:code');
    assert.deepEqual(result.task_resets, [{ task_id: 'task-001', from: 'approved', to: 'confirmed' }]);
    assert.equal(existsSync(join(TEST_DIR, 'task-reports')), false);
    assert.equal(existsSync(join(TEST_DIR, 'cr')), false);
    const state = readTaskState(taskStateFile(TEST_DIR));
    assert.equal(state.tasks['task-001'].status, 'confirmed');
    assert.deepEqual(state.tasks['task-001'].changed_files, []);
    assert.equal(state.tasks['task-001'].loc_added, 0);
  });

  it('rolls back to review:cr and resets review results to coded', () => {
    setupWorkflowState();
    setupTaskState('needs_rework');
    writeLateArtifacts();
    const result = rollbackWorkflow(TEST_DIR, 'review:cr');
    assert.deepEqual(result.task_resets, [{ task_id: 'task-001', from: 'needs_rework', to: 'coded' }]);
    assert.equal(existsSync(join(TEST_DIR, 'cr')), false);
    const state = readTaskState(taskStateFile(TEST_DIR));
    assert.equal(state.tasks['task-001'].status, 'coded');
  });

  it('rolls back to knowledge:extract without deleting knowledge candidates', () => {
    setupWorkflowState();
    setupTaskState('approved');
    writeLateArtifacts();
    rollbackWorkflow(TEST_DIR, 'knowledge:extract');
    assert.equal(existsSync(join(TEST_DIR, 'knowledge-candidates/fz-001.json')), true);
    assert.equal(existsSync(join(TEST_DIR, '.knowledge-extracted')), false);
    assert.equal(existsSync(join(TEST_DIR, 'final-summary.md')), false);
    assert.equal(existsSync(join(TEST_DIR, '.done')), false);
  });

  it('rejects unsupported rollback steps', () => {
    assert.throws(() => rollbackWorkflow(TEST_DIR, 'receive-requirement'), /unsupported rollback step/);
  });

  it('writes rollback audit log for actual rollback', () => {
    setupWorkflowState();
    setupTaskState('approved');
    writeLateArtifacts();
    rollbackWorkflow(TEST_DIR, 'final:summary');
    const lines = readFileSync(join(TEST_DIR, 'audit-log.jsonl'), 'utf8').trim().split('\n');
    const entry = JSON.parse(lines.at(-1));
    assert.equal(entry.type, 'rollback');
    assert.equal(entry.to_step, 'final:summary');
    assert.deepEqual(entry.removed, ['final-summary.md', '.done']);
  });
});

describe('getTasksFileOverlap', () => {
  function setupOverlapTasks(tasks) {
    const file = taskStateFile(TEST_DIR);
    writeTaskState(file, { idea: 'test', tasks });
  }

  it('detects overlapping expected_files', () => {
    setupOverlapTasks({
      'task-001': { status: 'confirmed', depends_on: [], expected_files: ['src/a.ts', 'src/b.ts'] },
      'task-002': { status: 'confirmed', depends_on: [], expected_files: ['src/b.ts', 'src/c.ts'] }
    });
    const overlaps = getTasksFileOverlap(TEST_DIR, ['task-001', 'task-002']);
    assert.equal(overlaps.length, 1);
    assert.equal(overlaps[0].file, 'src/b.ts');
    assert.deepEqual(overlaps[0].tasks, ['task-001', 'task-002']);
  });

  it('returns empty when no overlap', () => {
    setupOverlapTasks({
      'task-001': { status: 'confirmed', depends_on: [], expected_files: ['src/a.ts'] },
      'task-002': { status: 'confirmed', depends_on: [], expected_files: ['src/b.ts'] }
    });
    const overlaps = getTasksFileOverlap(TEST_DIR, ['task-001', 'task-002']);
    assert.equal(overlaps.length, 0);
  });

  it('handles tasks with no expected_files', () => {
    setupOverlapTasks({
      'task-001': { status: 'confirmed', depends_on: [], expected_files: ['src/a.ts'] },
      'task-002': { status: 'confirmed', depends_on: [], expected_files: [] }
    });
    const overlaps = getTasksFileOverlap(TEST_DIR, ['task-001', 'task-002']);
    assert.equal(overlaps.length, 0);
  });

  it('detects multi-task overlap on same file', () => {
    setupOverlapTasks({
      'task-001': { status: 'confirmed', depends_on: [], expected_files: ['src/shared.ts'] },
      'task-002': { status: 'confirmed', depends_on: [], expected_files: ['src/shared.ts'] },
      'task-003': { status: 'confirmed', depends_on: [], expected_files: ['src/shared.ts'] }
    });
    const overlaps = getTasksFileOverlap(TEST_DIR, ['task-001', 'task-002', 'task-003']);
    assert.equal(overlaps.length, 1);
    assert.deepEqual(overlaps[0].tasks, ['task-001', 'task-002', 'task-003']);
  });
});

describe('getTasksImpactOverlap', () => {
  function setupOverlapTasks(tasks) {
    const file = taskStateFile(TEST_DIR);
    writeTaskState(file, { idea: 'test', tasks });
  }

  it('detects overlapping symbols and shared state', () => {
    setupOverlapTasks({
      'task-001': { status: 'confirmed', depends_on: [], expected_files: ['src/a.ts'], impact_surface: { files: ['src/a.ts'], symbols: ['UserService.create'], invariants: [], shared_state: ['user table'] } },
      'task-002': { status: 'confirmed', depends_on: [], expected_files: ['src/b.ts'], impact_surface: { files: ['src/b.ts'], symbols: ['UserService.create'], invariants: [], shared_state: ['user table'] } }
    });

    const overlaps = getTasksImpactOverlap(TEST_DIR, ['task-001', 'task-002']);

    assert.deepEqual(overlaps.map(overlap => overlap.kind).sort(), ['shared_state', 'symbols']);
  });

  it('falls back to expected files when impact surface is missing', () => {
    setupOverlapTasks({
      'task-001': { status: 'confirmed', depends_on: [], expected_files: ['src/shared.ts'] },
      'task-002': { status: 'confirmed', depends_on: [], expected_files: ['src/shared.ts'] }
    });

    const overlaps = getTasksImpactOverlap(TEST_DIR, ['task-001', 'task-002']);

    assert.equal(overlaps[0].kind, 'files');
    assert.equal(overlaps[0].value, 'src/shared.ts');
  });
});
