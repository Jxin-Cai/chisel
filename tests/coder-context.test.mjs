import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initTaskState } from '../scripts/workflow-lib.mjs';
import { packageSourceContext } from '../scripts/coder-prepare.mjs';

const script = new URL('../scripts/coder-prepare.mjs', import.meta.url).pathname;

describe('coder first-hand context', () => {
  let root;
  let ideaDir;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'chisel-coder-context-'));
    ideaDir = join(root, '.control', 'feature');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(join(root, 'tests'), { recursive: true });
    mkdirSync(join(ideaDir, 'tasks'), { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: root });
    writeFileSync(join(root, 'src/helper.js'), 'export const helper = value => value + 1;\n');
    const fullSource = ["import { helper } from './helper.js';", ...Array.from({ length: 90 }, (_, index) => `export const line${index} = ${index};`), 'export function feature(value) { return helper(value); }'].join('\n');
    writeFileSync(join(root, 'src/feature.js'), `${fullSource}\n`);
    writeFileSync(join(root, 'src/caller.js'), "import { feature } from './feature.js';\nexport const run = () => feature(1);\n");
    writeFileSync(join(root, 'tests/feature.test.js'), "import { feature } from '../src/feature.js';\nvoid feature;\n");
    execFileSync('git', ['add', '.'], { cwd: root });
    writeFileSync(join(ideaDir, 'requirement.md'), '# Requirement\nReturn the incremented value.\n');
    mkdirSync(join(ideaDir, 'to-be'), { recursive: true });
    mkdirSync(join(ideaDir, 'confirmations'), { recursive: true });
    writeFileSync(join(ideaDir, 'to-be/design-notes.json'), JSON.stringify({
      goal_behavior: 'Return the confirmed public value.',
      non_goal_behavior: 'Do not change serialization.',
      strategy_overview: 'Reuse the existing helper and preserve callers.',
      historical_behaviors: ['Zero remains supported.'],
      verification_surface: ['Public feature export.'],
      allowed_scope: [{ scope: 'src/', reason: 'starting navigation' }],
      forbidden_scope: [{ scope: 'src/secret/', reason: 'user-confirmed exclusion' }],
      change_point_details: [
        { cp_id: 'CP-1', what: 'Increment through helper', design_rationale: 'Preserve one source of truth.' },
        { cp_id: 'CP-2', what: 'Unrelated change' },
      ],
    }));
    writeFileSync(join(ideaDir, 'confirmations/to-be.json'), JSON.stringify({
      schema_version: 1, phase: 'to-be', status: 'confirmed', confirmed_by: 'user', confirmed_at: '2026-08-12T00:00:00.000Z',
    }));
    mkdirSync(join(ideaDir, 'oracle'), { recursive: true });
    writeFileSync(join(ideaDir, 'oracle/acceptance.test.mjs'), 'ORACLE_SECRET_ASSERTION\n');
    writeFileSync(join(ideaDir, 'tasks/task-001.md'), `---
task_id: task-001
starting_points: [src/feature.js]
forbidden_files: [src/secret/**]
change_point_refs: [CP-1]
---
## 目标行为

Increment the public result.

## Acceptance Criteria

- AC-001: feature returns incremented value

### Forbidden Files / Areas

- src/secret/**
`);
    initTaskState(ideaDir, 'feature', [{ taskId: 'task-001', file: 'tasks/task-001.md', expected_files: ['src/feature.js'] }]);
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('packages complete starting points and discovers dependencies, callers, and tests without exposing expected_files', () => {
    execFileSync(process.execPath, [script, ideaDir, 'task-001', root]);
    const raw = readFileSync(join(ideaDir, 'coder-context/task-001.json'), 'utf8');
    const context = JSON.parse(raw);
    assert.equal(context.schema_version, 3);
    assert.deepEqual(context.starting_points, ['src/feature.js']);
    assert.match(context.source_context['src/feature.js'], /line89/);
    assert.ok(context.discovery.dependencies.includes('src/helper.js'));
    assert.ok(context.discovery.callers.includes('src/caller.js'));
    assert.ok(context.discovery.tests.includes('tests/feature.test.js'));
    assert.equal(Object.hasOwn(context, 'task_content'), false);
    assert.equal(Object.hasOwn(context, 'style_samples'), false);
    assert.equal(raw.includes('ORACLE_SECRET_ASSERTION'), false);
    assert.equal(context.decision_context.user_confirmed, true);
    assert.equal(context.decision_context.goal_behavior, 'Return the confirmed public value.');
    assert.equal(context.decision_context.non_goal_behavior, 'Do not change serialization.');
    assert.deepEqual(context.decision_context.relevant_change_points.map(point => point.cp_id), ['CP-1']);
    assert.match(context.decision_context.interpretation.join('\n'), /hypotheses/);
    assert.match(context.coder_contract.join('\n'), /not fact or scope boundaries/);
  });

  it('treats the context budget as soft for starting points and omits whole related files instead of truncating them', () => {
    const large = 'x'.repeat(150);
    writeFileSync(join(root, 'src/large.js'), large);
    writeFileSync(join(root, 'src/related.js'), 'y'.repeat(100));
    const packaged = packageSourceContext(root, ['src/large.js'], { dependencies: ['src/related.js'], tests: [], callers: [] }, 100);
    assert.equal(packaged.files['src/large.js'], large);
    assert.equal(packaged.files['src/related.js'], undefined);
    assert.equal(packaged.inventory.budget_exceeded_by_starting_points, true);
    assert.deepEqual(packaged.inventory.omitted_related_files, ['src/related.js']);
  });
});
