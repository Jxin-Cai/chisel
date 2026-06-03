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
      change_point_refs: ['CP-1'],
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

function writeTaskWorkflow(ideaDir, { taskFileExtra = '', report = validTaskReport(), tasksJson = null } = {}) {
  mkdirSync(join(ideaDir, 'tasks'), { recursive: true });
  mkdirSync(join(ideaDir, 'task-reports'), { recursive: true });
  mkdirSync(join(ideaDir, 'to-be'), { recursive: true });
  writeFileSync(join(ideaDir, 'task-workflow-state.yaml'), [
    'idea: test-idea',
    'tasks:',
    '  task-001:',
    '    status: coded',
    '    depends_on: []',
    '    description: "Test task"',
    '    file: "tasks/task-001.md"',
    '    expected_files: [src/feature.js]',
    '    impact_surface: {"files":["src/feature.js"],"symbols":[],"invariants":[],"shared_state":[]}',
    '    exports: []',
    '    imports: []',
    '    report_file: "task-reports/task-001-report.md"',
    '    cr_file: "cr/task-001-cr.md"',
    '    rework_count: 0',
    '    changed_files: []',
    '    loc_added: 0',
    '    loc_deleted: 0',
    ''
  ].join('\n'));
  writeFileSync(join(ideaDir, 'tasks/task-001.md'), [
    '---',
    'task_id: task-001',
    'status: confirmed',
    'expected_files: [src/feature.js]',
    'trace_refs: [REQ-1]',
    'change_point_refs: [CP-1]',
    taskFileExtra,
    '---',
    '# Task',
    '## Behavior Invariants',
    '- [ ] existing behavior preserved',
    taskFileExtra.includes('file_plan_schema_version') ? [
      '## File-Level Plan',
      '',
      '| File | Change Type | Purpose | CP Refs | Trace Refs | Expected Symbols | Report Required |',
      '|---|---|---|---|---|---|---|',
      '| src/feature.js | modify | implement feature | CP-1 | REQ-1 | handleFeature | true |',
    ].join('\n') : '',
    ''
  ].join('\n'));
  writeFileSync(join(ideaDir, 'task-reports/task-001-report.md'), report);
  writeFileSync(join(ideaDir, 'to-be/tasks.json'), JSON.stringify(tasksJson || { schema_version: 1, tasks: [] }));
}

function validTaskReport({ fileReport = false, scopePass = true, violationsCount = 0, changedFilesCount = 1, changedFiles = ['src/feature.js'], completion = true } = {}) {
  const scopeJson = {
    schema_version: 3,
    task_id: 'task-001',
    changed_files: changedFiles,
    hit_proofs: changedFiles.map(file => ({ file, expected: [], forbidden: [], status: 'expected' })),
    violations: [],
    summary: { changed_files_count: changedFilesCount, violations_count: violationsCount },
    pass: scopePass,
  };
  return [
    '---',
    'task_id: task-001',
    'status: coded',
    'expected_files: [src/feature.js]',
    'changed_files: [src/feature.js]',
    fileReport ? 'file_report_schema_version: 1' : '',
    '---',
    '# Task Report: task-001',
    '## 做了什么',
    '实现功能。',
    '## 改了什么',
    '| 文件 | 修改点 | 是否在 expected_files 内 |',
    '|---|---|---|',
    '| src/feature.js | 修改处理逻辑 | yes |',
    fileReport ? [
      '## File-Level Implementation Report',
      '',
      '| File | Planned | Change Type | CP Refs | Trace Refs | Summary | Evidence | Status |',
      '|---|---|---|---|---|---|---|---|',
      '| src/feature.js | yes | modify | CP-1 | REQ-1 | implement feature | src/feature.js:10 | done |',
    ].join('\n') : '',
    '## Traceability Evidence',
    '| Trace Ref | Evidence | Result |',
    '|---|---|---|',
    '| REQ-1 | src/feature.js:10 | pass |',
    '## Wiki Entries Loaded',
    '| Entry | File | Why Loaded | Used For |',
    '|---|---|---|---|',
    '| None matched | 无 | 无命中 | 无 |',
    '## Progressive Load Proof',
    '- category/min-score：forbidden_zone/0.75',
    '- load_plan：按 task 上下文加载',
    '- None matched：无命中',
    '## Scope Control',
    '### Scope Check Proof',
    '- Command：`node scripts/scope-check.mjs /tmp/idea task-001`',
    `- Result：${scopePass ? 'pass' : 'fail'}`,
    '- schema_version：3',
    `- changed_files_count：${changedFilesCount}`,
    `- violations_count：${violationsCount}`,
    '- forbidden_symbol_hits_count：0',
    '#### Scope Check JSON Summary',
    '```json',
    JSON.stringify(scopeJson),
    '```',
    '#### Hit Proofs Summary',
    '| File | Expected proof | Forbidden proof | Symbol proof | Status |',
    '|---|---|---|---|---|',
    '| src/feature.js | expected | none | none | expected |',
    '#### Invariant Proofs',
    '| Invariant | Proof | Result |',
    '|---|---|---|',
    '| existing behavior preserved | src/feature.js:10 | pass |',
    completion ? [
      '## Completion Status',
      'status: DONE',
      'concerns: -',
      'missing_context: -',
      'blocker: -',
    ].join('\n') : '',
    ''
  ].filter(line => line !== '').join('\n');
}

