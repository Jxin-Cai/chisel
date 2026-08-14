import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renderHumanDocuments } from '../scripts/document-render.mjs';
import { checkDocumentJob } from '../scripts/document-job.mjs';

describe('deterministic human document rendering', () => {
  it('renders as-is documents and a fresh source-bound receipt without a writer agent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chisel-doc-render-'));
    try {
      mkdirSync(join(dir, 'as-is/ai-input'), { recursive: true });
      writeFileSync(join(dir, 'requirement.md'), '# Requirement\n## Scope\n- src/a.js\n');
      writeFileSync(join(dir, 'requirement-classification.json'), JSON.stringify({ schema_version: 1 }));
      writeFileSync(join(dir, 'as-is/repo-map.json'), JSON.stringify({ risk_signals: [] }));
      writeFileSync(join(dir, 'as-is/evidence-ledger.json'), JSON.stringify({ facts: [{ id: 'F-001', claim: 'entry exists', status: 'confirmed', evidence: [{ file: 'src/a.js', line_start: 1 }] }] }));
      writeFileSync(join(dir, 'as-is/coverage-matrix.json'), JSON.stringify({ entrypoints: [{ id: 'E-001', name: 'main' }], links: [{ from: 'main', to: 'service', kind: 'call' }] }));
      writeFileSync(join(dir, 'as-is/context-budget.json'), JSON.stringify({ read_file_count: 1, read_lines: 10, coverage: '100%' }));
      for (const file of ['facts.md', 'call-graph.md', 'data-schema.md', 'api-surface.md', 'change-surface.md']) writeFileSync(join(dir, `as-is/ai-input/${file}`), file);
      const result = renderHumanDocuments(dir, 'as-is');
      assert.equal(result.status, 'complete');
      assert.equal(checkDocumentJob(dir, 'as-is').valid, true);
      assert.match(readFileSync(join(dir, 'as-is/overview.md'), 'utf8'), /无需用户确认/);
      assert.match(readFileSync(join(dir, 'as-is/core-walkthrough.md'), 'utf8'), /```mermaid/);
      assert.doesNotMatch(readFileSync(join(dir, 'as-is/core-walkthrough.md'), 'utf8'), /禁区|包袱|坏味道/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('golden-renders every canonical to-be schema field and the flow graph', () => {
    const dir = mkdtempSync(join(tmpdir(), 'chisel-plan-render-'));
    try {
      mkdirSync(join(dir, 'to-be'), { recursive: true });
      writeFileSync(join(dir, 'requirement.md'), '# Requirement\n## Scope\n- src/a.js\n');
      writeFileSync(join(dir, 'requirement-clarification.json'), JSON.stringify({ schema_version: 1 }));
      writeFileSync(join(dir, 'requirement-classification.json'), JSON.stringify({ schema_version: 1 }));
      writeFileSync(join(dir, 'to-be/design-notes.json'), JSON.stringify({
        schema_version: 1,
        generated_at: '2026-01-01T00:00:00Z',
        tl_dr: 'TLDR_MARKER：通过最小改造覆盖两个模块。',
        goal_behavior: 'GOAL_MARKER：目标行为可验证。',
        non_goal_behavior: 'NON_GOAL_MARKER：不实施无关重构。',
        strategy_overview: 'STRATEGY_MARKER：沿用现有入口并扩展服务层。',
        change_point_details: [{
          cp_id: 'CP-1', node: 'Service', decision: '改造', what: 'WHAT_MARKER', why: 'WHY_MARKER',
          current_behavior: 'CURRENT_MARKER', target_behavior: 'TARGET_MARKER',
          modification_approach: 'APPROACH_MARKER', upstream_impact: 'UPSTREAM_MARKER',
          downstream_impact: 'DOWNSTREAM_MARKER', invariants: ['INVARIANT_MARKER'],
          corresponding_tasks: ['task-001'], design_rationale: 'RATIONALE_MARKER',
        }],
        allowed_scope: [{ scope: 'src/allowed.js', reason: 'ALLOWED_REASON_MARKER', cp_refs: ['CP-1'] }],
        forbidden_scope: [{ scope: 'src/forbidden.js', reason: 'FORBIDDEN_REASON_MARKER', trigger_condition: 'TRIGGER_MARKER' }],
        historical_behaviors: ['HISTORICAL_MARKER'],
        context_to_load: { as_is: ['AS_IS_MARKER'], wiki: ['WIKI_MARKER'], module_map: ['MODULE_MAP_MARKER'], adr: ['ADR_MARKER'] },
        verification_surface: ['VERIFICATION_MARKER'],
        rollback_plan: 'ROLLBACK_MARKER',
        self_check: {
          companion_changes: [{ cp: 'CP-1', rule: 'COMPANION_RULE_MARKER', companion: 'COMPANION_MARKER', arranged_in: 'task-001', notes: 'COMPANION_NOTES_MARKER' }],
          spec_coverage: { total_ac: 1, covered: 1, uncovered: ['UNCOVERED_MARKER'] },
          cp_task_consistency: 'CP_TASK_MARKER',
          file_plan_completeness: [{ task: 'task-001', cp_covered: true, trace_covered: true, no_forbidden: true, companion_included: true, marker: 'FILE_PLAN_MARKER' }],
          dependency_completeness: 'DEPENDENCY_MARKER',
          reverse_detection: [{ file: 'src/reverse.js', discovered_relation: 'RELATION_MARKER', action: 'ACTION_MARKER' }],
          verification: 'SELF_CHECK_VERIFICATION_MARKER',
        },
      }));
      writeFileSync(join(dir, 'to-be/tasks.json'), JSON.stringify({ tasks: [{ task_id: 'task-001', description: 'implement', expected_files: ['src/a.js'], trace_refs: ['AC-001'] }] }));
      writeFileSync(join(dir, 'to-be/traceability-matrix.json'), JSON.stringify({ schema_version: 1 }));
      writeFileSync(join(dir, 'to-be/impact-risk-report.json'), JSON.stringify({
        change_points: [{ id: 'CP-1', summary: 'change A', decision: '改造' }],
        flow_graph: {
          nodes: [
            { id: 'N1', label: 'Controller', decision: '保留' },
            { id: 'N2', label: 'Service', decision: '改造', cp_ref: 'CP-1' },
          ],
          edges: [{ from: 'N1', to: 'N2', label: 'FLOW_EDGE_MARKER' }],
        },
      }));
      renderHumanDocuments(dir, 'to-be');
      assert.equal(checkDocumentJob(dir, 'to-be').valid, true);
      const plan = readFileSync(join(dir, 'to-be/implementation-plan.md'), 'utf8');
      for (const marker of [
        'TLDR_MARKER', 'GOAL_MARKER', 'NON_GOAL_MARKER', 'STRATEGY_MARKER',
        'Schema v1', '2026-01-01T00:00:00Z',
        'WHAT_MARKER', 'WHY_MARKER', 'CURRENT_MARKER', 'TARGET_MARKER', 'APPROACH_MARKER',
        'UPSTREAM_MARKER', 'DOWNSTREAM_MARKER', 'INVARIANT_MARKER', 'RATIONALE_MARKER',
        'src/allowed.js', 'ALLOWED_REASON_MARKER', 'src/forbidden.js', 'FORBIDDEN_REASON_MARKER', 'TRIGGER_MARKER',
        'HISTORICAL_MARKER', 'AS_IS_MARKER', 'WIKI_MARKER', 'MODULE_MAP_MARKER', 'ADR_MARKER',
        'VERIFICATION_MARKER', 'ROLLBACK_MARKER', 'COMPANION_RULE_MARKER', 'COMPANION_MARKER', 'COMPANION_NOTES_MARKER',
        'UNCOVERED_MARKER', 'CP_TASK_MARKER', 'FILE_PLAN_MARKER', 'DEPENDENCY_MARKER', 'src/reverse.js',
        'RELATION_MARKER', 'ACTION_MARKER', 'SELF_CHECK_VERIFICATION_MARKER', 'FLOW_EDGE_MARKER', 'Controller', 'Service', 'task-001',
      ]) assert.match(plan, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      assert.match(plan, /```mermaid\nflowchart LR/);
      assert.match(plan, /Service<br\/>改造<br\/>CP-1/);
      assert.match(plan, /确定性渲染/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
