import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPORT_SECTIONS, loadData } from '../scripts/report-renderers.mjs';
import { tmpdir } from 'node:os';

describe('report renderers', () => {
  it('renders requirement behavior and concrete PASS evidence for unit-test cases', () => {
    const html = REPORT_SECTIONS['unit-tests']({
      ideaName: 'demo',
      unitTestResult: {
        status: 'pass', run_summary: { total_runs: 1, failed_runs: 0, repair_count: 0, anomalies: [] },
        repositories: [{
          project_root: '/repo', coverage: {}, requirement_unit_tests: [{ status: 'A', file: 'tests/order.test.js' }],
          requirement_case_evidence: [{
            status: 'pass', test_file: 'tests/order.test.js', test_name: 'rejects insufficient stock', trace_refs: ['AC-002/VC-001'],
            given: 'stock is insufficient', when: 'checkout runs', then: 'no order is created', failure_mode: 'stock validation is removed',
            evidence: { command: 'npm test', output_excerpt: 'ok 3 - rejects insufficient stock' },
          }],
        }],
      },
    });
    for (const value of ['需求 Case 与 PASS 证据', 'AC-002/VC-001', 'no order is created', 'stock validation is removed', 'ok 3 - rejects insufficient stock']) assert.match(html, new RegExp(value));
  });

  it('exposes a current-change renderer and renders structured merge data', () => {
    assert.equal(typeof REPORT_SECTIONS['current-change'], 'function');
    const html = REPORT_SECTIONS['current-change']({
      ideaName: 'demo',
      currentChangeReport: {
        readiness: { status: 'ready_for_human_review', blockers: [] },
        repositories: [{
          repository: 'demo',
          project_root: '/tmp/demo',
          branch: 'feature/demo',
          base_commit: 'base-commit',
          head_commit: 'head-commit',
          workspace_fingerprint: 'fingerprint',
          dirty: false,
          files: [{ status: 'M', path: 'src/demo.js', additions: 4, deletions: 2, binary: false }],
          totals: { files: 1, additions: 4, deletions: 2 },
        }],
        verification: {
          status: 'passed',
          repositories: [{ project_root: '/tmp/demo', checks: [{ id: 'unit', command: 'npm test', status: 'pass', duration_ms: 12 }] }],
        },
        machine_review: {
          verdict: 'approved',
          blocking_findings: 0,
          dimensions: [{ dimension: 'd1', name: 'Correctness', result: 'pass', rework_items: 0, observations: 1 }],
          findings: [],
          observations: [{ id: 'OBS-1', description: 'non-blocking note' }],
        },
        risk: { level: 'low', highest_risk: 'none', items: [] },
      },
      currentChangeReportSha256: 'snapshot-hash',
      mergeConfirmation: { decision: 'approve', report_sha256: 'snapshot-hash', confirmed_by: 'user', confirmed_at: '2026-08-09T00:00:00Z', comment: 'Looks good' },
    });
    for (const text of ['ready_for_human_review', 'Repository scope', 'src/demo.js', 'Automated checks', 'Machine CR', 'Risk &amp; compatibility', 'approve', 'Looks good']) {
      assert.match(html, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });

  it('keeps long To-Be and CR markdown content in report sections', () => {
    const marker = 'TAIL-MARKER-KEEP-FULL';
    const planHtml = REPORT_SECTIONS['to-be']({
      ideaName: 'demo',
      implementationPlan: `${'x'.repeat(3500)}${marker}`,
      normalizedTasks: [],
      traceabilityTree: { percentage: 0, covered: 0, total: 0 },
      changePoints: [], dataChanges: null, apiChanges: null, taskDetails: {}, impactRisk: null,
    });
    assert.match(planHtml, new RegExp(marker));
    const crHtml = REPORT_SECTIONS['cr-results']({
      ideaName: 'demo',
      crResults: [{ dimension: 'd1', result: 'pass', reworkItems: [], observations: [] }],
      reviewReportMd: `${'x'.repeat(3500)}${marker}`,
    });
    assert.match(crHtml, new RegExp(marker));
  });

  it('renders hierarchical As-Is UML and a linked To-Be change journey', () => {
    const links = Array.from({ length: 14 }, (_, index) => ({
      id: `L-${String(index + 1).padStart(3, '0')}`,
      from: index === 0 ? 'Controller' : `Step${index}`,
      to: index === 13 ? 'Repository' : `Step${index + 1}`,
      kind: 'sync-call',
    }));
    const asIs = REPORT_SECTIONS['as-is']({
      ideaName: 'demo', overview: '# 摘要', coreWalkthrough: '# 走查\n```mermaid\nflowchart LR\nA --> B\n```', evidenceLedger: null, qualityScore: null,
      coverageMatrix: {
        links,
        domain_models: [
          { id: 'DM-1', name: 'Order', kind: 'aggregate_root', fields: [{ name: 'status', type: 'OrderStatus' }], operations: [{ name: 'confirm' }] },
          { id: 'DM-2', name: 'OrderLine', kind: 'entity', fields: ['sku'], operations: [] },
        ],
        domain_relationships: [{ from: 'DM-1', to: 'DM-2', kind: 'composition', from_cardinality: '1', to_cardinality: '1..*', label: 'contains' }],
      },
    });
    assert.match(asIs, /Core flow/);
    assert.match(asIs, /Controller/);
    assert.match(asIs, /L-014/, 'the full existing logic chain must not be truncated');
    assert.match(asIs, /classDiagram/);
    assert.match(asIs, /OrderStatus status/);
    assert.match(asIs, /\*--/);
    assert.doesNotMatch(asIs, /<pre class="mermaid">flowchart LR/);
    assert.match(asIs, /as-is-summary/);
    assert.doesNotMatch(asIs, /diagram-card-full/);
    assert.doesNotMatch(asIs, /as-is-overview/);
    assert.match(asIs, /阅读路径/);

    const toBe = REPORT_SECTIONS['to-be']({
      ideaName: 'demo', implementationPlan: '# 方案', normalizedTasks: [],
      traceabilityTree: { percentage: 100, covered: 1, total: 1 },
      changePoints: [{ id: 'CP-1', node: 'Service', decision: '改造', risk_level: 'medium', summary: '增加目标行为' }],
      dataChanges: null, apiChanges: null, taskDetails: {},
      impactRisk: { flow_graph: { nodes: [{ id: 'N1', label: 'Controller', decision: '保留' }, { id: 'N2', label: 'Service', decision: '改造', cp_ref: 'CP-1' }], edges: [{ from: 'N1', to: 'N2' }] }, risk_matrix: [] },
    });
    assert.match(toBe, /Target sequence/);
    assert.match(toBe, /改造链路/);
    assert.doesNotMatch(toBe, /diagram-card-(?:full|bleed)/);
    assert.match(toBe, /to-be-summary/);
    assert.match(toBe, /flowchart LR/);
    assert.match(toBe, /href="#cp-cp-1"/);
    assert.match(toBe, /id="cp-cp-1"/);
    assert.match(toBe, /完整实施方案/);
  });

  it('removes duplicate Mermaid blocks from the expanded To-Be plan', () => {
    const html = REPORT_SECTIONS['to-be']({
      ideaName: 'demo',
      implementationPlan: '# 方案\n\n```mermaid\nflowchart LR\nA --> B\n```',
      normalizedTasks: [], traceabilityTree: { percentage: 0, covered: 0, total: 0 },
      changePoints: [], dataChanges: null, apiChanges: null, taskDetails: {}, impactRisk: null,
    });
    assert.doesNotMatch(html, /<pre class="mermaid">flowchart LR/);
    assert.doesNotMatch(html, /<p>```mermaid<\/p>/);
  });

  it('sanitizes Mermaid-reserved characters in structured To-Be diagrams', () => {
    const html = REPORT_SECTIONS['to-be']({
      ideaName: 'demo', implementationPlan: '# 方案', normalizedTasks: [],
      traceabilityTree: { percentage: 100, covered: 1, total: 1 },
      changePoints: [], dataChanges: null, apiChanges: null, taskDetails: {},
      impactRisk: { flow_graph: {
        nodes: [{ id: 'N1', label: 'Controller [v2] | "entry"', decision: '保留' }, { id: 'N2', label: 'Service:save();', decision: '改造' }],
        edges: [{ from: 'N1', to: 'N2', label: 'call | async: safe' }],
      }, risk_matrix: [] },
    });
    assert.match(html, /Controller v2 entry/);
    assert.match(html, /Service：save\(\)/);
    assert.match(html, /call async： safe/);
    assert.doesNotMatch(html, /Controller \[v2\] \|/);
  });

  it('ignores a stale merge confirmation whose report hash does not match', () => {
    const ideaDir = mkdtempSync(join(tmpdir(), 'chisel-current-change-'));
    try {
      mkdirSync(join(ideaDir, 'cr'), { recursive: true });
      mkdirSync(join(ideaDir, 'confirmations'), { recursive: true });
      const report = {
        readiness: { status: 'ready_for_human_review', blockers: [] },
        repositories: [], verification: { status: 'passed', repositories: [] },
        machine_review: { verdict: 'approved', dimensions: [], findings: [], observations: [] },
        risk: { level: 'low', items: [] },
      };
      const reportText = `${JSON.stringify(report, null, 2)}\n`;
      writeFileSync(join(ideaDir, 'cr/current-change-report.json'), reportText);
      const actualHash = createHash('sha256').update(reportText).digest('hex');
      writeFileSync(join(ideaDir, 'confirmations/merge-review.json'), JSON.stringify({
        decision: 'approve', report_sha256: 'stale-hash', comment: 'STALE-CONFIRMATION',
      }));
      const loaded = loadData(ideaDir);
      assert.equal(loaded.currentChangeReportSha256, actualHash);
      assert.equal(loaded.mergeConfirmation, null);
      assert.doesNotMatch(REPORT_SECTIONS['current-change'](loaded), /STALE-CONFIRMATION|>approve</);
    } finally {
      rmSync(ideaDir, { recursive: true, force: true });
    }
  });

});
