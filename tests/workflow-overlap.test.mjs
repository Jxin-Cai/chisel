import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { getTasksFileOverlap, getTasksImpactOverlap, initTaskState, scopePatternsOverlap } from '../scripts/workflow-lib.mjs';

describe('parallel task overlap', () => {
  let ideaDir;
  beforeEach(() => { ideaDir = mkdtempSync(join(tmpdir(), 'chisel-overlap-')); });
  afterEach(() => rmSync(ideaDir, { recursive: true, force: true }));

  it('detects directory/glob path intersections conservatively', () => {
    assert.equal(scopePatternsOverlap('src/**', 'src/feature/a.js'), true);
    assert.equal(scopePatternsOverlap('src/components/', 'src/components/Button.tsx'), true);
    assert.equal(scopePatternsOverlap('src/a.js', 'src/b.js'), false);
  });

  it('blocks tasks whose expected path patterns intersect', () => {
    initTaskState(ideaDir, 'idea', [
      { taskId: 'task-001', expected_files: ['src/**'] },
      { taskId: 'task-002', expected_files: ['src/feature/a.js'] },
    ]);
    const overlap = getTasksFileOverlap(ideaDir, ['task-001', 'task-002']);
    assert.equal(overlap.length, 1);
    assert.deepEqual(overlap[0].tasks, ['task-001', 'task-002']);
  });

  it('allows read/read but blocks write/read on a shared resource', () => {
    initTaskState(ideaDir, 'idea', [
      { taskId: 'task-001', impact_surface: { reads: ['db:users'] } },
      { taskId: 'task-002', impact_surface: { reads: ['db:users'] } },
    ]);
    assert.deepEqual(getTasksImpactOverlap(ideaDir, ['task-001', 'task-002']), []);

    initTaskState(ideaDir, 'idea', [
      { taskId: 'task-002', impact_surface: { writes: ['db:*'] } },
    ]);
    const overlap = getTasksImpactOverlap(ideaDir, ['task-001', 'task-002']);
    assert.ok(overlap.some(item => item.kind === 'shared_resource'));
  });
});
