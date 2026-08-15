import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { selectReview, writeReviewSelection } from '../scripts/review-selector.mjs';

describe('dynamic review selector', () => {
  it('always runs spec and uses lite for a small low-risk diff', () => {
    const result = selectReview({ paths: ['src/format.js'], diffText: '+const x = 1;\n-const x = 0;' });
    assert.equal(result.mode, 'lite');
    assert.deepEqual(result.dimensions, ['spec']);
    assert.match(result.reasons[0].reason, /2 changed paths|80 changed lines/);
  });

  it('upgrades risk for auth, payment, migration, concurrency, boundaries, and verification changes', () => {
    for (const path of ['src/auth/login.js', 'src/payment/refund.js', 'db/migration.sql', 'src/lock-worker.js', 'src/api/webhook.js', '.github/workflows/ci.yml']) {
      const result = selectReview({ paths: [path], diffText: `+++ b/${path}\n+changed` });
      assert.equal(result.dimensions.includes('spec'), true);
      assert.equal(result.mode, 'dynamic', path);
      assert.equal(result.risk_level, 'high', path);
      assert.ok(result.reasons.length, path);
      assert.ok(result.dimension_batches.length, path);
    }
  });

  it('projects unselected legacy dimensions as skipped/auto-pass', () => {
    const result = selectReview({ paths: ['src/format.js'], diffText: '+small' });
    assert.equal(result.compatibility_projection.d2.status, 'skipped');
    assert.equal(result.compatibility_projection.d2.result, 'auto-pass');
  });

  it('keeps spec out of parallel quality-review batches', () => {
    const result = selectReview({ paths: ['src/api/webhook.js'], diffText: '+changed' });
    assert.equal(result.dimensions.includes('spec'), true);
    assert.equal(result.active_dimensions.includes('spec'), false);
    assert.equal(result.dimension_batches.flat().includes('spec'), false);
    assert.deepEqual(result.dimension_batches.flat(), result.active_dimensions);
  });

  it('atomically writes the gate selection and canonical workflow input', () => {
    const root = mkdtempSync(join(tmpdir(), 'chisel-review-selector-'));
    const ideaDir = join(root, '.chisel', 'review-write');
    try {
      mkdirSync(join(ideaDir, 'cr'), { recursive: true });
      writeFileSync(join(ideaDir, 'cr', 'cr-context.json'), JSON.stringify({
        schema_version: 2,
        base_ref: 'abc123',
        task_ids: ['task-001'],
        rework_cycle: 2,
      }));
      const selection = selectReview({ paths: ['src/api/webhook.js'], diffText: '+changed', complexity: 'complex' });
      const written = writeReviewSelection(ideaDir, selection, { projectRoot: root, complexity: 'complex', pluginRoot: root });
      const savedSelection = JSON.parse(readFileSync(written.selection_file, 'utf8'));
      const workflowInput = JSON.parse(readFileSync(written.workflow_input_file, 'utf8'));
      assert.deepEqual(savedSelection.dimensions, selection.dimensions);
      assert.deepEqual(workflowInput.activeDimensions, selection.active_dimensions);
      assert.equal(workflowInput.dimensionBatches.flat().includes('spec'), false);
      assert.deepEqual(workflowInput.taskIds, ['task-001']);
      assert.equal(workflowInput.reworkCycle, 2);
      assert.equal(workflowInput.baseRef, 'abc123');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('supports the documented positional --write CLI', () => {
    const root = mkdtempSync(join(tmpdir(), 'chisel-review-selector-cli-'));
    const ideaDir = join(root, '.chisel', 'review-cli');
    try {
      mkdirSync(join(ideaDir, 'cr'), { recursive: true });
      writeFileSync(join(ideaDir, 'cr', 'cr-context.json'), JSON.stringify({ task_ids: ['task-001'], rework_cycle: 0 }));
      const script = new URL('../scripts/review-selector.mjs', import.meta.url);
      const output = JSON.parse(execFileSync(process.execPath, [script.pathname, ideaDir, '--write', '--project-root', root, '--paths', 'src/api/client.js'], { encoding: 'utf8' }));
      assert.equal(output.selection_file, join(ideaDir, 'cr', 'review-selection.json'));
      assert.equal(output.workflow_input_file, join(ideaDir, 'cr', 'review-workflow-input.json'));
      assert.equal(output.workflow_args.activeDimensions.includes('spec'), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('uses senior aggregation, targeted skepticism, then final adjudication before repair', () => {
    const phase = readFileSync(new URL('../workflows/phases/review-aggregate-assessment-phase.js', import.meta.url), 'utf8');
    const crPhase = readFileSync(new URL('../workflows/phases/review-cr-phase.js', import.meta.url), 'utf8');
    const workflow = readFileSync(new URL('../workflows/chisel-review.js', import.meta.url), 'utf8');
    const sharedFooter = readFileSync(new URL('../skills/chisel-review/references/dim-shared-footer.md', import.meta.url), 'utf8');
    assert.match(phase, /label: 'reviewer:initial-aggregate-assessment'/);
    assert.match(phase, /label: 'reviewer:final-aggregate-adjudication'/);
    assert.equal((phase.match(/model: 'opus'/g) || []).length, 2);
    assert.match(phase, /targetedCandidates/);
    assert.match(phase, /skepticVotes/);
    assert.match(phase, /index \+= maxConcurrency/);
    assert.match(phase, /assessment_failed: true/);
    assert.match(workflow, /root_cause_groups: retainedRootCauseGroups/);
    assert.match(workflow, /status: 'assessment_failed'/);
    assert.match(workflow, /typeof args === 'undefined' \? null : typeof args === 'string' \? JSON\.parse\(args\) : args/);
    assert.match(workflow, /must not include spec/);
    for (const heading of ['## 结论', '## 检查结果', '## Scope Check Proof', '## Rework Items']) {
      assert.match(crPhase, new RegExp(heading));
    }
    assert.match(crPhase, /Keep ## Rework Items present when the result is pass/);
    assert.match(sharedFooter, /## Scope Check Proof/);
    assert.match(sharedFooter, /pass\/fail 都必须保留/);
    assert.ok(workflow.indexOf('review-aggregate-assessment-phase.js') < workflow.indexOf("status: 'needs_rework'"));
  });
});
