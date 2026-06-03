import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  buildTraceabilityHierarchy,
  collectCrResults,
  collectTraceability,
  computeDashboardSummary,
  detectComplexity,
  formatDuration,
  formatEvidence,
  normalizeApiChangePlan,
  normalizeCoverageMatrixRefs,
  normalizeDataChangePlan,
  normalizeStepTimings,
  normalizeTaskItem,
  normalizeTasksJson,
  normalizeTraceabilityTree,
  oneSentence,
  parseTableSection,
  renderTaskChip,
  safeDomId,
} from '../scripts/dashboard.mjs';

function makeTmpDir() {
  return mkdtempSync(join(tmpdir(), 'chisel-dash-'));
}

describe('parseTableSection', () => {
  it('parses Rework Items table', () => {
    const text = [
      '## Rework Items',
      '',
      '| ID | affected_task_id | 问题描述 | 修复建议 | 严重度 | 置信度 |',
      '|----|------------------|---------|---------|--------|--------|',
      '| CR-001 [D4] | task-001 | 违反 SRP | 拆分类 | high | 90 |',
      '| CR-002 [D4] | task-002 | 硬编码 | 提取常量 | medium | 85 |',
      '',
      '## Observations (non-blocking)',
    ].join('\n');
    const items = parseTableSection(text, 'Rework Items');
    assert.equal(items.length, 2);
    assert.equal(items[0].id, 'CR-001 [D4]');
    assert.equal(items[0].affected_task_id, 'task-001');
    assert.equal(items[0]['严重度'], 'high');
    assert.equal(items[0]['置信度'], '90');
    assert.equal(items[1]['问题描述'], '硬编码');
  });

  it('returns empty array when heading not found', () => {
    const text = '## Something else\nno table here';
    assert.deepEqual(parseTableSection(text, 'Rework Items'), []);
  });

  it('returns empty array when table has no data rows', () => {
    const text = '## Rework Items\n\n| ID |\n|----|\n\n## End';
    assert.deepEqual(parseTableSection(text, 'Rework Items'), []);
  });
});

describe('detectComplexity', () => {
  let ideaDir;
  beforeEach(() => { ideaDir = makeTmpDir(); });
  afterEach(() => { rmSync(ideaDir, { recursive: true, force: true }); });

  it('returns trivial when marked', () => {
    writeFileSync(join(ideaDir, 'requirement.md'), '# R\n## 复杂度: trivial\n');
    assert.equal(detectComplexity(ideaDir), 'trivial');
  });

  it('returns standard when no requirement file', () => {
    assert.equal(detectComplexity(ideaDir), 'standard');
  });

  it('returns standard when no complexity marker', () => {
    writeFileSync(join(ideaDir, 'requirement.md'), '# Just a requirement\nsome text\n');
    assert.equal(detectComplexity(ideaDir), 'standard');
  });
});

describe('collectCrResults', () => {
  let ideaDir;
  beforeEach(() => { ideaDir = makeTmpDir(); });
  afterEach(() => { rmSync(ideaDir, { recursive: true, force: true }); });

  it('returns empty when no cr directory', () => {
    assert.deepEqual(collectCrResults(ideaDir), []);
  });

  it('parses CR files with rework items', () => {
    const crDir = join(ideaDir, 'cr');
    mkdirSync(crDir, { recursive: true });
    writeFileSync(join(crDir, 'dim-d4-cr.md'), [
      '---',
      'dimension: d4',
      'result: fail',
      '---',
      '',
      '## Rework Items',
      '',
      '| ID | affected_task_id | 问题描述 | 修复建议 | 严重度 | 置信度 |',
      '|----|------------------|---------|---------|--------|--------|',
      '| CR-001 [D4] | task-001 | SRP violation | split | high | 92 |',
      '',
      '## Observations (non-blocking)',
      '',
      '| ID | affected_task_id | 描述 | 置信度 |',
      '|----|------------------|------|--------|',
      '| OBS-001 [D4] | task-001 | naming | 65 |',
    ].join('\n'));
    const results = collectCrResults(ideaDir);
    assert.equal(results.length, 1);
    assert.equal(results[0].dimension, 'd4');
    assert.equal(results[0].result, 'fail');
    assert.equal(results[0].reworkItems.length, 1);
    assert.equal(results[0].reworkItems[0]['严重度'], 'high');
    assert.equal(results[0].observations.length, 1);
    assert.equal(results[0].observations[0]['描述'], 'naming');
  });
});

