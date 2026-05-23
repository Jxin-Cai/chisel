import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { matchScopeProofs } from '../scripts/scope-check.mjs';

describe('matchScopeProofs', () => {
  it('matches exact file path', () => {
    const results = matchScopeProofs('src/app.js', ['src/app.js', 'src/other.js']);
    assert.equal(results.length, 1);
    assert.equal(results[0].match_type, 'exact');
    assert.equal(results[0].pattern, 'src/app.js');
  });

  it('matches prefix with trailing slash', () => {
    const results = matchScopeProofs('src/components/Button.tsx', ['src/components/']);
    assert.equal(results.length, 1);
    assert.equal(results[0].match_type, 'prefix_slash');
  });

  it('matches glob star pattern', () => {
    const results = matchScopeProofs('src/utils/helper.js', ['src/utils/*']);
    assert.equal(results.length, 1);
    assert.equal(results[0].match_type, 'glob_star');
  });

  it('matches double glob star pattern', () => {
    const results = matchScopeProofs('src/deep/nested/file.ts', ['src/**']);
    assert.equal(results.length, 1);
    assert.equal(results[0].match_type, 'glob_double_star');
  });

  it('returns empty when no match', () => {
    const results = matchScopeProofs('lib/other.js', ['src/', 'tests/']);
    assert.equal(results.length, 0);
  });

  it('handles object patterns with source', () => {
    const results = matchScopeProofs('config/db.yml', [{ pattern: 'config/', source: 'forbidden' }]);
    assert.equal(results.length, 1);
    assert.equal(results[0].source, 'forbidden');
    assert.equal(results[0].match_type, 'prefix_slash');
  });

  it('handles empty string pattern gracefully', () => {
    const results = matchScopeProofs('src/a.js', ['', { pattern: '' }]);
    assert.equal(results.length, 0);
  });
});
