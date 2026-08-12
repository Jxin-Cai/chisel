import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkGate } from '../scripts/gate-check.mjs';

const script = new URL('../scripts/quick-dev-init.mjs', import.meta.url).pathname;

describe('quick-dev completeness contract', () => {
  let ideaDir;
  beforeEach(() => {
    ideaDir = mkdtempSync(join(tmpdir(), 'chisel-quick-complete-'));
    mkdirSync(join(ideaDir, 'to-be'), { recursive: true });
    writeFileSync(join(ideaDir, 'requirement.md'), '# Feature\n## 复杂度: trivial\n## 涉及范围\n- settings\n');
    writeFileSync(join(ideaDir, 'requirement-clarification.json'), JSON.stringify({
      schema_version: 1,
      dimensions: {
        functional_scope: { in_scope: ['settings behavior'] },
        acceptance_criteria: [{ id: 'AC-001', description: 'saved value persists', verification_conditions: [{ id: 'VC-001', condition: 'refresh shows saved value' }] }],
      },
    }));
  });
  afterEach(() => rmSync(ideaDir, { recursive: true, force: true }));

  it('refuses an empty discovery scope instead of generating an unrestricted task', () => {
    assert.throws(
      () => execFileSync(process.execPath, [script, ideaDir, '--current-branch'], { encoding: 'utf8', stdio: 'pipe' }),
      error => /non-empty lightweight discovery scope/.test(String(error.stderr)),
    );
    assert.equal(existsSync(join(ideaDir, 'scope-escalation.json')), true);
    assert.equal(JSON.parse(readFileSync(join(ideaDir, 'scope-escalation.json'))).required, true);
  });

  it('carries a discovered file scope and every AC/VC into the generated task', () => {
    writeFileSync(join(ideaDir, 'quick-dev-scope.json'), JSON.stringify({
      schema_version: 1,
      scope_mode: 'explicit',
      allowed_files: ['src/settings.js', 'tests/settings.test.js'],
      forbidden_files: ['src/auth/**'],
      expected_files: ['src/settings.js', 'tests/settings.test.js'],
      acceptance_criteria: ['AC-001'],
    }));
    execFileSync(process.execPath, [script, ideaDir, '--current-branch'], { encoding: 'utf8' });
    const task = readFileSync(join(ideaDir, 'tasks/task-001.md'), 'utf8');
    assert.match(task, /starting_points: \[src\/settings\.js, tests\/settings\.test\.js\]/);
    assert.match(task, /trace_refs: \[AC-001, AC-001\/VC-001\]/);
    assert.equal(checkGate(ideaDir, 'quick-dev-ready').pass, true);
  });
});
