import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
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
});
