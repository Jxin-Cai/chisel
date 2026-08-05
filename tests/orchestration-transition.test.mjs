import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initWorkflowState, readWorkflowRevision } from '../scripts/workflow-lib.mjs';

describe('explicit orchestration transitions', () => {
  let ideaDir;

  beforeEach(() => {
    ideaDir = mkdtempSync(join(tmpdir(), 'chisel-transition-'));
    writeFileSync(join(ideaDir, 'requirement.md'), '# Req\n## 复杂度: trivial\n## 目标\n实现小改动\n');
    initWorkflowState(ideaDir, 'test-idea');
  });
  afterEach(() => rmSync(ideaDir, { recursive: true, force: true }));

  function transition(step, revision, eventId) {
    const args = ['scripts/orchestration-transition.mjs', ideaDir, step, '--expected-revision', String(revision)];
    if (eventId) args.push('--event-id', eventId);
    return spawnSync('node', args, { cwd: process.cwd(), encoding: 'utf8' });
  }

  it('increments revision and appends an event', () => {
    const result = transition('clarify:requirement', 0, 'evt-1');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readWorkflowRevision(ideaDir), 1);
    assert.match(readFileSync(join(ideaDir, 'workflow-state.yaml'), 'utf8'), /^current_step: clarify:requirement$/m);
    const event = JSON.parse(readFileSync(join(ideaDir, 'events.ndjson'), 'utf8').trim());
    assert.equal(event.event_id, 'evt-1');
    assert.equal(event.revision, 1);
    assert.equal(existsSync(join(ideaDir, '.transition.lock')), false);
  });

  it('replays the same event idempotently', () => {
    assert.equal(transition('clarify:requirement', 0, 'evt-1').status, 0);
    const replay = transition('clarify:requirement', 0, 'evt-1');
    assert.equal(replay.status, 0, replay.stderr);
    assert.equal(JSON.parse(replay.stdout).idempotent_replay, true);
    assert.equal(readWorkflowRevision(ideaDir), 1);
  });

  it('rejects stale revisions without leaving a lock', () => {
    assert.equal(transition('clarify:requirement', 0, 'evt-1').status, 0);
    const stale = transition('clarify:requirement', 0, 'evt-2');
    assert.equal(stale.status, 2);
    assert.match(stale.stderr, /revision conflict/);
    assert.equal(existsSync(join(ideaDir, '.transition.lock')), false);
  });

  it('rejects a step that is not the authoritative resume step', () => {
    const result = transition('quick-dev:init', 0, 'evt-wrong');
    assert.equal(result.status, 2);
    assert.match(result.stderr, /authoritative resume_step is clarify:requirement/);
    assert.equal(readWorkflowRevision(ideaDir), 0);
  });

  it('recovers a stale lock left by a dead process', () => {
    writeFileSync(join(ideaDir, '.transition.lock'), JSON.stringify({ pid: 99999999, created_at: '2020-01-01T00:00:00.000Z' }));
    const result = transition('clarify:requirement', 0, 'evt-after-crash');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(readWorkflowRevision(ideaDir), 1);
    assert.equal(existsSync(join(ideaDir, '.transition.lock')), false);
  });
});
