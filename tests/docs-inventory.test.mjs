import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { checkDocs, COMPLEXITIES } from '../scripts/docs-inventory-check.mjs';

describe('README inventory consistency', () => {
  it('references only existing skills/scripts and documents all complexity levels', () => {
    const result = checkDocs();
    assert.equal(result.valid, true, result.errors.join('\n'));
    assert.deepEqual(COMPLEXITIES, ['hotfix', 'minor', 'trivial', 'moderate', 'standard', 'complex']);
  });
});
