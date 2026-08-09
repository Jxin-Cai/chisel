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
    assert.match(markdown, /\[as-is\/overview\.md\]\(<\//);
    assert.doesNotMatch(markdown, /\]\(as-is\//);
  });

  it('adds only the exact generated dashboard page for each mapped phase', () => {
    mkdirSync(join(ideaDir, 'as-is'), { recursive: true });
    mkdirSync(join(ideaDir, 'to-be'), { recursive: true });
    mkdirSync(join(ideaDir, 'cr'), { recursive: true });
    mkdirSync(join(ideaDir, 'confirmations'), { recursive: true });
    mkdirSync(join(ideaDir, 'dashboard'), { recursive: true });
    writeFileSync(join(ideaDir, 'as-is', 'overview.md'), '# Overview\n');
    writeFileSync(join(ideaDir, 'to-be', 'implementation-plan.md'), '# Plan\n');
    writeFileSync(join(ideaDir, 'cr', 'dim-d1-cr.md'), '# CR\n');
    writeFileSync(join(ideaDir, 'cr', 'current-change-report.json'), '{}\n');
    writeFileSync(join(ideaDir, 'cr', 'current-change-report.md'), '# Current\n');
    writeFileSync(join(ideaDir, 'confirmations', 'merge-review.json'), '{}\n');
    writeFileSync(join(ideaDir, 'dashboard', 'as-is.html'), '<!doctype html>');
    writeFileSync(join(ideaDir, 'dashboard', 'to-be.html'), '<!doctype html>');
    writeFileSync(join(ideaDir, 'dashboard', 'cr-results.html'), '<!doctype html>');
    writeFileSync(join(ideaDir, 'dashboard', 'current-change.html'), '<!doctype html>');
    writeFileSync(join(ideaDir, 'dashboard', 'other.html'), '<!doctype html>');

    const mappings = [
      ['understand:explore', 'dashboard/as-is.html'],
      ['plan:design', 'dashboard/to-be.html'],
      ['review:cr', 'dashboard/cr-results.html'],
      ['review:cr-light', 'dashboard/cr-results.html'],
      ['review:cr-moderate', 'dashboard/cr-results.html'],
      ['review:integration', 'dashboard/cr-results.html'],
      ['review:merge', 'dashboard/current-change.html'],
    ];
    for (const [step, expected] of mappings) {
      const labels = collectPhaseArtifacts(ideaDir, step).map(item => item.label);
      assert.ok(labels.includes(expected), `${step} should list ${expected}`);
      assert.ok(!labels.includes('dashboard/other.html'), `${step} must not expand dashboard/`);
    }
  });

  it('does not claim a deliverable exists before it is written', () => {
    const markdown = formatPhaseArtifacts(ideaDir, 'final:summary');
    assert.match(markdown, /暂无可交付文件/);
  });

  it('fails clearly for an unknown workflow step', () => {
    assert.throws(() => collectPhaseArtifacts(ideaDir, 'imaginary:step'), /unknown workflow step/);
  });
});
