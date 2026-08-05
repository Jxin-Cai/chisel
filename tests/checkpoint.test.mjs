import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSnapshot, restoreSnapshot } from '../scripts/checkpoint.mjs';

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

describe('consistent checkpoints', () => {
  let root;
  let ideaDir;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'chisel-checkpoint-'));
    ideaDir = join(root, '.chisel', 'idea');
    mkdirSync(ideaDir, { recursive: true });
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    writeFileSync(join(root, 'source.js'), 'v1\n');
    git(root, 'add', 'source.js');
    git(root, 'commit', '-qm', 'initial');
    writeFileSync(join(ideaDir, 'workflow-state.yaml'), 'idea: idea\ncurrent_step: implement\nrevision: 3\n');
    writeFileSync(join(ideaDir, 'requirement.md'), 'original requirement\n');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('restores the full artifact set when source identity is unchanged', () => {
    const created = createSnapshot(ideaDir, { projectRoot: root });
    writeFileSync(join(ideaDir, 'workflow-state.yaml'), 'idea: idea\ncurrent_step: review\nrevision: 4\n');
    writeFileSync(join(ideaDir, 'later.md'), 'later\n');

    const result = restoreSnapshot(ideaDir, created.file);
    assert.equal(result.restored, true);
    assert.equal(result.mode, 'consistent');
    assert.match(readFileSync(join(ideaDir, 'workflow-state.yaml'), 'utf8'), /revision: 3/);
    assert.equal(existsSync(join(ideaDir, 'later.md')), false);
    assert.ok(result.moved_extra_artifacts_to);
    assert.equal(readFileSync(join(result.moved_extra_artifacts_to, 'later.md'), 'utf8'), 'later\n');
  });

  it('refuses to restore workflow state over different source', () => {
    const created = createSnapshot(ideaDir, { projectRoot: root });
    writeFileSync(join(root, 'source.js'), 'v2\n');
    writeFileSync(join(ideaDir, 'workflow-state.yaml'), 'idea: idea\ncurrent_step: review\nrevision: 4\n');

    const result = restoreSnapshot(ideaDir, created.file);
    assert.match(result.error, /source workspace mismatch/);
    assert.match(readFileSync(join(ideaDir, 'workflow-state.yaml'), 'utf8'), /revision: 4/);
  });

  it('labels forced state-only recovery as inconsistent', () => {
    const created = createSnapshot(ideaDir, { projectRoot: root });
    writeFileSync(join(root, 'source.js'), 'v2\n');
    const result = restoreSnapshot(ideaDir, created.file, { forceStateOnly: true });
    assert.equal(result.mode, 'state-only');
    assert.match(result.warning, /not guaranteed/);
  });
});
