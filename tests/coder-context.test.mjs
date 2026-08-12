import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initTaskState } from '../scripts/workflow-lib.mjs';
import { queryDecision, queryRefs, querySource, queryTask, readSlice } from '../scripts/context-query.mjs';

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

  it('writes a compact reference-only bootstrap and discovers related file paths', () => {
    execFileSync(process.execPath, [script, ideaDir, 'task-001', root]);
    const raw = readFileSync(join(ideaDir, 'coder-context/task-001.json'), 'utf8');
    const context = JSON.parse(raw);
    assert.equal(context.schema_version, 5);
    assert.equal(context.requirement_ref.path, 'requirement.md');
    assert.match(context.requirement_ref.sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(context.starting_points, ['src/feature.js']);
    assert.ok(context.discovery.dependencies.includes('src/helper.js'));
    assert.ok(context.discovery.callers.includes('src/caller.js'));
    assert.ok(context.discovery.tests.includes('tests/feature.test.js'));
    assert.equal(Object.hasOwn(context, 'canonical_requirement'), false);
    assert.equal(Object.hasOwn(context, 'original_requirement'), false);
    assert.equal(Object.hasOwn(context, 'source_context'), false);
    assert.equal(raw.includes('line89'), false);
    assert.ok(Buffer.byteLength(raw) < 4096, `bootstrap too large: ${Buffer.byteLength(raw)} bytes`);
    assert.equal(Object.hasOwn(context, 'task_content'), false);
    assert.equal(Object.hasOwn(context, 'style_samples'), false);
    assert.equal(raw.includes('ORACLE_SECRET_ASSERTION'), false);
    assert.equal(context.decision_refs.user_confirmed, true);
    assert.equal(context.decision_refs.design_notes_ref.selector, 'change_point_details[cp_id in CP-1]');
    assert.equal(context.retrieval.suggested_rounds, 6);
    assert.equal(Object.hasOwn(context.retrieval, 'max_rounds'), false);
    assert.match(context.coder_contract.join('\n'), /not fact or scope boundaries/);
  });

  it('supports bounded task, reference, source, and line-range retrieval', () => {
    const task = queryTask(ideaDir, 'task-001', ['goal', 'acceptance_criteria']);
    assert.match(task.task.goal, /Increment the public result/);
    assert.match(task.task.acceptance_criteria, /AC-001/);
    assert.match(task.source_sha256, /^[a-f0-9]{64}$/);

    const refs = queryRefs(ideaDir, ['CP-1']);
    const cpMatch = refs.find(match => match.path === 'to-be/design-notes.json' && match.value?.cp_id === 'CP-1');
    assert.equal(cpMatch.value.design_rationale, 'Preserve one source of truth.');

    const decision = queryDecision(ideaDir, 'task-001');
    assert.equal(decision.authority, 'user-confirmed-plan');
    assert.equal(decision.decisions.goal_behavior, 'Return the confirmed public value.');
    assert.equal(decision.decisions.non_goal_behavior, 'Do not change serialization.');
    assert.deepEqual(decision.decisions.relevant_change_points.map(point => point.cp_id), ['CP-1']);

    const source = querySource(root, 'feature\\(', 10);
    assert.ok(source.some(line => line.includes('src/feature.js')));
    assert.deepEqual(querySource(root, 'ORACLE_SECRET_ASSERTION', 10, ideaDir), []);

    const slice = readSlice(root, 'src/feature.js', '1:2', 0, 256);
    assert.match(slice.content, /^1: import/);
    assert.match(slice.sha256, /^[a-f0-9]{64}$/);
    assert.equal(slice.truncated, false);
    assert.throws(() => readSlice(root, '../outside.txt'), /escapes selected root/);
  });
});
