import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { validateAgentSource, validateMetadata } from '../scripts/validate-plugin.mjs';

describe('plugin metadata', () => {
  it('passes the offline strict metadata contract and keeps versions aligned', () => {
    const result = validateMetadata();
    assert.equal(result.valid, true, result.errors.join('\n'));
    assert.equal(result.plugin_version, '0.49.0');
  });

  it('rejects agent frontmatter that Claude Code would silently omit from inventory', () => {
    const errors = validateAgentSource(`---
name: broken-agent
description: broken
model: inherit
effort: high
maxTurns: 10
tools: Read, Write
---
body
`, 'agents/broken-agent.md');
    assert.ok(errors.some(error => error.includes('color')));
    assert.ok(errors.some(error => error.includes('tools')));
    assert.ok(errors.some(error => error.includes('effort')));
    assert.ok(errors.some(error => error.includes('maxTurns')));
  });
});
