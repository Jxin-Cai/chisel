import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { updateTaskMetrics } from '../scripts/task-metrics.mjs';
import { taskStateFile, writeTaskState } from '../scripts/workflow-lib.mjs';

const TEST_DIR = join(import.meta.dirname, '.tmp-test-task-metrics');
const IDEA_DIR = join(TEST_DIR, '.chisel/idea');

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(IDEA_DIR, { recursive: true });
  execFileSync('git', ['init'], { cwd: TEST_DIR, stdio: 'ignore' });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function writeFile(rel, content) {
  const path = join(TEST_DIR, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function writeIdeaFile(rel, content) {
  const path = join(IDEA_DIR, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function writeTask(expectedFiles = ['src/user.ts']) {
  writeTaskState(taskStateFile(IDEA_DIR), {
    idea: 'test',
    tasks: {
      'task-001': {
        status: 'coding',
        depends_on: [],
        description: 'Task',
        file: 'tasks/task-001.md',
        expected_files: expectedFiles,
        report_file: 'task-reports/task-001-report.md',
        cr_file: 'cr/task-001-cr.md',
        rework_count: 0,
        changed_files: [],
        loc_added: 0,
        loc_deleted: 0
      }
    }
  });
  writeIdeaFile('tasks/task-001.md', `---
task_id: task-001
expected_files: [${expectedFiles.join(', ')}]
---

# Task
`);
}

function readJson(rel) {
  return JSON.parse(readFileSync(join(IDEA_DIR, rel), 'utf8'));
}

describe('task metrics', () => {
  it('records tracked modifications within expected files', () => {
    writeTask(['src/user.ts']);
    writeFile('src/user.ts', 'one\n');
    execFileSync('git', ['add', 'src/user.ts'], { cwd: TEST_DIR });
    execFileSync('git', ['-c', 'user.email=test@example.com', '-c', 'user.name=Test', 'commit', '-m', 'init'], { cwd: TEST_DIR, stdio: 'ignore' });
    writeFile('src/user.ts', 'one\ntwo\nthree\n');

    const cwd = process.cwd();
    process.chdir(TEST_DIR);
    try {
      const result = updateTaskMetrics(IDEA_DIR, 'task-001');
      assert.deepEqual(result.changed_files, ['src/user.ts']);
      assert.equal(result.loc_added, 2);
      assert.equal(result.loc_deleted, 0);
      assert.deepEqual(readJson('metrics/changed-files.json'), ['src/user.ts']);
    } finally {
      process.chdir(cwd);
    }
  });

  it('includes untracked files and writes state metrics', () => {
    writeTask(['src/**']);
    writeFile('src/new-file.ts', 'a\nb\n');

    const cwd = process.cwd();
    process.chdir(TEST_DIR);
    try {
      const result = updateTaskMetrics(IDEA_DIR, 'task-001');
      assert.deepEqual(result.changed_files, ['src/new-file.ts']);
      assert.equal(result.loc_added, 2);
      assert.equal(result.loc_deleted, 0);
    } finally {
      process.chdir(cwd);
    }

    const state = readFileSync(taskStateFile(IDEA_DIR), 'utf8');
    assert.match(state, /changed_files: \[src\/new-file\.ts\]/);
    assert.match(state, /loc_added: 2/);
    assert.deepEqual(readJson('metrics/loc-delta.json'), { added: 2, deleted: 0 });
  });

  it('filters files outside expected scope and .chisel internals', () => {
    writeTask(['src/user.ts']);
    writeFile('src/order.ts', 'order\n');
    writeFile('.chisel/idea/internal.md', 'internal\n');

    const cwd = process.cwd();
    process.chdir(TEST_DIR);
    try {
      const result = updateTaskMetrics(IDEA_DIR, 'task-001');
      assert.deepEqual(result.changed_files, []);
      assert.equal(result.loc_added, 0);
    } finally {
      process.chdir(cwd);
    }

    assert.equal(existsSync(join(IDEA_DIR, 'metrics/task-summary.json')), true);
  });
});
