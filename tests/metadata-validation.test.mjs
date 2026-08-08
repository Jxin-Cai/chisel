import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateMetadata } from '../scripts/validate-plugin.mjs';

describe('plugin metadata', () => {
  it('passes the offline strict metadata contract and keeps versions aligned', () => {
    const result = validateMetadata();
    assert.equal(result.valid, true, result.errors.join('\n'));
    assert.equal(result.plugin_version, '0.40.1');
  });
});
