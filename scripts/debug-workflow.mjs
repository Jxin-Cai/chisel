#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const DEBUG_PHASES = Object.freeze([
  'triage',
  'reproduce',
  'environment_sanity',
  'trace',
  'root_cause',
  'fix_strategy',
]);
export const EXECUTION_PHASES = Object.freeze(['repair', 'verify']);
export const DEBUG_MODES = Object.freeze(['standalone', 'return-diagnosis']);
export const DEBUG_PHASE_LABELS_ZH = Object.freeze({
  triage: '初步研判',
  reproduce: '复现',
  environment_sanity: '环境核验',
  trace: '链路追踪',
  root_cause: '根因确认',
  fix_strategy: '修复策略',
  repair: '返修',
  verify: '验证',
});

function now() {
  return new Date().toISOString();
}

function emptyPhase(name) {
  return { name, label_zh: DEBUG_PHASE_LABELS_ZH[name], status: 'pending', evidence: [] };
}

export function createDebugReport({ taskId, ideaDir = '', mode = 'return-diagnosis', createdAt = now() } = {}) {
  if (!taskId || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(taskId)) throw new Error('task-id is required');
  if (!DEBUG_MODES.includes(mode)) throw new Error(`mode must be one of: ${DEBUG_MODES.join(', ')}`);
  const phases = DEBUG_PHASES.map(emptyPhase);
  if (mode === 'standalone') phases.push(...EXECUTION_PHASES.map(emptyPhase));
  return {
    schema_version: 1,
    task_id: taskId,
    idea_dir: ideaDir ? resolve(ideaDir) : '',
    mode,
    created_at: createdAt,
    updated_at: createdAt,
    phases,
    root_cause: { confirmed: false, hypotheses: [], evidence: [] },
    handoff: mode === 'return-diagnosis' ? { required: true, status: 'pending', target: 'chisel-implement' } : { required: false },
  };
}

function phaseMap(report) {
  return new Map((report.phases || []).map(phase => [phase.name, phase]));
}

export function validateDebugReport(report) {
  const errors = [];
  if (!report || report.schema_version !== 1) errors.push('schema_version must be 1');
  if (!report?.task_id) errors.push('task_id is required');
  if (!DEBUG_MODES.includes(report?.mode)) errors.push(`mode must be one of: ${DEBUG_MODES.join(', ')}`);
  const required = [...DEBUG_PHASES, ...(report?.mode === 'standalone' ? EXECUTION_PHASES : [])];
  const phases = report?.phases;
  if (!Array.isArray(phases)) errors.push('phases must be an array');
  const names = phases?.map(phase => phase?.name) || [];
  if (names.join(',') !== required.join(',')) errors.push(`phases must be reproduce-first in order: ${required.join(' -> ')}`);
  for (const phase of phases || []) {
    if (!phase || !required.includes(phase.name)) errors.push(`unknown phase: ${phase?.name || '(missing)'}`);
    if (!['pending', 'in_progress', 'completed', 'skipped', 'failed'].includes(phase?.status)) errors.push(`${phase?.name || 'phase'} has invalid status`);
    if (!Array.isArray(phase?.evidence)) errors.push(`${phase?.name || 'phase'}.evidence must be an array`);
  }
  const map = phaseMap(report || {});
  const rootCause = report?.root_cause || {};
  if (map.get('root_cause')?.status === 'completed' && rootCause.confirmed !== true) {
    errors.push('root_cause.confirmed must be true when root_cause is completed');
  }
  if (map.get('repair')?.status !== undefined && map.get('repair').status !== 'pending' && rootCause.confirmed !== true) {
    errors.push('standalone repair requires confirmed root cause');
  }
  if (map.get('verify')?.status === 'completed' && map.get('repair')?.status !== 'completed') {
    errors.push('verify cannot complete before repair');
  }
  if (report?.mode === 'return-diagnosis') {
    if (map.has('repair') || map.has('verify')) errors.push('return-diagnosis mode must not execute repair/verify');
    if (report?.handoff?.required !== true) errors.push('return-diagnosis mode requires handoff.required=true');
  }
  return { valid: errors.length === 0, errors };
}