describe('dashboard normalization helpers', () => {
  it('normalizes task_id/risk_level and legacy id/risk', () => {
    assert.deepEqual(normalizeTaskItem({ task_id: 'task-001', risk_level: 'high', title: 'A', change_point_refs: ['CP-1'] }).id, 'task-001');
    assert.equal(normalizeTaskItem({ id: 'task-002', risk: 'medium' }).risk_level, 'medium');
    assert.deepEqual(normalizeTasksJson({ tasks: [{ task_id: 'task-003' }] }).map(t => t.id), ['task-003']);
  });

  it('keeps RISK outside requirement coverage', () => {
    const model = normalizeTraceabilityTree({
      traceability: {
        items: [
          { id: 'AC-001', type: 'acceptance_criteria', description: '验收项', covered_by_tasks: ['task-001'] },
          { id: 'RISK-1', type: 'risk', description: '风险项', covered_by_tasks: ['task-002'] },
        ]
      },
      clarification: null,
      tasks: [],
      taskState: { tasks: { 'task-001': { status: 'approved' }, 'task-002': { status: 'approved' } } }
    });
    assert.equal(model.total, 1);
    assert.equal(model.covered, 1);
    assert.equal(model.percentage, 100);
    assert.equal(model.riskItems.length, 1);
  });

  it('normalizes coverage matrix E/L/D/S into readable summaries', () => {
    const refs = normalizeCoverageMatrixRefs({
      entrypoints: [{ id: 'E-001', name: 'POST /orders' }],
      links: [{ id: 'L-001', from: 'Controller', to: 'Service' }],
      data: [{ id: 'D-001', entity: 'orders' }],
      side_effects: [{ id: 'S-001', kind: 'db_write' }],
    });
    assert.equal(refs.byId['E-001'].label, '入口');
    assert.match(refs.byId['L-001'].summary, /Controller/);
    assert.match(refs.byId['D-001'].summary, /orders/);
  });

  it('normalizes DB/API change plans with markdown fallback', () => {
    assert.equal(normalizeDataChangePlan({ summary: {}, entities: [{ name: 'users' }] }, null).kind, 'json');
    assert.equal(normalizeDataChangePlan(null, '## DB').kind, 'markdown');
    assert.equal(normalizeApiChangePlan({ summary: {}, endpoints: [{ path: '/x' }] }, null).kind, 'json');
    assert.equal(normalizeApiChangePlan(null, '## API').kind, 'markdown');
  });

  it('formats evidence arrays and extracts one sentence', () => {
    assert.equal(formatEvidence([{ file: 'src/a.ts', line_start: 10, line_end: 12 }]), 'src/a.ts:10-12');
    assert.equal(oneSentence('第一句说明影响。第二句更多细节。'), '第一句说明影响。');
  });

  it('formats workflow durations compactly', () => {
    assert.equal(formatDuration(12_400), '12s');
    assert.equal(formatDuration(8 * 60_000 + 3_000), '8m 03s');
    assert.equal(formatDuration(75 * 60_000), '1h 15m');
  });

  it('normalizes workflow timing from new and legacy history', () => {
    const timing = normalizeStepTimings({
      currentStep: 'implement:code',
      startedAt: '2026-06-03T10:00:00.000Z',
      lastUpdated: '2026-06-03T10:10:00.000Z',
      now: '2026-06-03T10:10:00.000Z',
      stepHistory: [
        { step: 'receive-requirement', entered_at: '2026-06-03T10:00:00.000Z', exited_at: '2026-06-03T10:01:00.000Z', duration_ms: 60_000 },
        { step: 'receive-requirement', entered_at: '2026-06-03T10:00:30.000Z' },
        { step: 'clarify:requirement', entered_at: '2026-06-03T10:01:00.000Z' },
        { step: 'implement:code', entered_at: '2026-06-03T10:04:00.000Z' },
      ]
    });

    assert.equal(timing.steps.length, 3);
    assert.equal(timing.steps[0].duration_ms, 60_000);
    assert.equal(timing.steps[1].duration_ms, 180_000);
    assert.equal(timing.steps[2].duration_ms, 360_000);
    assert.equal(timing.steps[2].running, true);
    assert.equal(timing.longest_step.step, 'implement:code');
    assert.equal(timing.total_label, '10m 00s');
  });

  it('uses last_updated_at as total end for completed workflows', () => {
    const timing = normalizeStepTimings({
      currentStep: 'done',
      startedAt: '2026-06-03T10:00:00.000Z',
      lastUpdated: '2026-06-03T10:05:00.000Z',
      now: '2026-06-03T11:00:00.000Z',
      stepHistory: [{ step: 'done', entered_at: '2026-06-03T10:05:00.000Z' }]
    });

    assert.equal(timing.total_label, '5m 00s');
    assert.equal(timing.steps[0].running, false);
  });

  it('builds traceability hierarchy from source refs and id fallback', () => {
    const model = normalizeTraceabilityTree({
      traceability: {
        items: [
          { id: 'REQ-001', type: 'requirement', description: '需求', covered_by_tasks: [] },
          { id: 'AC-001', type: 'acceptance_criteria', source_refs: ['REQ-001'], description: '验收', covered_by_tasks: [] },
          { id: 'AC-001/VC-001', type: 'verification', description: '验证', covered_by_tasks: [] },
          { id: 'AC-999', type: 'acceptance_criteria', description: '未归类', covered_by_tasks: [] },
          { id: 'RISK-1', type: 'risk', description: '风险', covered_by_tasks: [] },
        ]
      },
      clarification: null,
      tasks: [],
      taskState: { tasks: {} }
    });
    const tree = buildTraceabilityHierarchy(model);
    assert.equal(tree.roots.length, 1);
    assert.equal(tree.roots[0].item.id, 'REQ-001');
    assert.equal(tree.roots[0].children[0].item.id, 'AC-001');
    assert.equal(tree.roots[0].children[0].children[0].item.id, 'AC-001/VC-001');
    assert.deepEqual(tree.ungrouped.map(n => n.item.id), ['AC-999']);
  });

  it('creates stable DOM ids and task chips with return context', () => {
    assert.equal(safeDomId('trace', 'AC-001/VC.1 中文'), 'trace-AC-001-VC-1');
    const chip = renderTaskChip('task-001', { 'task-001': { status: 'coding' } }, {
      sourceType: 'trace',
      sourceId: 'AC-001',
      sourceLabel: 'AC-001 验收',
      returnTarget: 'trace-AC-001',
    });
    assert.match(chip, /data-task-id="task-001"/);
    assert.match(chip, /data-source-type="trace"/);
    assert.match(chip, /data-return-target="trace-AC-001"/);
  });

  it('computes dashboard summary from workflow, tasks, traceability and CR', () => {
    const summary = computeDashboardSummary({
      tasks: { 'task-001': { status: 'approved' }, 'task-002': { status: 'coding' } },
      traceabilityModel: { percentage: 50, requirementItems: [{ coverage: 'complete' }, { coverage: 'missing' }] },
      crResults: [{ reworkItems: [{ '严重度': 'high', '置信度': '90' }], observations: [{}] }],
      impactRisk: { summary: { risk_level: 'medium' } },
      currentIdx: 2,
      workflowSteps: ['a', 'b', 'c', 'd'],
    });
    assert.equal(summary.workflowPercentage, 75);
    assert.equal(summary.taskStats.percentage, 50);
    assert.equal(summary.requirementCoverage, 50);
    assert.equal(summary.missingRequirements, 1);
    assert.equal(summary.crStats.rework, 1);
    assert.equal(summary.crStats.highSeverity, 1);
    assert.equal(summary.riskLevel, 'medium');
  });
});

