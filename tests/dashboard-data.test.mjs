import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectCrResults, collectTraceability, detectComplexity, parseTableSection } from '../scripts/dashboard.mjs';

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'chisel-dash-'));
}

describe('parseTableSection', () => {
  it('parses Rework Items table', () => {
    const text = [
      '## Rework Items',
      '',
      '| ID | affected_task_id | 问题描述 | 修复建议 | 严重度 | 置信度 |',
      '|----|------------------|---------|---------|--------|--------|',
      '| CR-001 [D4] | task-001 | 违反 SRP | 拆分类 | high | 90 |',
      '| CR-002 [D4] | task-002 | 硬编码 | 提取常量 | medium | 85 |',
      '',
      '## Observations (non-blocking)',
    ].join('\n');
    const items = parseTableSection(text, 'Rework Items');
    assert.equal(items.length, 2);
    assert.equal(items[0].id, 'CR-001 [D4]');
    assert.equal(items[0].affected_task_id, 'task-001');
    assert.equal(items[0]['严重度'], 'high');
    assert.equal(items[0]['置信度'], '90');
    assert.equal(items[1]['问题描述'], '硬编码');
  });

  it('returns empty array when heading not found', () => {
    const text = '## Something else\nno table here';
    assert.deepEqual(parseTableSection(text, 'Rework Items'), []);
  });

  it('returns empty array when table has no data rows', () => {
    const text = '## Rework Items\n\n| ID |\n|----|\n\n## End';
    assert.deepEqual(parseTableSection(text, 'Rework Items'), []);
  });
});

describe('detectComplexity', () => {
  let ideaDir;
  beforeEach(() => { ideaDir = makeTmpDir(); });
  afterEach(() => { rmSync(ideaDir, { recursive: true, force: true }); });

  it('returns trivial when marked', () => {
    writeFileSync(join(ideaDir, 'requirement.md'), '# R\n## 复杂度: trivial\n');
    assert.equal(detectComplexity(ideaDir), 'trivial');
  });

  it('returns standard when no requirement file', () => {
    assert.equal(detectComplexity(ideaDir), 'standard');
  });

  it('returns standard when no complexity marker', () => {
    writeFileSync(join(ideaDir, 'requirement.md'), '# Just a requirement\nsome text\n');
    assert.equal(detectComplexity(ideaDir), 'standard');
  });
});

describe('collectCrResults', () => {
  let ideaDir;
  beforeEach(() => { ideaDir = makeTmpDir(); });
  afterEach(() => { rmSync(ideaDir, { recursive: true, force: true }); });

  it('returns empty when no cr directory', () => {
    assert.deepEqual(collectCrResults(ideaDir), []);
  });

  it('parses CR files with rework items', () => {
    const crDir = join(ideaDir, 'cr');
    mkdirSync(crDir, { recursive: true });
    writeFileSync(join(crDir, 'dim-d4-cr.md'), [
      '---',
      'dimension: d4',
      'result: fail',
      '---',
      '',
      '## Rework Items',
      '',
      '| ID | affected_task_id | 问题描述 | 修复建议 | 严重度 | 置信度 |',
      '|----|------------------|---------|---------|--------|--------|',
      '| CR-001 [D4] | task-001 | SRP violation | split | high | 92 |',
      '',
      '## Observations (non-blocking)',
      '',
      '| ID | affected_task_id | 描述 | 置信度 |',
      '|----|------------------|------|--------|',
      '| OBS-001 [D4] | task-001 | naming | 65 |',
    ].join('\n'));
    const results = collectCrResults(ideaDir);
    assert.equal(results.length, 1);
    assert.equal(results[0].dimension, 'd4');
    assert.equal(results[0].result, 'fail');
    assert.equal(results[0].reworkItems.length, 1);
    assert.equal(results[0].reworkItems[0]['严重度'], 'high');
    assert.equal(results[0].observations.length, 1);
    assert.equal(results[0].observations[0]['描述'], 'naming');
  });
});

describe('collectTraceability', () => {
  let ideaDir;
  beforeEach(() => { ideaDir = makeTmpDir(); });
  afterEach(() => { rmSync(ideaDir, { recursive: true, force: true }); });

  it('returns null when no matrix file', () => {
    assert.equal(collectTraceability(ideaDir), null);
  });

  it('computes coverage percentage', () => {
    const tobeDir = join(ideaDir, 'to-be');
    mkdirSync(tobeDir, { recursive: true });
    writeFileSync(join(tobeDir, 'traceability-matrix.json'), JSON.stringify({
      items: [
        { id: 'REQ-1', covered_by_tasks: ['task-001'] },
        { id: 'REQ-2', covered_by_tasks: ['task-002'] },
      ]
    }));
    mkdirSync(join(ideaDir, 'tasks'), { recursive: true });
    writeFileSync(join(ideaDir, 'task-workflow-state.yaml'), [
      'tasks:',
      '  task-001:',
      '    status: approved',
      '    file: tasks/task-001.md',
      '  task-002:',
      '    status: coding',
      '    file: tasks/task-002.md',
    ].join('\n'));
    const result = collectTraceability(ideaDir);
    assert.equal(result.total, 2);
    assert.equal(result.covered, 1);
    assert.equal(result.percentage, 50);
  });
});
