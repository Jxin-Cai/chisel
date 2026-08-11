import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  loadMetrics, recordAgentCall, recordDuration, recordSpanFinish,
  recordSpanStart, recordStepFinish, recordStepStart, summary,
} from '../scripts/session-metrics.mjs';

describe('workflow time attribution', () => {
  let ideaDir;
  beforeEach(() => { ideaDir = mkdtempSync(join(tmpdir(), 'chisel-metrics-')); });
  afterEach(() => rmSync(ideaDir, { recursive: true, force: true }));

  it('records measured spans, agent calls, and human-wait attribution', () => {
    recordStepStart(ideaDir, 'plan:confirm');
    recordAgentCall(ideaDir, 'plan:confirm', 'reviewer', 2);
    const span = recordSpanStart(ideaDir, 'verification', 'unit-tests');
    recordSpanFinish(ideaDir, span.span_id, 'ok');
    recordDuration(ideaDir, 'control_plane', 'runner-tick', 25);
    recordStepFinish(ideaDir, 'plan:confirm');

    const result = summary(ideaDir);
    assert.equal(result.schema_version, 2);
    assert.equal(result.total_agent_calls, 2);
    assert.equal(result.counters['agent:reviewer'], 2);
    assert.ok(result.attribution.human_wait_ms >= 0);
    assert.equal(result.attribution.measured_spans_ms.control_plane, 25);
    assert.equal(result.open_spans.length, 0);
    assert.equal(loadMetrics(ideaDir).spans.length, 2);
  });
});
