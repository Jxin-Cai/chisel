import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkGate } from '../scripts/gate-check.mjs';

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'chisel-gate-'));
}

function writeRequirement(ideaDir, complexity = 'standard') {
  writeFileSync(join(ideaDir, 'requirement.md'), `# Req\n## 复杂度: ${complexity}\n## 涉及范围\n- a\n- b\n- c\n`);
}

describe('gate-check CLI workflow-step compatibility', () => {
  let ideaDir;

  beforeEach(() => {
    ideaDir = makeTmpDir();
    writeRequirement(ideaDir);
  });

  afterEach(() => { rmSync(ideaDir, { recursive: true, force: true }); });

  it('maps a workflow step to its postcondition gate', () => {
    const result = checkGate(ideaDir, 'receive-requirement');
    assert.deepEqual(result, { pass: true, gate: 'requirement-exists' });
  });

  it('accepts both canonical and reversed CLI argument order for known workflow steps', () => {
    const script = join(process.cwd(), 'scripts/gate-check.mjs');
    for (const args of [[ideaDir, 'receive-requirement'], ['receive-requirement', ideaDir]]) {
      const run = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
      assert.equal(run.status, 0, run.stderr || run.stdout);
      assert.deepEqual(JSON.parse(run.stdout), { pass: true, gate: 'requirement-exists' });
    }
  });
});

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

  it('rejects a task report when an acceptance criterion is missing or failed', () => {
    writeTaskWorkflow(ideaDir, { taskFileExtra: 'file_plan_schema_version: 1', report: validTaskReport({ fileReport: true }) });
    const taskPath = join(ideaDir, 'tasks/task-001.md');
    writeFileSync(taskPath, `${readFileSync(taskPath, 'utf8')}\n## Acceptance Criteria\n- [ ] AC-001: observable behavior\n`);
    let result = checkGate(ideaDir, 'task-report-exists');
    assert.equal(result.pass, false);
    assert.match(result.reason, /Acceptance Criteria Result/);

    const reportPath = join(ideaDir, 'task-reports/task-001-report.md');
    const report = readFileSync(reportPath, 'utf8').replace('## Completion Status', [
      '## Acceptance Criteria Result',
      '| AC | Evidence | Result |',
      '|---|---|---|',
      '| AC-001 | node --test tests/feature.test.mjs | fail |',
      '',
      '## Completion Status',
    ].join('\n'));
    writeFileSync(reportPath, report);
    result = checkGate(ideaDir, 'task-report-exists');
    assert.equal(result.pass, false);
    assert.match(result.reason, /must be pass/);
  });
});

