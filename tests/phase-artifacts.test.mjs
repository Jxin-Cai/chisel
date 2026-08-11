import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectPhaseArtifacts, formatPhaseArtifacts, STEP_OUTPUTS } from '../scripts/phase-artifacts.mjs';
import { WORKFLOW_STEPS } from '../scripts/workflow-definition.mjs';

describe('phase artifact delivery', () => {
  let ideaDir;
  beforeEach(() => { ideaDir = mkdtempSync(join(tmpdir(), 'chisel-artifacts-')); });
  afterEach(() => rmSync(ideaDir, { recursive: true, force: true }));

  it('declares an artifact mapping for every canonical workflow step', () => {
    for (const step of WORKFLOW_STEPS) assert.ok(Object.hasOwn(STEP_OUTPUTS, step), step);
  });

  it('expands artifact directories into sorted clickable files', () => {
    mkdirSync(join(ideaDir, 'as-is', 'ai-input'), { recursive: true });
    writeFileSync(join(ideaDir, 'as-is', 'overview.md'), '# Overview\n');
    writeFileSync(join(ideaDir, 'as-is', 'ai-input', 'facts.md'), '# Facts\n');
    const artifacts = collectPhaseArtifacts(ideaDir, 'understand:explore');
    assert.deepEqual(artifacts.map(item => item.label), ['as-is/ai-input/facts.md', 'as-is/overview.md']);
    assert.ok(artifacts.every(item => item.path.startsWith('/')));
    const markdown = formatPhaseArtifacts(ideaDir, 'understand:explore', artifacts);
    assert.match(markdown, /\[as-is\/overview\.md\]\(\//);
    assert.doesNotMatch(markdown, /\]\(<\//);
    assert.doesNotMatch(markdown, /\]\(as-is\//);
  });

  it('uses angle brackets only when an absolute path contains whitespace', () => {
    const markdown = formatPhaseArtifacts(ideaDir, 'receive-requirement', [
      { label: 'plain.md', path: '/tmp/plain.md' },
      { label: 'space.md', path: '/tmp/idea with spaces/space.md' },
    ]);
    assert.match(markdown, /\[plain\.md\]\(\/tmp\/plain\.md\)/);
    assert.match(markdown, /\[space\.md\]\(<\/tmp\/idea with spaces\/space\.md>\)/);
  });

  it('adds only the exact generated report for each mapped phase', () => {
    mkdirSync(join(ideaDir, 'as-is'), { recursive: true });
    mkdirSync(join(ideaDir, 'to-be'), { recursive: true });
    mkdirSync(join(ideaDir, 'cr'), { recursive: true });
    mkdirSync(join(ideaDir, 'confirmations'), { recursive: true });
    mkdirSync(join(ideaDir, 'reports'), { recursive: true });
    writeFileSync(join(ideaDir, 'as-is', 'overview.md'), '# Overview\n');
    writeFileSync(join(ideaDir, 'to-be', 'implementation-plan.md'), '# Plan\n');
    writeFileSync(join(ideaDir, 'cr', 'dim-d1-cr.md'), '# CR\n');
    writeFileSync(join(ideaDir, 'cr', 'current-change-report.json'), '{}\n');
    writeFileSync(join(ideaDir, 'cr', 'current-change-report.md'), '# Current\n');
    writeFileSync(join(ideaDir, 'confirmations', 'merge-review.json'), '{}\n');
    writeFileSync(join(ideaDir, 'confirmations', 'cr-report.json'), '{}\n');
    writeFileSync(join(ideaDir, 'confirmations', 'test-report.json'), '{}\n');
    writeFileSync(join(ideaDir, 'confirmations', 'task-time-report.json'), '{}\n');
    writeFileSync(join(ideaDir, 'reports', 'as-is-report.html'), '<!doctype html>');
    writeFileSync(join(ideaDir, 'reports', 'to-be-report.html'), '<!doctype html>');
    writeFileSync(join(ideaDir, 'reports', 'cr-report.html'), '<!doctype html>');
    writeFileSync(join(ideaDir, 'reports', 'test-report.html'), '<!doctype html>');
    writeFileSync(join(ideaDir, 'reports', 'task-time-report.html'), '<!doctype html>');
    writeFileSync(join(ideaDir, 'reports', 'other.html'), '<!doctype html>');

    const mappings = [
      ['understand:explore', 'reports/as-is-report.html'],
      ['plan:design', 'reports/to-be-report.html'],
      ['test:unit', 'reports/test-report.html'],
      ['review:cr-report', 'reports/cr-report.html'],
      ['review:merge', 'reports/cr-report.html'],
    ];
    for (const [step, expected] of mappings) {
      const labels = collectPhaseArtifacts(ideaDir, step).map(item => item.label);
      assert.ok(labels.includes(expected), `${step} should list ${expected}`);
      assert.ok(!labels.includes('reports/other.html'), `${step} must not expand reports/`);
      if (step === 'review:cr-report') assert.ok(labels.includes('confirmations/cr-report.json'));
    }
    assert.ok(collectPhaseArtifacts(ideaDir, 'final:summary').some(item => item.label === 'confirmations/task-time-report.json'));
  });

  it('does not claim a deliverable exists before it is written', () => {
    const markdown = formatPhaseArtifacts(ideaDir, 'final:summary');
    assert.match(markdown, /暂无可交付文件/);
  });

  it('fails clearly for an unknown workflow step', () => {
    assert.throws(() => collectPhaseArtifacts(ideaDir, 'imaginary:step'), /unknown workflow step/);
  });
});
