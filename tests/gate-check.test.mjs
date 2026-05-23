import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkGate } from '../scripts/gate-check.mjs';

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'chisel-gate-'));
}

function writeRequirement(ideaDir, complexity = 'standard') {
  writeFileSync(join(ideaDir, 'requirement.md'), `# Req\n## 复杂度: ${complexity}\n## 涉及范围\n- a\n- b\n- c\n`);
}

function writeMinimalToBe(ideaDir) {
  const tobeDir = join(ideaDir, 'to-be');
  mkdirSync(tobeDir, { recursive: true });
  writeFileSync(join(tobeDir, 'implementation-plan.md'), [
    '# Plan',
    '## 目标行为',
    '实现 X',
    '## 非目标行为',
    '不做 Y',
    '## 允许修改范围',
    '- src/',
    '## 禁止修改范围',
    '- config/',
    '## 改造点映射',
    '| CP | file |',
    '## Task 拆分建议',
    '### task-001',
    'Acceptance Criteria:',
    '- AC1',
  ].join('\n'));
  writeFileSync(join(tobeDir, 'traceability-matrix.json'), JSON.stringify({
    schema_version: 1, items: [{ id: 'REQ-1', type: 'functional', description: 'test requirement', covered_by_tasks: ['task-001'] }]
  }));
  writeFileSync(join(tobeDir, 'tasks.json'), JSON.stringify({
    schema_version: 1,
    tasks: [{
      task_id: 'task-001',
      title: 'Test task',
      goal: 'Implement feature X',
      depends_on: [],
      allowed_files: ['src/'],
      forbidden_files: ['config/'],
      expected_files: ['src/feature.js'],
      acceptance_criteria: ['AC1: feature works'],
      trace_refs: ['REQ-1'],
      behavior_invariants: ['existing behavior preserved'],
      impact_surface: { files: ['src/feature.js'], symbols: [], invariants: [], shared_state: [] },
      context_to_load: { as_is: [], to_be: [], wiki: [], module_map: [], adr: [] },
      risk_level: 'low',
      rollback: 'revert commit',
    }]
  }));
}

function validReport() {
  return {
    schema_version: 1,
    generated_at: '2026-01-01T00:00:00Z',
    summary: { total_change_points: 2, risk_level: 'medium', description: 'test' },
    change_points: [
      { id: 'CP-1', file: 'a.js', decision: '改造', risk_level: 'low', reason: 'r' },
      { id: 'CP-2', file: 'b.js', decision: '新增', risk_level: 'medium', reason: 'r' },
    ],
    risk_matrix: [
      { id: 'RISK-1', category: '并发安全', severity: 'medium', likelihood: 'low', affected_cps: ['CP-1'] },
    ],
    reuse_nodes: [],
    flow_graph: {
      nodes: [
        { id: 'N1', label: 'start', decision: '保留' },
        { id: 'N2', label: 'new', decision: '新增', cp_ref: 'CP-2' },
      ],
      edges: [{ from: 'N1', to: 'N2' }],
    },
  };
}

describe('gate-check to-be-exists', () => {
  let ideaDir;

  beforeEach(() => {
    ideaDir = makeTmpDir();
    writeRequirement(ideaDir, 'standard');
    writeMinimalToBe(ideaDir);
  });

  afterEach(() => { rmSync(ideaDir, { recursive: true, force: true }); });

  it('passes with valid impact-risk-report', () => {
    const tobeDir = join(ideaDir, 'to-be');
    writeFileSync(join(tobeDir, 'impact-risk-report.json'), JSON.stringify(validReport()));
    const r = checkGate(ideaDir, 'to-be-exists');
    assert.equal(r.pass, true);
  });

  it('fails when schema_version missing', () => {
    const report = validReport();
    delete report.schema_version;
    writeFileSync(join(ideaDir, 'to-be/impact-risk-report.json'), JSON.stringify(report));
    const r = checkGate(ideaDir, 'to-be-exists');
    assert.equal(r.pass, false);
    assert.match(r.reason, /schema_version/);
  });

  it('fails when CP id is duplicated', () => {
    const report = validReport();
    report.change_points[1].id = 'CP-1';
    writeFileSync(join(ideaDir, 'to-be/impact-risk-report.json'), JSON.stringify(report));
    const r = checkGate(ideaDir, 'to-be-exists');
    assert.equal(r.pass, false);
    assert.match(r.reason, /duplicated/);
  });

  it('fails when affected_cps references unknown CP', () => {
    const report = validReport();
    report.risk_matrix[0].affected_cps = ['CP-99'];
    writeFileSync(join(ideaDir, 'to-be/impact-risk-report.json'), JSON.stringify(report));
    const r = checkGate(ideaDir, 'to-be-exists');
    assert.equal(r.pass, false);
    assert.match(r.reason, /CP-99/);
  });

  it('fails when edge references unknown node', () => {
    const report = validReport();
    report.flow_graph.edges[0].to = 'GHOST';
    writeFileSync(join(ideaDir, 'to-be/impact-risk-report.json'), JSON.stringify(report));
    const r = checkGate(ideaDir, 'to-be-exists');
    assert.equal(r.pass, false);
    assert.match(r.reason, /GHOST/);
  });

  it('skips impact-risk validation for trivial complexity', () => {
    writeRequirement(ideaDir, 'trivial');
    const r = checkGate(ideaDir, 'to-be-exists');
    assert.equal(r.pass, true);
  });
});
