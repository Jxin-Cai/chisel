import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { selectReview } from '../scripts/review-selector.mjs';

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

  it('uses senior aggregation, targeted skepticism, then final adjudication before repair', () => {
    const phase = readFileSync(new URL('../workflows/phases/review-aggregate-assessment-phase.js', import.meta.url), 'utf8');
    const workflow = readFileSync(new URL('../workflows/chisel-review.js', import.meta.url), 'utf8');
    assert.match(phase, /label: 'reviewer:initial-aggregate-assessment'/);
    assert.match(phase, /label: 'reviewer:final-aggregate-adjudication'/);
    assert.equal((phase.match(/model: 'opus'/g) || []).length, 2);
    assert.match(phase, /targetedCandidates/);
    assert.match(phase, /skepticVotes/);
    assert.match(phase, /index \+= maxConcurrency/);
    assert.match(phase, /assessment_failed: true/);
    assert.match(workflow, /root_cause_groups: retainedRootCauseGroups/);
    assert.match(workflow, /status: 'assessment_failed'/);
    assert.ok(workflow.indexOf('review-aggregate-assessment-phase.js') < workflow.indexOf("status: 'needs_rework'"));
  });
});
