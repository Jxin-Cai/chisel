import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { archivePreviousCrResults, computeFileHashes, computeRepairDiffFiles } from '../scripts/cr-prepare.mjs';

describe('incremental CR repair detection', () => {
  let root;
  let ideaDir;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'chisel-cr-prepare-'));
    ideaDir = join(root, '.chisel', 'test');
    mkdirSync(join(ideaDir, 'cr'), { recursive: true });
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src/a.js'), 'const a = 1;\n');
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('detects content changes to an existing file', () => {
    const previous = computeFileHashes(root, ['src/a.js']);
    writeFileSync(join(ideaDir, 'cr/cr-context-prev.json'), JSON.stringify({ file_hashes: previous }));
    writeFileSync(join(root, 'src/a.js'), 'const a = 2;\n');
    const current = computeFileHashes(root, ['src/a.js']);
    assert.deepEqual(computeRepairDiffFiles(ideaDir, current), ['src/a.js']);
  });

  it('returns all files for legacy contexts without hashes', () => {
    writeFileSync(join(ideaDir, 'cr/cr-context-prev.json'), JSON.stringify({ schema_version: 1 }));
    const current = computeFileHashes(root, ['src/a.js']);
    assert.deepEqual(computeRepairDiffFiles(ideaDir, current), ['src/a.js']);
  });

  it('does not invalidate cache when file contents are unchanged', () => {
    const hashes = computeFileHashes(root, ['src/a.js']);
    writeFileSync(join(ideaDir, 'cr/cr-context-prev.json'), JSON.stringify({ file_hashes: hashes }));
    assert.deepEqual(computeRepairDiffFiles(ideaDir, hashes), []);
  });

  it('archives prior dimension findings before a re-review overwrites them', () => {
    mkdirSync(join(ideaDir, 'cr'), { recursive: true });
    writeFileSync(join(ideaDir, 'cr/cr-context.json'), JSON.stringify({ rework_cycle: 2 }));
    writeFileSync(join(ideaDir, 'cr/dim-d4-cr.md'), '---\ndimension: d4\nresult: fail\n---\n\n## Rework Items\n');
    const target = archivePreviousCrResults(ideaDir);
    assert.equal(readFileSync(join(target, 'dim-d4-cr.md'), 'utf8').includes('result: fail'), true);
  });
});
