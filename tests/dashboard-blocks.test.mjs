import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BLOCKS } from '../scripts/dashboard-blocks.mjs';
import { loadData } from '../scripts/dashboard-blocks.mjs';
import { tmpdir } from 'node:os';

const templatePath = join(process.cwd(), 'scripts/assets/dashboard-template.html');

describe('dashboard blocks', () => {
  it('exposes a current-change renderer and renders structured merge data', () => {
    assert.equal(typeof BLOCKS['current-change'], 'function');
    const html = BLOCKS['current-change']({
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
    for (const text of ['当前变更', 'ready_for_human_review', 'Repository scope', 'src/demo.js', 'Automated checks', 'Machine CR', 'Risk &amp; compatibility', 'approve', 'Looks good']) {
      assert.match(html, new RegExp(text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    }
  });

  it('keeps long To-Be and CR markdown content in the block pages', () => {
    const marker = 'TAIL-MARKER-KEEP-FULL';
    const planHtml = BLOCKS['to-be']({
      ideaName: 'demo',
      implementationPlan: `${'x'.repeat(3500)}${marker}`,
      normalizedTasks: [],
      traceabilityTree: { percentage: 0, covered: 0, total: 0 },
      changePoints: [], dataChanges: null, apiChanges: null, taskDetails: {}, impactRisk: null,
    });
    assert.match(planHtml, new RegExp(marker));
    const crHtml = BLOCKS['cr-results']({
      ideaName: 'demo',
      crResults: [{ dimension: 'd1', result: 'pass', reworkItems: [], observations: [] }],
      reviewReportMd: `${'x'.repeat(3500)}${marker}`,
    });
    assert.match(crHtml, new RegExp(marker));
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
      assert.doesNotMatch(BLOCKS['current-change'](loaded), /STALE-CONFIRMATION|>approve</);
    } finally {
      rmSync(ideaDir, { recursive: true, force: true });
    }
  });

  it('template includes resilient navigation, animation and accessibility fallbacks', () => {
    const template = readFileSync(templatePath, 'utf8');
    for (const marker of [
      'id="sideNav"',
      'IntersectionObserver',
      'scrollIntoView',
      'prefers-reduced-motion',
      "typeof ScrollTrigger !== 'undefined'",
      '动画库未加载',
      '@media print',
      'data-theme="dark"',
    ]) assert.match(template, new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), marker);
  });
});
