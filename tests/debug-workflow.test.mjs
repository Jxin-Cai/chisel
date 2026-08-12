import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createDebugReport, DEBUG_PHASES, updateDebugReport, validateDebugReport } from '../scripts/debug-workflow.mjs';

describe('chisel-debug contract', () => {
  it('is reproduce-first and returns a handoff in repair-diagnosis mode', () => {
    const report = createDebugReport({ taskId: 'task-1' });
    assert.deepEqual(report.phases.map(phase => phase.name), DEBUG_PHASES);
    assert.deepEqual(report.phases.map(phase => phase.label_zh), ['初步研判', '复现', '环境核验', '链路追踪', '根因确认', '修复策略']);
    assert.equal(validateDebugReport(report).valid, true);
    const triaged = updateDebugReport(report, { phase: 'triage', status: 'completed', evidence: ['CR-001'] });
    const reproduced = updateDebugReport(triaged, { phase: 'reproduce', status: 'completed', evidence: ['repro command'] });
    const sane = updateDebugReport(reproduced, { phase: 'environment_sanity', status: 'completed', evidence: ['runtime matches'] });
    const traced = updateDebugReport(sane, { phase: 'trace', status: 'completed', evidence: ['call path'] });
    const root = updateDebugReport(traced, { phase: 'root_cause', status: 'completed', rootCauseConfirmed: true, evidence: ['invariant violated'] });
    const final = updateDebugReport(root, { phase: 'fix_strategy', status: 'completed', evidence: ['return to coder'] });
    assert.equal(final.handoff.status, 'ready');
    assert.equal(validateDebugReport(final).valid, true);
  });

  it('standalone mode permits repair and verification only after root cause confirmation', () => {
    const initial = createDebugReport({ taskId: 'task-2', mode: 'standalone' });
    assert.throws(() => updateDebugReport(initial, { phase: 'repair', status: 'completed' }), /earlier reproduce-first|confirmed root cause/);
    let report = initial;
    for (const phase of DEBUG_PHASES) report = updateDebugReport(report, { phase, status: 'completed', rootCauseConfirmed: phase === 'root_cause', evidence: [phase] });
    report = updateDebugReport(report, { phase: 'repair', status: 'completed', evidence: ['minimal patch'] });
    report = updateDebugReport(report, { phase: 'verify', status: 'completed', evidence: ['tests'] });
    assert.equal(report.handoff.status, 'verified');
    assert.equal(validateDebugReport(report).valid, true);
  });
});