function reportWithFileRow(row) {
  return validTaskReport({ fileReport: true }).replace('| src/feature.js | yes | modify | CP-1 | REQ-1 | implement feature | src/feature.js:10 | done |', row);
}

describe('gate-check task-report-exists file-level contract', () => {
  let ideaDir;

  beforeEach(() => { ideaDir = makeTmpDir(); });
  afterEach(() => { rmSync(ideaDir, { recursive: true, force: true }); });

  it('keeps legacy reports compatible without file-level report', () => {
    writeTaskWorkflow(ideaDir);
    const r = checkGate(ideaDir, 'task-report-exists');
    assert.equal(r.pass, true);
  });

  it('fails when new file-level task misses File-Level Implementation Report', () => {
    writeTaskWorkflow(ideaDir, { taskFileExtra: 'file_plan_schema_version: 1' });
    const r = checkGate(ideaDir, 'task-report-exists');
    assert.equal(r.pass, false);
    assert.match(r.reason, /File-Level Implementation Report/);
  });

  it('passes with complete file-level report', () => {
    writeTaskWorkflow(ideaDir, { taskFileExtra: 'file_plan_schema_version: 1', report: validTaskReport({ fileReport: true }) });
    const r = checkGate(ideaDir, 'task-report-exists');
    assert.equal(r.pass, true);
  });

  it('fails when planned file is not reported', () => {
    const report = validTaskReport({ fileReport: true }).replace('| src/feature.js | yes | modify | CP-1 | REQ-1 | implement feature | src/feature.js:10 | done |', '| src/other.js | no | modify | CP-1 | REQ-1 | extra | src/other.js:1 | extra |');
    writeTaskWorkflow(ideaDir, { taskFileExtra: 'file_plan_schema_version: 1', report });
    const r = checkGate(ideaDir, 'task-report-exists');
    assert.equal(r.pass, false);
    assert.match(r.reason, /missing planned file/);
  });

  it('fails when changed file from scope-check is not reported', () => {
    writeTaskWorkflow(ideaDir, { taskFileExtra: 'file_plan_schema_version: 1', report: validTaskReport({ fileReport: true, changedFiles: ['src/feature.js', 'src/extra.js'], changedFilesCount: 2 }) });
    const r = checkGate(ideaDir, 'task-report-exists');
    assert.equal(r.pass, false);
    assert.match(r.reason, /missing changed file/);
  });

  it('fails when file evidence is placeholder', () => {
    writeTaskWorkflow(ideaDir, { taskFileExtra: 'file_plan_schema_version: 1', report: reportWithFileRow('| src/feature.js | yes | modify | CP-1 | REQ-1 | implement feature | <文件:行号> | done |') });
    const r = checkGate(ideaDir, 'task-report-exists');
    assert.equal(r.pass, false);
    assert.match(r.reason, /Evidence/);
  });

  it('fails when Completion Status is missing', () => {
    writeTaskWorkflow(ideaDir, { taskFileExtra: 'file_plan_schema_version: 1', report: validTaskReport({ fileReport: true, completion: false }) });
    const r = checkGate(ideaDir, 'task-report-exists');
    assert.equal(r.pass, false);
    assert.match(r.reason, /Completion Status/);
  });

  it('fails when scope result and JSON pass disagree', () => {
    const report = validTaskReport({ fileReport: true }).replace('"pass":true', '"pass":false');
    writeTaskWorkflow(ideaDir, { taskFileExtra: 'file_plan_schema_version: 1', report });
    const r = checkGate(ideaDir, 'task-report-exists');
    assert.equal(r.pass, false);
    assert.match(r.reason, /Result does not match/);
  });

  it('fails when scope count text and JSON summary disagree', () => {
    const report = validTaskReport({ fileReport: true }).replace('"violations_count":0', '"violations_count":1');
    writeTaskWorkflow(ideaDir, { taskFileExtra: 'file_plan_schema_version: 1', report });
    const r = checkGate(ideaDir, 'task-report-exists');
    assert.equal(r.pass, false);
    assert.match(r.reason, /violations_count does not match/);
  });
});
