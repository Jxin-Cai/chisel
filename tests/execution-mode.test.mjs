import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  assertHotolCapability,
  enableHotolMode,
  isHotolMode,
  isValidConfirmationActor,
  readExecutionMode,
} from '../scripts/execution-mode.mjs';
import { completeHotolDelivery } from '../scripts/hotol-approve.mjs';

describe('HOTOL execution mode', () => {
  let ideaDir;
  beforeEach(() => { ideaDir = mkdtempSync(join(tmpdir(), 'chisel-hotol-')); });
  afterEach(() => rmSync(ideaDir, { recursive: true, force: true }));

  it('is interactive by default and rejects an unbacked automation actor', () => {
    assert.equal(readExecutionMode(ideaDir).mode, 'interactive');
    assert.equal(isHotolMode(ideaDir), false);
    assert.equal(isValidConfirmationActor(ideaDir, 'user'), true);
    assert.equal(isValidConfirmationActor(ideaDir, 'hotol'), false);
  });

  it('persists explicit user authorization with bounded delivery capabilities', () => {
    const mode = enableHotolMode(ideaDir);
    assert.equal(mode.active, true);
    assert.equal(mode.authorization.push, false);
    assert.equal(mode.authorization.force_push, false);
    assert.equal(mode.authorization.destructive_cleanup, false);
    assert.equal(isValidConfirmationActor(ideaDir, 'hotol'), true);
    assert.equal(assertHotolCapability(ideaDir, 'merge-to-default-branch').mode, 'hotol');
    assert.throws(() => assertHotolCapability(ideaDir, 'force-push'), /not authorized/);
  });

  it('marks completion only after every local default branch receipt is updated', () => {
    enableHotolMode(ideaDir);
    const repoPath = join(ideaDir, 'repo-a');
    writeFileSync(join(ideaDir, 'worktree-decision.json'), JSON.stringify({ repos: [{ repo_path: repoPath }] }));
    mkdirSync(join(ideaDir, 'delivery'), { recursive: true });
    const receipt = join(ideaDir, 'delivery', 'repo-a.json');
    writeFileSync(receipt, JSON.stringify({ status: 'merged', target: 'main', merge_commit: 'abc', local_target: { status: 'not-updated' } }));
    assert.throws(() => completeHotolDelivery(ideaDir), /delivery is incomplete/);
    assert.equal(existsSync(join(ideaDir, '.done')), false);
    writeFileSync(receipt, JSON.stringify({ status: 'merged', target: 'main', merge_commit: 'abc', local_target: { status: 'updated' } }));
    assert.equal(completeHotolDelivery(ideaDir).repositories[0].target, 'main');
    assert.equal(existsSync(join(ideaDir, '.done')), true);
  });
});
