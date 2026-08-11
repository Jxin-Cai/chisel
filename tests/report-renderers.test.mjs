import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPORT_SECTIONS, loadData } from '../scripts/report-renderers.mjs';
import { tmpdir } from 'node:os';

describe('report renderers', () => {
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
    const asIs = REPORT_SECTIONS['as-is']({
      ideaName: 'demo', overview: '# 摘要', coreWalkthrough: '# 走查', evidenceLedger: null, qualityScore: null,
      coverageMatrix: { links: [{ from: 'Controller', to: 'Service', kind: 'sync-call' }] },
    });
    assert.match(asIs, /UML Sequence/);
    assert.match(asIs, /Controller/);
    assert.match(asIs, /<details[^>]+as-is-overview[^>]+open/);
    assert.match(asIs, /阅读路径/);

    const toBe = REPORT_SECTIONS['to-be']({
      ideaName: 'demo', implementationPlan: '# 方案', normalizedTasks: [],
      traceabilityTree: { percentage: 100, covered: 1, total: 1 },
      changePoints: [{ id: 'CP-1', node: 'Service', decision: '改造', risk_level: 'medium', summary: '增加目标行为' }],
      dataChanges: null, apiChanges: null, taskDetails: {},
      impactRisk: { flow_graph: { nodes: [{ id: 'N1', label: 'Controller', decision: '保留' }, { id: 'N2', label: 'Service', decision: '改造', cp_ref: 'CP-1' }], edges: [{ from: 'N1', to: 'N2' }] }, risk_matrix: [] },
    });
    assert.match(toBe, /UML Target Model/);
    assert.match(toBe, /改造点全链路/);
    assert.match(toBe, /href="#cp-cp-1"/);
    assert.match(toBe, /id="cp-cp-1"/);
    assert.match(toBe, /完整实施方案/);
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