describe('requirement completeness gates', () => {
  let ideaDir;
  beforeEach(() => {
    ideaDir = makeTmpDir();
    mkdirSync(join(ideaDir, 'to-be'), { recursive: true });
    mkdirSync(join(ideaDir, 'tasks'), { recursive: true });
  });
  afterEach(() => rmSync(ideaDir, { recursive: true, force: true }));

  function writeApprovedTask(traceRefs) {
    writeFileSync(join(ideaDir, 'task-workflow-state.yaml'), [
      'idea: completeness', 'tasks:', '  task-001:', '    status: approved',
      '    file: tasks/task-001.md', '    depends_on: []', '',
    ].join('\n'));
    writeFileSync(join(ideaDir, 'tasks/task-001.md'), `---\ntask_id: task-001\ntrace_refs: [${traceRefs.join(', ')}]\n---\n# Task\n`);
  }

  it('fails final traceability when the matrix is missing or omits an AC', () => {
    writeApprovedTask(['AC-001', 'AC-002']);
    assert.equal(checkGate(ideaDir, 'traceability-complete').pass, false);
    writeFileSync(join(ideaDir, 'requirement-clarification.json'), JSON.stringify({
      schema_version: 1,
      dimensions: { acceptance_criteria: [
        { id: 'AC-001', description: 'one' },
        { id: 'AC-002', description: 'two' },
        { id: 'AC-003', description: 'three' },
      ] },
    }));
    writeFileSync(join(ideaDir, 'to-be/traceability-matrix.json'), JSON.stringify({ schema_version: 2, items: [
      { id: 'AC-001', type: 'acceptance_criteria', description: 'one', source_refs: ['AC-001'], covered_by_tasks: ['task-001'] },
      { id: 'AC-002', type: 'acceptance_criteria', description: 'two', source_refs: ['AC-002'], covered_by_tasks: ['task-001'] },
    ] }));
    const result = checkGate(ideaDir, 'traceability-complete');
    assert.equal(result.pass, false);
    assert.match(result.reason, /AC-003/);
  });

  it('binds an adversarial pass to every AC/VC and the exact source hashes', () => {
    writeFileSync(join(ideaDir, 'requirement.md'), '# Requirement\n\ncomplete behavior\n');
    writeFileSync(join(ideaDir, 'requirement-clarification.json'), JSON.stringify({ dimensions: { acceptance_criteria: [
      { id: 'AC-001', description: 'behavior', verification_conditions: [{ id: 'VC-001', condition: 'observable result' }] },
    ] } }));
    writeFileSync(join(ideaDir, 'to-be/implementation-plan.md'), '# Plan\n\ncomplete\n');
    writeFileSync(join(ideaDir, 'to-be/tasks.json'), JSON.stringify({ tasks: [{
      task_id: 'task-001', expected_files: ['src/feature.js'], allowed_files: ['src/feature.js'],
      trace_refs: ['AC-001', 'VC-001'], change_point_refs: ['CP-001'], file_plan: [{ path: 'src/feature.js' }],
    }] }));
    writeFileSync(join(ideaDir, 'to-be/traceability-matrix.json'), JSON.stringify({ items: [
      { id: 'AC-001', source_refs: ['AC-001'], covered_by_tasks: ['task-001'], cp_refs: ['CP-001', 'CP-002'], coverage_refs: ['AC-001'] },
      { id: 'VC-001', source_refs: ['VC-001'], covered_by_tasks: ['task-001'], cp_refs: ['CP-001', 'CP-002'], coverage_refs: ['VC-001'] },
    ] }));
    writeFileSync(join(ideaDir, 'to-be/impact-risk-report.json'), JSON.stringify({ change_points: [
      { id: 'CP-001', file: 'src/feature.js' }, { id: 'CP-002', file: 'src/unrelated.js' },
    ] }));
    writeFileSync(join(ideaDir, 'to-be/adversarial-review.md'), '# Review\n\n## 审查范围\n全部需求\n\n## 结论\npass\n');
    const files = ['requirement.md', 'requirement-clarification.json', 'to-be/implementation-plan.md', 'to-be/tasks.json', 'to-be/traceability-matrix.json', 'to-be/impact-risk-report.json'];
    const reviewedFiles = files.map(path => ({ path, sha256: createHash('sha256').update(readFileSync(join(ideaDir, path))).digest('hex') }));
    const coverage = ['AC-001', 'AC-001/VC-001'].map(source_ref => ({
      source_ref, status: 'pass', task_refs: ['task-001'], change_point_refs: ['CP-001'],
      file_refs: ['src/feature.js'], verification_refs: [source_ref.split('/').at(-1)], evidence: 'task/file/test chain independently reviewed',
    }));
    writeFileSync(join(ideaDir, 'to-be/adversarial-review.json'), JSON.stringify({
      schema_version: 1, source_step: 'plan:adversarial-review', status: 'pass', attempt: 1,
      findings: [], unresolved_findings: [], reviewed_files: reviewedFiles,
      requirement_coverage: coverage, evidence: ['AC/VC to implementation and verification chain checked'],
    }));
    assert.equal(checkGate(ideaDir, 'to-be-adversarial-approved').pass, true);
    const reviewPath = join(ideaDir, 'to-be/adversarial-review.json');
    const review = JSON.parse(readFileSync(reviewPath));
    review.requirement_coverage[0].change_point_refs = ['CP-FAKE'];
    writeFileSync(reviewPath, JSON.stringify(review));
    assert.match(checkGate(ideaDir, 'to-be-adversarial-approved').reason, /unknown change points/);
    review.requirement_coverage[0].change_point_refs = ['CP-001'];
    writeFileSync(reviewPath, JSON.stringify(review));
    review.requirement_coverage[0].change_point_refs = ['CP-002'];
    review.requirement_coverage[0].file_refs = ['src/unrelated.js'];
    writeFileSync(reviewPath, JSON.stringify(review));
    assert.match(checkGate(ideaDir, 'to-be-adversarial-approved').reason, /selected tasks/);
    review.requirement_coverage[0].change_point_refs = ['CP-001'];
    review.requirement_coverage[0].file_refs = ['src/feature.js'];
    writeFileSync(reviewPath, JSON.stringify(review));
    writeFileSync(join(ideaDir, 'to-be/implementation-plan.md'), '# Plan\n\nchanged after review\n');
    const result = checkGate(ideaDir, 'to-be-adversarial-approved');
    assert.equal(result.pass, false);
    assert.match(result.reason, /stale/);
  });
});

