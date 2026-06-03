import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { renderTaskMarkdown, validateTasksDocument } from '../scripts/task-init.mjs';

function baseTask(overrides = {}) {
  return {
    task_id: 'task-001',
    title: 'Test task',
    goal: 'Implement feature X',
    depends_on: [],
    allowed_files: ['src/feature.js'],
    forbidden_files: ['config/'],
    expected_files: ['src/feature.js'],
    acceptance_criteria: ['AC1: feature works'],
    change_point_refs: ['CP-1'],
    trace_refs: ['REQ-1'],
    behavior_invariants: ['existing behavior preserved'],
    impact_surface: { files: ['src/feature.js'], symbols: [], invariants: [], shared_state: [] },
    context_to_load: { as_is: [], to_be: [], wiki: [], module_map: [], adr: [] },
    risk_level: 'low',
    rollback: 'revert feature.js changes',
    ...overrides,
  };
}

function filePlan(overrides = {}) {
  return {
    path: 'src/feature.js',
    change_type: 'modify',
    purpose: 'implement feature X',
    change_point_refs: ['CP-1'],
    trace_refs: ['REQ-1'],
    expected_symbols: ['handleFeature'],
    report_required: true,
    ...overrides,
  };
}

describe('task-init file_plan validation', () => {
  it('keeps schema v1 compatible without file_plan', () => {
    const tasks = validateTasksDocument({ schema_version: 1, tasks: [baseTask()] });
    assert.equal(tasks.length, 1);
  });

  it('requires file_plan for schema v2', () => {
    assert.throws(
      () => validateTasksDocument({ schema_version: 2, tasks: [baseTask()] }),
      /missing file_plan/
    );
  });

  it('requires file_plan when plan_with_file is true', () => {
    assert.throws(
      () => validateTasksDocument({ schema_version: 1, plan_with_file: true, tasks: [baseTask()] }),
      /missing file_plan/
    );
  });

  it('rejects file_plan CP refs outside task change_point_refs', () => {
    assert.throws(
      () => validateTasksDocument({ schema_version: 2, tasks: [baseTask({ file_plan: [filePlan({ change_point_refs: ['CP-99'] })] })] }),
      /unknown change_point_refs: CP-99/
    );
  });

  it('rejects file_plan trace refs outside task trace_refs', () => {
    assert.throws(
      () => validateTasksDocument({ schema_version: 2, tasks: [baseTask({ file_plan: [filePlan({ trace_refs: ['REQ-99'] })] })] }),
      /unknown trace_refs: REQ-99/
    );
  });

  it('renders Change Points and File-Level Plan into task markdown', () => {
    const markdown = renderTaskMarkdown(baseTask({ file_plan: [filePlan()] }));
    assert.match(markdown, /change_point_refs: \[CP-1\]/);
    assert.match(markdown, /file_plan_schema_version: 1/);
    assert.match(markdown, /## Change Points/);
    assert.match(markdown, /## File-Level Plan/);
    assert.match(markdown, /\| src\/feature\.js \| modify \| implement feature X \| CP-1 \| REQ-1 \| handleFeature \| true \|/);
  });
});
