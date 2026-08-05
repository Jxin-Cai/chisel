import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  changedFilesForProject,
  finishTaskRun,
  previewTaskChanges,
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
    startTaskRun(ideaDir, 'task-001', { projectRoots: [root] });
    writeFileSync(join(root, 'b.js'), 'task change\n');

    const preview = previewTaskChanges(ideaDir, 'task-001');
    assert.deepEqual(preview.repositories[0].changed_files, ['b.js']);
    assert.deepEqual(changedFilesForProject(ideaDir, 'task-001', root), ['b.js']);

    const finished = finishTaskRun(ideaDir, 'task-001');
    assert.deepEqual(finished.changed_files, ['b.js']);
  });

  it('attributes files committed during the task', () => {
    startTaskRun(ideaDir, 'task-001', { projectRoots: [root] });
    writeFileSync(join(root, 'b.js'), 'committed task change\n');
    git(root, 'add', 'b.js');
    git(root, 'commit', '-m', 'task change');

    assert.deepEqual(finishTaskRun(ideaDir, 'task-001').changed_files, ['b.js']);
  });

  it('does not claim a pre-existing dirty file merely because it was committed', () => {
    writeFileSync(join(root, 'a.js'), 'pre-existing\n');
    startTaskRun(ideaDir, 'task-001', { projectRoots: [root] });
    git(root, 'add', 'a.js');
    git(root, 'commit', '-m', 'commit pre-existing work');
    assert.deepEqual(finishTaskRun(ideaDir, 'task-001').changed_files, []);
  });

  it('creates a new immutable attempt after a finished run', () => {
    startTaskRun(ideaDir, 'task-001', { projectRoots: [root] });
    finishTaskRun(ideaDir, 'task-001');
    const second = startTaskRun(ideaDir, 'task-001', { projectRoots: [root] });
    assert.equal(second.attempt, 2);
  });
});