describe('gate-check integration-cr-complete', () => {
  let ideaDir;

  beforeEach(() => {
    ideaDir = makeTmpDir();
    mkdirSync(join(ideaDir, 'cr'), { recursive: true });
  });
  afterEach(() => rmSync(ideaDir, { recursive: true, force: true }));

  it('accepts a structurally complete passing integration review', () => {
    writeFileSync(join(ideaDir, 'cr/dim-integration-cr.md'), [
      '---',
      'dimension: integration',
      'result: pass',
      'affected_tasks: [task-001, task-002]',
      'rework_count: 0',
      '---',
      '# Integration CR',
      '## 结论',
      'PASS',
      '## Task 交互矩阵',
      '| Task A | Task B | 交互点 | 状态 |',
      '|---|---|---|---|',
      '| task-001 | task-002 | API | OK |',
      '## Rework Items',
      '无',
    ].join('\n'));
    assert.equal(checkGate(ideaDir, 'integration-cr-complete').pass, true);
  });

  it('rejects a failed review without a concrete rework item', () => {
    writeFileSync(join(ideaDir, 'cr/dim-integration-cr.md'), [
      '---',
      'dimension: integration',
      'result: fail',
      'affected_tasks: [task-001]',
      'rework_count: 0',
      '---',
      '## 结论',
      'FAIL',
      '## Task 交互矩阵',
      '存在问题',
      '## Rework Items',
      '待补充',
    ].join('\n'));
    const result = checkGate(ideaDir, 'integration-cr-complete');
    assert.equal(result.pass, false);
    assert.match(result.reason, /CR-INT/);
  });
});

describe('gate-check dynamic review selection contract', () => {
  let ideaDir;
  beforeEach(() => {
    ideaDir = makeTmpDir();
    mkdirSync(join(ideaDir, 'cr'), { recursive: true });
    writeFileSync(join(ideaDir, 'task-workflow-state.yaml'), [
      'idea: dynamic-review', 'tasks:', '  task-001:', '    status: approved',
      '    file: tasks/task-001.md', '    depends_on: []', '',
    ].join('\n'));
  });
  afterEach(() => rmSync(ideaDir, { recursive: true, force: true }));

  it('validates only selected dimensions and accepts their reference to the spec scope proof', () => {
    writeFileSync(join(ideaDir, 'cr', 'review-selection.json'), JSON.stringify({
      schema_version: 1,
      dimensions: ['spec', 'd8'],
      skipped_dimensions: ['d2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd9'],
      reasons: [{ rule: 'external-boundary', reason: 'API change', dimensions: ['d8'] }],
      compatibility_projection: Object.fromEntries(['d2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd9'].map(dimension => [dimension, { status: 'skipped', result: 'auto-pass' }])),
    }));
    writeFileSync(join(ideaDir, 'cr', 'dim-spec-cr.md'), [
      '---', 'dimension: spec', 'result: pass', 'affected_tasks: []', 'rework_count: 0', '---',
      '## 结论', 'PASS', '## Acceptance Criteria 覆盖', 'pass', '## Expected Files 覆盖', 'pass',
      '## Scope Check Proof', '- Command: `node scripts/scope-check.mjs /tmp/idea task-001`',
      '- Result: pass', '- schema_version: 4', '- violations_count: 0',
      '#### Hit Proofs Reviewed', '无变更', '#### Invariant Proofs', '无声明的不变量',
    ].join('\n'));
    writeFileSync(join(ideaDir, 'cr', 'dim-d8-cr.md'), [
      '---', 'dimension: d8', 'result: pass', 'affected_tasks: []', 'rework_count: 0', '---',
      '## 结论', 'PASS', '## 检查结果', '全部通过',
      '## Scope Check Proof', '见 `cr/dim-spec-cr.md`。', '## Rework Items', '无',
    ].join('\n'));

    const result = checkGate(ideaDir, 'cr-complete');
    assert.equal(result.pass, true, result.reason);
    assert.deepEqual(result.dimensions, ['spec', 'd8']);
  });
});

describe('gate-check done state integrity', () => {
  let ideaDir;
  beforeEach(() => { ideaDir = makeTmpDir(); });
  afterEach(() => { rmSync(ideaDir, { recursive: true, force: true }); });

  it('rejects a stale .done marker while tasks are not approved', () => {
    mkdirSync(join(ideaDir, 'task-reports'), { recursive: true });
    writeFileSync(join(ideaDir, 'task-workflow-state.yaml'), [
      'idea: idea',
      'tasks:',
      '  task-001:',
      '    status: coded',
      '    depends_on: []',
      '    description: task',
      '    file: tasks/task-001.md',
      '    expected_files: []',
      '    report_file: task-reports/task-001-report.md',
      '    cr_file: cr/task-001-cr.md',
      '    rework_count: 0',
      '    changed_files: []',
      '    loc_added: 0',
      '    loc_deleted: 0',
    ].join('\n'));
    writeFileSync(join(ideaDir, '.done'), 'done\n');
    writeFileSync(join(ideaDir, 'final-summary.md'), '# Final\n## 变更摘要\nchange\n## Scope Control Summary\nscope-check pass\n');
    assert.match(checkGate(ideaDir, 'done').reason, /not all tasks are approved/);
  });
});
