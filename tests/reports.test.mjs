import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateReports, REPORTS } from '../scripts/reports.mjs';
import { recordReportConfirmation, reportReadyStatus, reportStatus } from '../scripts/report-confirm.mjs';

describe('standalone HTML reports', () => {
  it('defines exactly five focused report deliverables', () => {
    assert.deepEqual(Object.keys(REPORTS), ['as-is', 'to-be', 'test', 'cr', 'task-time']);
    assert.deepEqual(Object.values(REPORTS).map(report => report.file), [
      'as-is-report.html', 'to-be-report.html', 'test-report.html', 'cr-report.html', 'task-time-report.html'
    ]);
  });

  it('generates five self-contained, independently titled HTML files', () => {
    const ideaDir = mkdtempSync(join(tmpdir(), 'chisel-reports-'));
    try {
      mkdirSync(join(ideaDir, 'as-is'), { recursive: true });
      mkdirSync(join(ideaDir, 'to-be'), { recursive: true });
      mkdirSync(join(ideaDir, 'cr'), { recursive: true });
      writeFileSync(join(ideaDir, 'requirement.md'), '# Requirement\n## Goal\nGenerate focused reports\n');
      writeFileSync(join(ideaDir, 'as-is/overview.md'), '# Current state\nAS-IS-MARKER\n');
      writeFileSync(join(ideaDir, 'to-be/implementation-plan.md'), '# Target state\nTO-BE-MARKER\n');
      writeFileSync(join(ideaDir, 'to-be/tasks.json'), JSON.stringify({ tasks: [{ task_id: 'task-001', title: 'Implement report flow' }] }));
      writeFileSync(join(ideaDir, 'cr/review-report.md'), '# Review\nCR-MARKER\n');
      writeFileSync(join(ideaDir, 'unit-test-result.json'), JSON.stringify({ schema_version: 1, status: 'pass', repositories: [{ project_root: '/repo', coverage: { lines: { pct: 91 }, statements: { pct: 90 }, functions: { pct: 89 }, branches: { pct: 88 } }, requirement_unit_tests: [{ status: 'A', file: 'tests/new.test.mjs' }] }], run_summary: { total_runs: 2, failed_runs: 1, repair_count: 1, anomalies: [] } }));
      writeFileSync(join(ideaDir, 'cr/dim-d4-cr.md'), '---\ndimension: d4\nresult: pass\n---\n');
      writeFileSync(join(ideaDir, 'workflow-state.yaml'), 'current_step: implement:code\nstarted_at: 2026-08-10T00:00:00.000Z\nlast_updated_at: 2026-08-10T00:01:00.000Z\nstep_history:\n');
      writeFileSync(join(ideaDir, 'task-workflow-state.yaml'), 'tasks:\n  task-001:\n    status: coding\n');

      const generatedReports = Object.keys(REPORTS).map(type => generateReports(ideaDir, [type]).generated[0]);
      assert.equal(generatedReports.length, 5);
      for (const generated of generatedReports) {
        const { path } = generated;
        assert.ok(existsSync(path));
        assert.equal(generated.confirmation_required, generated.report_type === 'to-be');
        assert.equal(generated.ready, true);
        assert.equal(generated.confirmed, generated.report_type === 'to-be' ? false : null);
        const html = readFileSync(path, 'utf8');
        assert.match(html, /^<!doctype html>/);
        assert.match(html, /<style>[^]*:root/);
        assert.match(html, /mermaid@11\/dist\/mermaid\.esm\.min\.mjs/);
        assert.match(html, /mermaid\.run\(\{ nodes: diagrams/);
        assert.doesNotMatch(html, /工作流总览.*As-Is.*To-Be.*CR/s);
      }
      assert.match(readFileSync(join(ideaDir, 'reports/as-is-report.html'), 'utf8'), /AS-IS-MARKER/);
      assert.match(readFileSync(join(ideaDir, 'reports/as-is-report.html'), 'utf8'), /UML Model|UML Sequence/);
      assert.match(readFileSync(join(ideaDir, 'reports/to-be-report.html'), 'utf8'), /TO-BE-MARKER/);
      assert.match(readFileSync(join(ideaDir, 'reports/to-be-report.html'), 'utf8'), /UML Target Model/);
      assert.match(readFileSync(join(ideaDir, 'reports/to-be-report.html'), 'utf8'), /改造点全链路/);
      assert.match(readFileSync(join(ideaDir, 'reports/test-report.html'), 'utf8'), /单测与覆盖率/);
      assert.match(readFileSync(join(ideaDir, 'reports/test-report.html'), 'utf8'), /tests\/new\.test\.mjs/);
      assert.match(readFileSync(join(ideaDir, 'reports/cr-report.html'), 'utf8'), /CR-MARKER/);
      const work = readFileSync(join(ideaDir, 'reports/task-time-report.html'), 'utf8');
      assert.match(work, /任务与耗时/);
      assert.match(work, /task-001/);
      assert.match(work, /receive-requirement<\/td><td><span[^>]*>已完成<\/span>/, 'passed gates must not be reported as pending when legacy history is incomplete');
    } finally {
      rmSync(ideaDir, { recursive: true, force: true });
    }
  });

  it('supports batch generation while keeping only to-be decision-blocking', () => {
    const ideaDir = mkdtempSync(join(tmpdir(), 'chisel-report-sequence-'));
    try {
      writeFileSync(join(ideaDir, 'requirement.md'), '# Requirement\n## Scope\n- reports\n');
      const generated = generateReports(ideaDir, ['as-is', 'to-be']).generated;
      assert.deepEqual(generated.map(item => item.confirmation_required), [false, true]);
      assert.equal(reportReadyStatus(ideaDir, 'as-is').valid, true);
      assert.equal(reportStatus(ideaDir, 'to-be').valid, false);
      assert.throws(() => generateReports(ideaDir), /至少指定一份报告/);
    } finally {
      rmSync(ideaDir, { recursive: true, force: true });
    }
  });

  it('binds user confirmation to the exact generated report hash', () => {
    const ideaDir = mkdtempSync(join(tmpdir(), 'chisel-report-confirm-'));
    try {
      writeFileSync(join(ideaDir, 'requirement.md'), '# Requirement\n## Scope\n- report\n');
      const first = generateReports(ideaDir, ['task-time']).generated[0];
      assert.equal(reportStatus(ideaDir, 'task-time').valid, false);
      assert.throws(() => recordReportConfirmation(ideaDir, 'task-time', 'stale'), /report changed before confirmation/);
      recordReportConfirmation(ideaDir, 'task-time', first.sha256, '确认继续');
      assert.equal(reportStatus(ideaDir, 'task-time').valid, true);

      writeFileSync(join(ideaDir, 'final-summary.md'), '# changed after confirmation\n');
      assert.equal(reportStatus(ideaDir, 'task-time').valid, false, 'source changes must invalidate the rendered report and confirmation');

      generateReports(ideaDir, ['task-time']);
      assert.equal(reportStatus(ideaDir, 'task-time').valid, false, 'regeneration must invalidate the prior confirmation');
    } finally {
      rmSync(ideaDir, { recursive: true, force: true });
    }
  });
});