describe('collectTraceability', () => {
  let ideaDir;
  beforeEach(() => { ideaDir = makeTmpDir(); });
  afterEach(() => { rmSync(ideaDir, { recursive: true, force: true }); });

  it('returns null when no matrix file', () => {
    assert.equal(collectTraceability(ideaDir), null);
  });

  it('computes coverage percentage', () => {
    const tobeDir = join(ideaDir, 'to-be');
    mkdirSync(tobeDir, { recursive: true });
    writeFileSync(join(tobeDir, 'traceability-matrix.json'), JSON.stringify({
      items: [
        { id: 'REQ-1', covered_by_tasks: ['task-001'] },
        { id: 'REQ-2', covered_by_tasks: ['task-002'] },
      ]
    }));
    mkdirSync(join(ideaDir, 'tasks'), { recursive: true });
    writeFileSync(join(ideaDir, 'task-workflow-state.yaml'), [
      'tasks:',
      '  task-001:',
      '    status: approved',
      '    file: tasks/task-001.md',
      '  task-002:',
      '    status: coding',
      '    file: tasks/task-002.md',
    ].join('\n'));
    const result = collectTraceability(ideaDir);
    assert.equal(result.total, 2);
    assert.equal(result.covered, 1);
    assert.equal(result.percentage, 50);
  });
});