export function updateDebugReport(report, { phase, status, evidence = [], rootCauseConfirmed, hypotheses } = {}) {
  const next = structuredClone(report);
  const entry = next.phases?.find(item => item.name === phase);
  if (!entry) throw new Error(`unknown debug phase: ${phase}`);
  if (!['pending', 'in_progress', 'completed', 'skipped', 'failed'].includes(status)) throw new Error(`invalid phase status: ${status}`);
  const index = next.phases.indexOf(entry);
  const preceding = next.phases.slice(0, index);
  if (status === 'completed' && preceding.some(item => item.status !== 'completed' && item.status !== 'skipped')) {
    throw new Error(`${phase} cannot complete before earlier reproduce-first phases`);
  }
  if (phase === 'repair' && next.root_cause?.confirmed !== true) throw new Error('repair requires confirmed root cause');
  if (phase === 'verify' && next.phases.find(item => item.name === 'repair')?.status !== 'completed') throw new Error('verify requires completed repair');
  entry.status = status;
  entry.evidence = Array.isArray(evidence) ? evidence : [String(evidence)];
  if (phase === 'root_cause' && rootCauseConfirmed !== undefined) next.root_cause.confirmed = rootCauseConfirmed === true;
  if (phase === 'root_cause' && hypotheses) next.root_cause.hypotheses = [...hypotheses];
  if (phase === 'fix_strategy' && status === 'completed' && next.mode === 'return-diagnosis') next.handoff = { required: true, status: 'ready', target: 'chisel-implement' };
  if (phase === 'verify' && status === 'completed') next.handoff = { required: false, status: 'verified' };
  next.updated_at = now();
  const result = validateDebugReport(next);
  if (!result.valid) throw new Error(result.errors.join('; '));
  return next;
}

export function debugReportPath(ideaDir, taskId) {
  return join(resolve(ideaDir), 'debug', `${taskId}-debug.json`);
}

export function writeDebugReport(report, file = debugReportPath(report.idea_dir, report.task_id)) {
  const validation = validateDebugReport(report);
  if (!validation.valid) throw new Error(validation.errors.join('; '));
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(temporary, file);
  return file;
}

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--idea-dir') args.ideaDir = argv[++i];
    else if (value === '--task' || value === '--task-id') args.taskId = argv[++i];
    else if (value === '--mode') args.mode = argv[++i];
    else if (value === '--standalone') args.mode = 'standalone';
    else if (value === '--return-diagnosis' || value === '--repair-diagnosis') args.mode = 'return-diagnosis';
    else if (value === '--phase') args.phase = argv[++i];
    else if (value === '--status') args.status = argv[++i];
    else if (value === '--evidence') args.evidence = argv[++i];
    else if (value === '--confirm-root-cause') args.rootCauseConfirmed = true;
    else if (value === '--hypothesis') (args.hypotheses ||= []).push(argv[++i]);
  }
  return args;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.ideaDir || !args.taskId) throw new Error('usage: debug-workflow.mjs --idea-dir <dir> --task <task-id> [--standalone|--return-diagnosis]');
  const file = debugReportPath(args.ideaDir, args.taskId);
  let report = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : createDebugReport({ ideaDir: args.ideaDir, taskId: args.taskId, mode: args.mode || 'return-diagnosis' });
  if (args.phase) {
    report = updateDebugReport(report, { phase: args.phase, status: args.status || 'completed', evidence: args.evidence ? [args.evidence] : [], rootCauseConfirmed: args.rootCauseConfirmed, hypotheses: args.hypotheses });
    writeDebugReport(report, file);
  }
  console.log(JSON.stringify({ ...report, report_file: file }, null, 2));
  return report;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try { main(); } catch (error) { process.stderr.write(`${error.message}\n`); process.exit(1); }
}
