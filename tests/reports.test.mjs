import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { generateReports, REPORTS } from '../scripts/reports.mjs';
import { recordReportConfirmation, reportStatus } from '../scripts/report-confirm.mjs';

describe('standalone HTML reports', () => {
  it('defines exactly four report deliverables', () => {
    assert.deepEqual(Object.keys(REPORTS), ['as-is', 'to-be', 'cr', 'task-time']);
    assert.deepEqual(Object.values(REPORTS).map(report => report.file), [
      'as-is-report.html', 'to-be-report.html', 'cr-report.html', 'task-time-report.html'
    ]);
  });

  it('generates four self-contained, independently titled HTML files', () => {
    const ideaDir = mkdtempSync(join(tmpdir(), 'chisel-reports-'));
    try {
      mkdirSync(join(ideaDir, 'as-is'), { recursive: true });
      mkdirSync(join(ideaDir, 'to-be'), { recursive: true });
      mkdirSync(join(ideaDir, 'cr'), { recursive: true });
      writeFileSync(join(ideaDir, 'requirement.md'), '# Requirement\n');
      writeFileSync(join(ideaDir, 'as-is/overview.md'), '# Current state\nAS-IS-MARKER\n');
      writeFileSync(join(ideaDir, 'to-be/implementation-plan.md'), '# Target state\nTO-BE-MARKER\n');
      writeFileSync(join(ideaDir, 'to-be/tasks.json'), JSON.stringify({ tasks: [{ task_id: 'task-001', title: 'Implement report flow' }] }));
      writeFileSync(join(ideaDir, 'cr/review-report.md'), '# Review\nCR-MARKER\n');
      writeFileSync(join(ideaDir, 'cr/dim-d4-cr.md'), '---\ndimension: d4\nresult: pass\n---\n');
      writeFileSync(join(ideaDir, 'workflow-state.yaml'), 'current_step: implement:code\nstarted_at: 2026-08-10T00:00:00.000Z\nlast_updated_at: 2026-08-10T00:01:00.000Z\nstep_history:\n');
      writeFileSync(join(ideaDir, 'task-workflow-state.yaml'), 'tasks:\n  task-001:\n    status: coding\n');

      const generatedReports = Object.keys(REPORTS).map(type => generateReports(ideaDir, [type]).generated[0]);
      assert.equal(generatedReports.length, 4);
      for (const generated of generatedReports) {
        const { path } = generated;
        assert.ok(existsSync(path));
        assert.equal(generated.confirmation_required, true);
        assert.equal(generated.confirmed, false);
        const html = readFileSync(path, 'utf8');
        assert.match(html, /^<!doctype html>/);
        assert.match(html, /<style>[^]*:root/);
        assert.doesNotMatch(html, /工作流总览.*As-Is.*To-Be.*CR/s);
      }
      assert.match(readFileSync(join(ideaDir, 'reports/as-is-report.html'), 'utf8'), /AS-IS-MARKER/);
      assert.match(readFileSync(join(ideaDir, 'reports/as-is-report.html'), 'utf8'), /UML Model|UML Sequence/);
      assert.match(readFileSync(join(ideaDir, 'reports/to-be-report.html'), 'utf8'), /TO-BE-MARKER/);
      assert.match(readFileSync(join(ideaDir, 'reports/to-be-report.html'), 'utf8'), /UML Target Model/);
      assert.match(readFileSync(join(ideaDir, 'reports/to-be-report.html'), 'utf8'), /改造点全链路/);
      assert.match(readFileSync(join(ideaDir, 'reports/cr-report.html'), 'utf8'), /CR-MARKER/);
      const work = readFileSync(join(ideaDir, 'reports/task-time-report.html'), 'utf8');
      assert.match(work, /任务与耗时/);
      assert.match(work, /task-001/);
    } finally {
      rmSync(ideaDir, { recursive: true, force: true });
    }
  });

  it('refuses batch generation so every report can be confirmed before continuing', () => {
    const ideaDir = mkdtempSync(join(tmpdir(), 'chisel-report-sequence-'));
    try {
      assert.throws(() => generateReports(ideaDir, ['as-is', 'to-be']), /只能生成一份报告/);
      assert.throws(() => generateReports(ideaDir), /只能生成一份报告/);
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
