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

  it('does not claim a deliverable exists before it is written', () => {
    const markdown = formatPhaseArtifacts(ideaDir, 'final:summary');
    assert.match(markdown, /暂无可交付文件/);
  });

  it('fails clearly for an unknown workflow step', () => {
    assert.throws(() => collectPhaseArtifacts(ideaDir, 'imaginary:step'), /unknown workflow step/);
  });
});
