#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { readTaskState, taskStateFile } from './workflow-lib.mjs';

const METRICS_FILE = 'metrics.json';

function metricsPath(ideaDir) {
  return join(ideaDir, METRICS_FILE);
}

function loadMetrics(ideaDir) {
  const p = metricsPath(ideaDir);
  if (!existsSync(p)) return { started_at: null, steps: [], task_metrics: [], total_duration: null };
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return { started_at: null, steps: [], task_metrics: [], total_duration: null }; }
}

function saveMetrics(ideaDir, metrics) {
  writeFileSync(metricsPath(ideaDir), JSON.stringify(metrics, null, 2));
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

export function recordAgentCall(ideaDir, step) {
  const metrics = loadMetrics(ideaDir);
  const entry = metrics.steps.find(s => s.step === step && !s.finished_at);
  if (entry) entry.agent_calls = (entry.agent_calls || 0) + 1;
  saveMetrics(ideaDir, metrics);
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

function summary(ideaDir) {
  const metrics = loadMetrics(ideaDir);
  const totalSteps = metrics.steps.length;
  const completedSteps = metrics.steps.filter(s => s.finished_at).length;
  const totalAgentCalls = metrics.steps.reduce((acc, s) => acc + (s.agent_calls || 0), 0);
  const totalReworks = metrics.task_metrics.reduce((acc, t) => acc + (t.rework_count || 0), 0);

  let totalDuration = metrics.total_duration;
  if (!totalDuration && metrics.started_at) {
    totalDuration = Date.now() - new Date(metrics.started_at).getTime();
  }

  return {
    started_at: metrics.started_at,
    total_duration: formatMs(totalDuration),
    total_duration_ms: totalDuration,
    total_steps: totalSteps,
    completed_steps: completedSteps,
    total_agent_calls: totalAgentCalls,
    total_reworks: totalReworks,
    steps: metrics.steps.map(s => ({
      step: s.step,
      duration: s.finished_at && s.started_at ? formatMs(new Date(s.finished_at) - new Date(s.started_at)) : 'in_progress',
      agent_calls: s.agent_calls || 0,
    })),
  };
}

function main() {
  const args = process.argv.slice(2);
  const ideaDir = args[0];

  if (!ideaDir || args.includes('--help')) {
    console.log('用法: node session-metrics.mjs <idea-dir> [--summary|--finalize]');
    process.exit(0);
  }

  if (!existsSync(ideaDir)) {
    process.stderr.write(`idea-dir not found: ${ideaDir}\n`);
    process.exit(1);
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
