#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { durableAtomicWrite } from './file-transaction.mjs';

const METRICS_FILE = 'metrics.json';

function metricsPath(ideaDir) {
  return join(ideaDir, METRICS_FILE);
}

const HUMAN_WAIT_STEPS = new Set([
  'understand:confirm', 'clarify:requirement', 'plan:confirm',
  'worktree:setup', 'review:merge', 'blocked'
]);

function emptyMetrics() {
  return { schema_version: 2, started_at: null, steps: [], spans: [], task_metrics: [], counters: {}, total_duration: null };
}

export function loadMetrics(ideaDir) {
  const p = metricsPath(ideaDir);
  if (!existsSync(p)) return emptyMetrics();
  try {
    const parsed = JSON.parse(readFileSync(p, 'utf8'));
    return { ...emptyMetrics(), ...parsed, schema_version: 2, spans: parsed.spans || [], counters: parsed.counters || {} };
  } catch { return emptyMetrics(); }
}

function saveMetrics(ideaDir, metrics) {
  durableAtomicWrite(metricsPath(ideaDir), `${JSON.stringify(metrics, null, 2)}\n`);
}

export function recordStepStart(ideaDir, step) {
  const metrics = loadMetrics(ideaDir);
  if (!metrics.started_at) metrics.started_at = new Date().toISOString();
  const existing = metrics.steps.find(s => s.step === step && !s.finished_at);
  if (!existing) {
    metrics.steps.push({ step, started_at: new Date().toISOString(), finished_at: null, agent_calls: 0 });
  }
  saveMetrics(ideaDir, metrics);
}

export function recordStepFinish(ideaDir, step) {
  const metrics = loadMetrics(ideaDir);
  const entry = metrics.steps.find(s => s.step === step && !s.finished_at);
  if (entry) entry.finished_at = new Date().toISOString();
  saveMetrics(ideaDir, metrics);
}

export function recordStepTransition(ideaDir, previousStep, nextStep, controlDurationMs = 0) {
  const metrics = loadMetrics(ideaDir);
  const now = new Date();
  const active = metrics.steps.find(step => step.step === previousStep && !step.finished_at);
  if (active) active.finished_at = now.toISOString();
  if (!metrics.started_at) metrics.started_at = now.toISOString();
  const existing = metrics.steps.find(step => step.step === nextStep && !step.finished_at);
  if (!existing) metrics.steps.push({ step: nextStep, started_at: now.toISOString(), finished_at: null, agent_calls: 0 });
  const duration = Math.max(0, Number(controlDurationMs) || 0);
  metrics.spans.push({
    span_id: randomUUID(), category: 'control_plane', name: 'orchestration-transition',
    started_at: new Date(now.getTime() - duration).toISOString(), finished_at: now.toISOString(),
    duration_ms: duration, status: 'ok', metadata: { from: previousStep, to: nextStep },
  });
  saveMetrics(ideaDir, metrics);
}

export function recordAgentCall(ideaDir, step, agentType = 'unknown', count = 1) {
  const metrics = loadMetrics(ideaDir);
  const entry = metrics.steps.find(s => s.step === step && !s.finished_at);
  if (entry) entry.agent_calls = (entry.agent_calls || 0) + count;
  metrics.counters.agent_calls = (metrics.counters.agent_calls || 0) + count;
  metrics.counters[`agent:${agentType}`] = (metrics.counters[`agent:${agentType}`] || 0) + count;
  saveMetrics(ideaDir, metrics);
}

export function recordSpanStart(ideaDir, category, name, metadata = {}) {
  const metrics = loadMetrics(ideaDir);
  const span = {
    span_id: randomUUID(), category, name,
    started_at: new Date().toISOString(), finished_at: null,
    duration_ms: null, status: 'running', metadata,
  };
  metrics.spans.push(span);
  saveMetrics(ideaDir, metrics);
  return span;
}

export function recordSpanFinish(ideaDir, spanId, status = 'ok', metadata = {}) {
  const metrics = loadMetrics(ideaDir);
  const span = metrics.spans.find(item => item.span_id === spanId);
  if (!span) throw new Error(`unknown metrics span: ${spanId}`);
  if (!span.finished_at) {
    span.finished_at = new Date().toISOString();
    span.duration_ms = Math.max(0, new Date(span.finished_at) - new Date(span.started_at));
  }
  span.status = status;
  span.metadata = { ...(span.metadata || {}), ...metadata };
  saveMetrics(ideaDir, metrics);
  return span;
}

export function recordDuration(ideaDir, category, name, durationMs, metadata = {}, status = 'ok') {
  const metrics = loadMetrics(ideaDir);
  const finished = new Date();
  const duration = Math.max(0, Number(durationMs) || 0);
  const span = {
    span_id: randomUUID(), category, name,
    started_at: new Date(finished.getTime() - duration).toISOString(),
    finished_at: finished.toISOString(), duration_ms: duration, status, metadata,
  };
  metrics.spans.push(span);
  saveMetrics(ideaDir, metrics);
  return span;
}

