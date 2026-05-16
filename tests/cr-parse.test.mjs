import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { parseCrResult } from '../scripts/cr-parse.mjs';

const TEST_DIR = join(import.meta.dirname, '.tmp-test-cr');

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function writeCr(content) {
  const path = join(TEST_DIR, 'cr.md');
  writeFileSync(path, content);
  return path;
}

describe('parseCrResult', () => {
  it('returns error for missing file', () => {
    const r = parseCrResult(join(TEST_DIR, 'nonexistent.md'));
    assert.ok(r.error);
  });

  it('parses result from frontmatter', () => {
    const path = writeCr('---\nresult: approved\n---\n# CR\n');
    const r = parseCrResult(path);
    assert.equal(r.result, 'approved');
    assert.equal(r.source, 'frontmatter');
  });

  it('parses result from conclusion section', () => {
    const path = writeCr('---\ntask_id: task-001\n---\n# CR\n## 结论\n\nneeds_rework\n');
    const r = parseCrResult(path);
    assert.equal(r.result, 'needs_rework');
    assert.equal(r.source, 'conclusion_section');
  });

  it('falls back to body scan with low confidence', () => {
    const path = writeCr('# CR\n\nThe result is blocked because of issues.\n');
    const r = parseCrResult(path);
    assert.equal(r.result, 'blocked');
    assert.equal(r.confidence, 'low');
  });

  it('returns error when no result found', () => {
    const path = writeCr('# CR\n\nNo conclusion here.\n');
    const r = parseCrResult(path);
    assert.ok(r.error);
  });
});
