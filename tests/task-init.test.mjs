import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { initFromTasksJson } from '../scripts/task-init.mjs';
import { readTaskState, taskStateFile } from '../scripts/workflow-lib.mjs';

const TEST_DIR = join(import.meta.dirname, '.tmp-test-task-init');

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function writeFile(rel, content) {
  const path = join(TEST_DIR, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function tasksJson(overrides = {}) {
  return {
    tasks: [
      {
        task_id: 'task-001',
        depends_on: [],
        title: '实现用户校验',
        goal: '用户创建时增加校验。',
        allowed_files: ['src/user.ts'],
        forbidden_files: [],
        expected_files: ['src/user.ts'],
        trace_refs: ['REQ-001'],
        allowed_symbols: ['UserService.create'],
        forbidden_symbols: ['LegacyResponseShape'],
        behavior_invariants: ['旧接口响应字段保持不变'],
        impact_surface: {
          files: ['src/user.ts'],
          symbols: ['UserService.create'],
          invariants: ['旧接口响应字段保持不变'],
          shared_state: ['user table']
        },
        context_to_load: {
          as_is: ['as-is/ai-input/facts.md'],
          to_be: ['to-be/implementation-plan.md'],
          wiki: [],
          module_map: ['.chisel/wiki/modules/user.md'],
          adr: ['.chisel/wiki/adr-index.md#ADR-001'],
          tests: ['tests/user.test.ts']
        },
        acceptance_criteria: ['非法用户创建失败'],
        verification: ['node --test tests/user.test.mjs'],
        risk_level: 'low',
        rollback: '回退 src/user.ts',
        ...overrides
      }
    ]
  };
}

function writeTasksJson(doc = tasksJson()) {
  writeFile('to-be/tasks.json', JSON.stringify(doc, null, 2));
}

describe('task-init', () => {
  it('generates task files and workflow state from tasks.json', () => {
    writeTasksJson();
    const result = initFromTasksJson({ ideaDir: TEST_DIR, ideaName: 'test-idea', from: 'to-be/tasks.json', check: false, force: false });

    assert.deepEqual(result.tasks, ['task-001']);
    assert.equal(existsSync(join(TEST_DIR, 'tasks/task-001.md')), true);
    const taskFile = readFileSync(join(TEST_DIR, 'tasks/task-001.md'), 'utf8');
    assert.match(taskFile, /## 目标行为/);
    assert.match(taskFile, /src\/user\.ts/);
    assert.match(taskFile, /.chisel\/wiki\/modules\/user\.md/);
    assert.match(taskFile, /ADR-001/);
    assert.match(taskFile, /## Traceability/);
    assert.match(taskFile, /REQ-001/);
    assert.match(taskFile, /UserService\.create/);
    assert.match(taskFile, /旧接口响应字段保持不变/);
    assert.match(taskFile, /## Impact Surface/);
    assert.match(taskFile, /user table/);

    const state = readTaskState(taskStateFile(TEST_DIR));
    assert.equal(state.idea, 'test-idea');
    assert.equal(state.tasks['task-001'].status, 'confirmed');
    assert.deepEqual(state.tasks['task-001'].expected_files, ['src/user.ts']);
    assert.deepEqual(state.tasks['task-001'].impact_surface.shared_state, ['user table']);
  });

  it('--check validates without writing files', () => {
    writeTasksJson();
    const result = initFromTasksJson({ ideaDir: TEST_DIR, ideaName: '', from: 'to-be/tasks.json', check: true, force: false });

    assert.deepEqual(result, { checked: true, tasks: ['task-001'] });
    assert.equal(existsSync(join(TEST_DIR, 'tasks/task-001.md')), false);
    assert.equal(existsSync(join(TEST_DIR, 'task-workflow-state.yaml')), false);
  });

  it('refuses to overwrite existing task file without --force', () => {
    writeTasksJson();
    writeFile('tasks/task-001.md', 'existing');

    assert.throws(
      () => initFromTasksJson({ ideaDir: TEST_DIR, ideaName: 'test-idea', from: 'to-be/tasks.json', check: false, force: false }),
      /task file already exists/
    );
  });

  it('allows overwrite with --force', () => {
    writeTasksJson();
    writeFile('tasks/task-001.md', 'existing');

    const result = initFromTasksJson({ ideaDir: TEST_DIR, ideaName: 'test-idea', from: 'to-be/tasks.json', check: false, force: true });
    assert.equal(result.initialized, true);
    assert.match(readFileSync(join(TEST_DIR, 'tasks/task-001.md'), 'utf8'), /## 目标行为/);
  });

  it('fails when a required schema field is missing', () => {
    writeTasksJson(tasksJson({ verification: [] }));

    assert.throws(
      () => initFromTasksJson({ ideaDir: TEST_DIR, ideaName: 'test-idea', from: 'to-be/tasks.json', check: true, force: false }),
      /verification must not be empty/
    );
  });
});