export function recordTaskMetric(ideaDir, taskId, field, value) {
  const metrics = loadMetrics(ideaDir);
  let entry = metrics.task_metrics.find(t => t.task_id === taskId);
  if (!entry) { entry = { task_id: taskId }; metrics.task_metrics.push(entry); }
  entry[field] = value;
  saveMetrics(ideaDir, metrics);
}

export function finalize(ideaDir) {
  const metrics = loadMetrics(ideaDir);
  if (metrics.started_at) {
    metrics.total_duration = Date.now() - new Date(metrics.started_at).getTime();
  }
  saveMetrics(ideaDir, metrics);
  return metrics;
}

function formatMs(ms) {
  if (ms == null) return '-';
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  return `${min}m ${sec % 60}s`;
}

export function summary(ideaDir) {
  const metrics = loadMetrics(ideaDir);
  const totalSteps = metrics.steps.length;
  const completedSteps = metrics.steps.filter(s => s.finished_at).length;
  const totalAgentCalls = Number(metrics.counters?.agent_calls || metrics.steps.reduce((acc, s) => acc + (s.agent_calls || 0), 0));
  const totalReworks = metrics.task_metrics.reduce((acc, t) => acc + (t.rework_count || 0), 0);

  let totalDuration = metrics.total_duration;
  if (!totalDuration && metrics.started_at) {
    totalDuration = Date.now() - new Date(metrics.started_at).getTime();
  }

  const now = Date.now();
  const stepDurations = metrics.steps.map(step => {
    const start = new Date(step.started_at || 0).getTime();
    const end = step.finished_at ? new Date(step.finished_at).getTime() : now;
    return { ...step, duration_ms: Number.isFinite(start) ? Math.max(0, end - start) : 0 };
  });
  const humanWaitMs = stepDurations.filter(step => HUMAN_WAIT_STEPS.has(step.step)).reduce((sum, step) => sum + step.duration_ms, 0);
  const activeWorkflowMs = stepDurations.filter(step => !HUMAN_WAIT_STEPS.has(step.step)).reduce((sum, step) => sum + step.duration_ms, 0);
  const attribution = {};
  for (const span of metrics.spans || []) {
    const duration = span.duration_ms ?? (!span.finished_at ? Math.max(0, now - new Date(span.started_at).getTime()) : 0);
    attribution[span.category] = (attribution[span.category] || 0) + duration;
  }

  return {
    schema_version: 2,
    started_at: metrics.started_at,
    total_duration: formatMs(totalDuration),
    total_duration_ms: totalDuration,
    total_steps: totalSteps,
    completed_steps: completedSteps,
    total_agent_calls: totalAgentCalls,
    total_reworks: totalReworks,
    attribution: {
      wall_clock_ms: totalDuration,
      human_wait_ms: humanWaitMs,
      active_workflow_ms: activeWorkflowMs,
      measured_spans_ms: attribution,
    },
    counters: metrics.counters || {},
    open_spans: (metrics.spans || []).filter(span => !span.finished_at).map(span => ({ span_id: span.span_id, category: span.category, name: span.name, started_at: span.started_at })),
    steps: stepDurations.map(s => ({
      step: s.step,
      duration: s.finished_at ? formatMs(s.duration_ms) : 'in_progress',
      duration_ms: s.duration_ms,
      attribution: HUMAN_WAIT_STEPS.has(s.step) ? 'human_wait' : 'active_workflow',
      agent_calls: s.agent_calls || 0,
    })),
  };
}

function main() {
  const args = process.argv.slice(2);
  const ideaDir = args[0];

  if (!ideaDir || args.includes('--help')) {
    console.log('用法: node session-metrics.mjs <idea-dir> [--summary|--finalize|--agent-call <step> <type> [count]|--span-start <category> <name>|--span-finish <id> [status]|--duration <category> <name> <ms>]');
    process.exit(0);
  }

  if (!existsSync(ideaDir)) {
    process.stderr.write(`idea-dir not found: ${ideaDir}\n`);
    process.exit(1);
  }

  if (args.includes('--span-start')) {
    const index = args.indexOf('--span-start');
    const category = args[index + 1];
    const name = args[index + 2];
    if (!category || !name) throw new Error('--span-start requires <category> <name>');
    console.log(JSON.stringify(recordSpanStart(ideaDir, category, name)));
    return;
  }
  if (args.includes('--span-finish')) {
    const index = args.indexOf('--span-finish');
    console.log(JSON.stringify(recordSpanFinish(ideaDir, args[index + 1], args[index + 2] || 'ok')));
    return;
  }
  if (args.includes('--duration')) {
    const index = args.indexOf('--duration');
    console.log(JSON.stringify(recordDuration(ideaDir, args[index + 1], args[index + 2], Number(args[index + 3]))));
    return;
  }
  if (args.includes('--agent-call')) {
    const index = args.indexOf('--agent-call');
    recordAgentCall(ideaDir, args[index + 1] || 'unknown', args[index + 2] || 'unknown', Number(args[index + 3] || 1));
    console.log(JSON.stringify({ recorded: true }));
    return;
  }
  if (args.includes('--finalize')) {
    const result = finalize(ideaDir);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const result = summary(ideaDir);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
