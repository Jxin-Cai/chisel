import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { ALL_COMPLEXITIES, STEP_GATE_MAP, STEP_TO_PHASE as DEFINITION_STEP_TO_PHASE } from './workflow-definition.mjs';

export const TASK_STATES = ['pending', 'confirmed', 'coding', 'coded', 'reviewing', 'approved', 'needs_rework', 'repairing', 'failed', 'blocked'];
export const MAX_REWORK_COUNT = 5;
export { ALL_COMPLEXITIES, STEP_GATE_MAP };

const VALID_TRANSITIONS = new Set([
  'pending:confirmed',
  'confirmed:coding',
  'coding:coded',
  'coding:failed',
  'failed:confirmed',
  'failed:coding',
  'coded:reviewing',
  'reviewing:approved',
  'reviewing:needs_rework',
  'needs_rework:repairing',
  'repairing:repairing',
  'repairing:coded',
  'needs_rework:blocked',
  'confirmed:confirmed',
  'coding:coding',
  'coded:coded',
  'reviewing:reviewing',
  'approved:approved',
  'blocked:blocked'
]);

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

export function taskStateFile(ideaDir) {
  return join(ideaDir, 'task-workflow-state.yaml');
}

function workflowStateFile(ideaDir) {
  return join(ideaDir, 'workflow-state.yaml');
}

export function quoteYaml(value) {
  return JSON.stringify(String(value ?? ''));
}

export function atomicWriteFile(file, content) {
  ensureDir(dirname(file));
  const tmpFile = `${file}.${process.pid}.tmp`;
  writeFileSync(tmpFile, content);
  renameSync(tmpFile, file);
}

export function parseList(value) {
  const raw = String(value || '').replace(/\s+#.*$/, '').trim();
  if (!raw || raw === '[]') return [];
  return raw.replace(/^\[/, '').replace(/\]$/, '').split(',').map(s => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
}

export function parseTaskSpec(spec) {
  const raw = String(spec).trim();
  if (raw.startsWith('{')) {
    const obj = JSON.parse(raw);
    if (!obj.taskId) throw new Error(`invalid task spec JSON: missing taskId`);
    return {
      taskId: obj.taskId,
      depends_on: Array.isArray(obj.depends_on) ? obj.depends_on : [],
      description: obj.description || '',
      file: obj.file || `tasks/${obj.taskId}.md`,
      expected_files: Array.isArray(obj.expected_files) ? obj.expected_files : [],
      impact_surface: obj.impact_surface && typeof obj.impact_surface === 'object' ? obj.impact_surface : {}
    };
  }
  const parts = raw.split(':');
  const [taskId, dependsRaw = '', description = '', file = '', expectedRaw = ''] = parts;
  if (!taskId) throw new Error(`invalid task spec: ${spec}`);
  return {
    taskId,
    depends_on: dependsRaw && dependsRaw !== '-' ? dependsRaw.split(',').filter(Boolean) : [],
    description,
    file: file || `tasks/${taskId}.md`,
    expected_files: expectedRaw ? expectedRaw.split(',').filter(Boolean) : []
  };
}

function parseScalar(value) {
  const trimmed = String(value || '').trim();
  if (trimmed.startsWith('[')) return parseList(trimmed);
  if (trimmed.startsWith('{')) { try { return JSON.parse(trimmed); } catch { return trimmed; } }
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return trimmed.replace(/^['"]|['"]$/g, '');
}

export function readTaskExpectedFiles(taskFile) {
  if (!taskFile || !existsSync(taskFile)) return [];
  const text = readFileSync(taskFile, 'utf8');
  const parsed = readFrontmatter(text);
  if (Array.isArray(parsed.starting_points)) return parsed.starting_points;
  return Array.isArray(parsed.expected_files) ? parsed.expected_files : [];
}

export function readFrontmatter(text) {
  const lines = String(text || '').split('\n');
  if (lines[0] !== '---') return {};
  let end = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) return {};
  const result = {};
  for (const line of lines.slice(1, end)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;
    const [, key, raw] = match;
    result[key] = parseScalar(raw);
  }
  return result;
}

export function readTaskState(file) {
  if (!existsSync(file)) return { idea: '', tasks: {} };
  const lines = readFileSync(file, 'utf8').split('\n');
  const state = { idea: '', tasks: {} };
  let current = null;
  for (const line of lines) {
    if (/^idea:/.test(line)) {
      state.idea = line.replace(/^idea:\s*/, '').trim();
      continue;
    }
    const taskMatch = line.match(/^  ([^:\s]+):\s*$/);
    if (taskMatch) {
      current = taskMatch[1];
      state.tasks[current] = {};
      continue;
    }
    const propMatch = line.match(/^    ([^:]+):\s*(.*)$/);
    if (current && propMatch) {
      state.tasks[current][propMatch[1]] = parseScalar(propMatch[2]);
    }
  }
  return state;
}

export function normalizeImpactSurface(surface = {}) {
  return {
    files: Array.isArray(surface.files) ? surface.files : [],
    symbols: Array.isArray(surface.symbols) ? surface.symbols : [],
    invariants: Array.isArray(surface.invariants) ? surface.invariants : [],
    shared_state: Array.isArray(surface.shared_state) ? surface.shared_state : [],
    reads: Array.isArray(surface.reads) ? surface.reads : [],
    writes: Array.isArray(surface.writes) ? surface.writes : []
  };
}

export function serializeTaskState(state) {
  const out = [];
  out.push(`idea: ${state.idea || ''}`);
  out.push('tasks:');
  for (const [taskId, task] of Object.entries(state.tasks || {})) {
    out.push(`  ${taskId}:`);
    out.push(`    status: ${task.status || 'pending'}`);
    out.push(`    depends_on: [${(task.depends_on || []).join(', ')}]`);
    out.push(`    description: ${quoteYaml(task.description || '')}`);
    out.push(`    file: ${quoteYaml(task.file || `tasks/${taskId}.md`)}`);
    out.push(`    expected_files: [${(task.expected_files || []).join(', ')}]`);
    out.push(`    impact_surface: ${JSON.stringify(normalizeImpactSurface(task.impact_surface || { files: task.expected_files || [] }))}`);
    out.push(`    exports: [${(task.exports || []).join(', ')}]`);
    out.push(`    imports: [${(task.imports || []).join(', ')}]`);
    out.push(`    report_file: ${quoteYaml(task.report_file || `task-reports/${taskId}-report.md`)}`);
    out.push(`    cr_file: ${quoteYaml(task.cr_file || `cr/${taskId}-cr.md`)}`);
    out.push(`    rework_count: ${Number(task.rework_count || 0)}`);
    if (task.started_at) out.push(`    started_at: ${task.started_at}`);
    out.push(`    changed_files: [${(task.changed_files || []).join(', ')}]`);
    out.push(`    loc_added: ${Number(task.loc_added || 0)}`);
    out.push(`    loc_deleted: ${Number(task.loc_deleted || 0)}`);
  }
  return `${out.join('\n')}\n`;
}

export function writeTaskState(file, state) {
  ensureDir(dirname(file));
  atomicWriteFile(file, serializeTaskState(state));
}

export function initWorkflowState(ideaDir, ideaName) {
  ensureDir(ideaDir);
  const now = new Date().toISOString();
  atomicWriteFile(workflowStateFile(ideaDir), [
    `idea: ${ideaName}`,
    `started_at: ${now}`,
    `last_updated_at: ${now}`,
    'revision: 0',
    `current_step: receive-requirement`,
    'phase:',
    '  requirement: done',
    '  understand: pending',
    '  clarify: pending',
    '  plan: pending',
    '  tasks: pending',
    '  implement: pending',
    '  review: pending',
    '  final: pending',
    'step_history:',
    '  - step: receive-requirement',
    `    entered_at: ${now}`,
    ''
  ].join('\n'));
}

export function parseWorkflowStepHistory(text) {
  const history = [];
  const historyStart = String(text || '').indexOf('step_history:');
  if (historyStart === -1) return history;
  const histLines = String(text).slice(historyStart).split('\n').slice(1);
  let entry = {};
  for (const hl of histLines) {
    if (/^\s+-\s*$/.test(hl) || /^\s+- step:/.test(hl)) {
      if (entry.step) history.push(entry);
      entry = {};
      const sm = hl.match(/step:\s*(.+)/);
      if (sm) entry.step = sm[1].trim();
    } else if (/^\s+step:/.test(hl)) {
      const sm = hl.match(/step:\s*(.+)/);
      if (sm) entry.step = sm[1].trim();
    } else if (/^\s+entered_at:/.test(hl)) {
      const sm = hl.match(/entered_at:\s*(.+)/);
      if (sm) entry.entered_at = sm[1].trim();
    } else if (/^\s+exited_at:/.test(hl)) {
      const sm = hl.match(/exited_at:\s*(.+)/);
      if (sm) entry.exited_at = sm[1].trim();
    } else if (/^\s+duration_ms:/.test(hl)) {
      const sm = hl.match(/duration_ms:\s*(.+)/);
      if (sm) entry.duration_ms = Number(sm[1].trim()) || 0;
    } else if (/^[a-z]/.test(hl)) break;
  }
  if (entry.step) history.push(entry);
  return history;
}

function workflowStepHistoryYaml(history) {
  if (!history.length) return '';
  return ['step_history:', ...history.flatMap(h => {
    const lines = [`  - step: ${h.step}`, `    entered_at: ${h.entered_at}`];
    if (h.exited_at) lines.push(`    exited_at: ${h.exited_at}`);
    if (h.duration_ms !== undefined) lines.push(`    duration_ms: ${Math.max(0, Number(h.duration_ms) || 0)}`);
    return lines;
  })].join('\n');
}

function replaceWorkflowStepHistory(text, history) {
  const base = String(text || '').replace(/\n?step_history:\n[\s\S]*$/m, '').trimEnd();
  const historyYaml = workflowStepHistoryYaml(history);
  return `${base}${historyYaml ? `\n${historyYaml}` : ''}\n`;
}

export const STEP_TO_PHASE = {
  ...DEFINITION_STEP_TO_PHASE,
  // Legacy rollback aliases retained for existing runtime directories.
  'understand:generate-ai-input': 'understand',
  'plan:strategy': 'plan',
  'plan:strategy-confirm': 'plan',
  'plan:decompose': 'plan',
  'plan:decompose-confirm': 'plan'
};

const PHASE_ORDER = ['requirement', 'understand', 'clarify', 'plan', 'tasks', 'implement', 'review', 'final'];

export function readWorkflowRevision(ideaDir) {
  const file = workflowStateFile(ideaDir);
  if (!existsSync(file)) return 0;
  return Number(readFileSync(file, 'utf8').match(/^revision:\s*(\d+)$/m)?.[1] || 0);
}

export function renderWorkflowPhaseUpdate(sourceText, stepId, { resetLaterPhases = false, expectedRevision, incrementRevision = false, now = new Date().toISOString() } = {}) {
  let text = String(sourceText || '');
  const currentRevision = Number(text.match(/^revision:\s*(\d+)$/m)?.[1] || 0);
  if (expectedRevision !== undefined && currentRevision !== Number(expectedRevision)) {
    throw new Error(`workflow revision conflict: expected ${expectedRevision}, actual ${currentRevision}`);
  }
  const previousStep = text.match(/^current_step:\s*(.+)$/m)?.[1]?.trim() || '';
  text = text.replace(/^last_updated_at:.*$/m, `last_updated_at: ${now}`);
  text = text.replace(/^current_step:.*$/m, `current_step: ${stepId}`);
  if (incrementRevision) {
    const nextRevision = currentRevision + 1;
    text = /^revision:/m.test(text)
      ? text.replace(/^revision:.*$/m, `revision: ${nextRevision}`)
      : text.replace(/^current_step:/m, `revision: ${nextRevision}\ncurrent_step:`);
  }
  const phase = STEP_TO_PHASE[stepId];
  if (phase) {
    text = text.replace(new RegExp(`^(  ${phase}:).*$`, 'm'), `$1 in_progress`);
    if (resetLaterPhases) {
      const phaseIdx = PHASE_ORDER.indexOf(phase);
      if (phaseIdx >= 0) {
        for (const laterPhase of PHASE_ORDER.slice(phaseIdx + 1)) {
          text = text.replace(new RegExp(`^(  ${laterPhase}:).*$`, 'm'), `$1 pending`);
        }
      }
    }
  }

  const history = parseWorkflowStepHistory(text);
  if (history.length === 0) {
    history.push({ step: stepId, entered_at: now });
  } else if (stepId !== previousStep) {
    const last = history[history.length - 1];
    if (!last.exited_at && last.entered_at) {
      last.exited_at = now;
      last.duration_ms = Math.max(0, new Date(now).getTime() - new Date(last.entered_at).getTime());
    }
    history.push({ step: stepId, entered_at: now });
  }

  return {
    content: replaceWorkflowStepHistory(text, history),
    transition: { previous_step: previousStep, current_step: stepId, previous_revision: currentRevision, revision: currentRevision + (incrementRevision ? 1 : 0) },
  };
}

export function updateWorkflowPhase(ideaDir, stepId, options = {}) {
  const file = workflowStateFile(ideaDir);
  if (!existsSync(file)) return;
  const rendered = renderWorkflowPhaseUpdate(readFileSync(file, 'utf8'), stepId, options);
  atomicWriteFile(file, rendered.content);
  return rendered.transition;
}

export function transitionWorkflowPhase(ideaDir, stepId, expectedRevision) {
  return updateWorkflowPhase(ideaDir, stepId, { expectedRevision, incrementRevision: true });
}

export function initTaskState(ideaDir, ideaName, specs) {
  const file = taskStateFile(ideaDir);
  const existing = readTaskState(file);
  const state = { idea: ideaName, tasks: { ...existing.tasks } };
  for (const spec of specs) {
    const task = typeof spec === 'string' ? parseTaskSpec(spec) : spec;
    const taskFile = task.file || `tasks/${task.taskId}.md`;
    state.tasks[task.taskId] = {
      status: task.status || state.tasks[task.taskId]?.status || 'confirmed',
      depends_on: task.depends_on || [],
      description: task.description || '',
      file: taskFile,
      expected_files: task.expected_files?.length ? task.expected_files : readTaskExpectedFiles(join(ideaDir, taskFile)),
      impact_surface: normalizeImpactSurface(task.impact_surface || { files: task.expected_files || [] }),
      exports: task.exports || [],
      imports: task.imports || [],
      report_file: task.report_file || `task-reports/${task.taskId}-report.md`,
      cr_file: task.cr_file || `cr/${task.taskId}-cr.md`,
      rework_count: Number(task.rework_count || 0),
      changed_files: task.changed_files || [],
      loc_added: Number(task.loc_added || 0),
      loc_deleted: Number(task.loc_deleted || 0)
    };
  }
  writeTaskState(file, state);
  return state;
}

export function getNextTasks(ideaDir) {
  const state = readTaskState(taskStateFile(ideaDir));
  return Object.entries(state.tasks).filter(([, task]) => {
    if (!['confirmed', 'failed'].includes(task.status)) return false;
    return (task.depends_on || []).every(dep => state.tasks[dep]?.status === 'approved');
  }).map(([taskId]) => taskId);
}

export function getCodingTasks(ideaDir) {
  const state = readTaskState(taskStateFile(ideaDir));
  return Object.entries(state.tasks).filter(([, task]) => task.status === 'coding').map(([taskId]) => taskId);
}

export function getRepairingTasks(ideaDir) {
  const state = readTaskState(taskStateFile(ideaDir));
  return Object.entries(state.tasks).filter(([, task]) => task.status === 'repairing').map(([taskId]) => taskId);
}

export function getCodedTasksNeedingReview(ideaDir) {
  const state = readTaskState(taskStateFile(ideaDir));
  return Object.entries(state.tasks).filter(([, task]) => task.status === 'coded').map(([taskId]) => taskId);
}

export function getReviewingTasks(ideaDir) {
  const state = readTaskState(taskStateFile(ideaDir));
  return Object.entries(state.tasks).filter(([, task]) => task.status === 'reviewing').map(([taskId]) => taskId);
}

export function getReviewBacklogTasks(ideaDir) {
  const state = readTaskState(taskStateFile(ideaDir));
  const entries = Object.entries(state.tasks);
  return [
    ...entries.filter(([, task]) => task.status === 'reviewing').map(([taskId]) => taskId),
    ...entries.filter(([, task]) => task.status === 'coded').map(([taskId]) => taskId)
  ];
}

export function getReworkTasks(ideaDir) {
  const state = readTaskState(taskStateFile(ideaDir));
  return Object.entries(state.tasks).filter(([, task]) => task.status === 'needs_rework' && Number(task.rework_count || 0) < MAX_REWORK_COUNT).map(([taskId]) => taskId);
}

export function getBlockedReworkTasks(ideaDir) {
  const state = readTaskState(taskStateFile(ideaDir));
  return Object.entries(state.tasks).filter(([, task]) => task.status === 'blocked' || (task.status === 'needs_rework' && Number(task.rework_count || 0) >= MAX_REWORK_COUNT)).map(([taskId]) => taskId);
}

export function allTasksApproved(ideaDir) {
  const state = readTaskState(taskStateFile(ideaDir));
  const tasks = Object.values(state.tasks || {});
  return tasks.length > 0 && tasks.every(task => task.status === 'approved');
}

function normalizedPattern(value) {
  return String(value || '').trim().replace(/^\.\//, '').replace(/\\/g, '/');
}

function patternPrefix(value) {
  const pattern = normalizedPattern(value);
  const wildcard = pattern.search(/[?*\[]/);
  return wildcard >= 0 ? pattern.slice(0, wildcard) : pattern;
}

export function scopePatternsOverlap(leftValue, rightValue) {
  const left = normalizedPattern(leftValue);
  const right = normalizedPattern(rightValue);
  if (!left || !right) return false;
  if (left === right || left === '*' || right === '*') return true;
  const leftGlob = /[?*\[]/.test(left);
  const rightGlob = /[?*\[]/.test(right);
  const leftDirectory = left.endsWith('/');
  const rightDirectory = right.endsWith('/');
  if (!leftGlob && !rightGlob && !leftDirectory && !rightDirectory) return false;
  const leftPrefix = patternPrefix(left).replace(/\/$/, '');
  const rightPrefix = patternPrefix(right).replace(/\/$/, '');
  if (leftGlob || rightGlob) return leftPrefix.startsWith(rightPrefix) || rightPrefix.startsWith(leftPrefix);
  return leftPrefix === rightPrefix || leftPrefix.startsWith(`${rightPrefix}/`) || rightPrefix.startsWith(`${leftPrefix}/`);
}

function pairwiseOverlaps(taskSurfaces, kind, leftValues, rightValues = leftValues) {
  const overlaps = [];
  const entries = Object.entries(taskSurfaces);
  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const [leftTask, leftSurface] = entries[i];
      const [rightTask, rightSurface] = entries[j];
      for (const left of leftValues(leftSurface)) {
        for (const right of rightValues(rightSurface)) {
          if (scopePatternsOverlap(left, right)) overlaps.push({ kind, left, right, tasks: [leftTask, rightTask] });
        }
      }
    }
  }
  return overlaps;
}

export function getTasksFileOverlap(ideaDir, taskIds) {
  const state = readTaskState(taskStateFile(ideaDir));
  const surfaces = Object.fromEntries(taskIds.map(taskId => [taskId, state.tasks[taskId] || {}]));
  return pairwiseOverlaps(surfaces, 'file', task => task.expected_files || []).map(overlap => ({ ...overlap, file: overlap.left === overlap.right ? overlap.left : `${overlap.left} ↔ ${overlap.right}` }));
}

export function getTasksImpactOverlap(ideaDir, taskIds) {
  const state = readTaskState(taskStateFile(ideaDir));
  const surfaces = Object.fromEntries(taskIds.map(taskId => {
    const task = state.tasks[taskId] || {};
    return [taskId, normalizeImpactSurface(task.impact_surface || { files: task.expected_files || [] })];
  }));
  const overlaps = ['files', 'symbols', 'invariants', 'shared_state'].flatMap(kind => pairwiseOverlaps(surfaces, kind, surface => surface[kind] || []));
  const writeWrite = pairwiseOverlaps(surfaces, 'shared_resource', surface => [...surface.writes, ...surface.shared_state], surface => [...surface.writes, ...surface.shared_state]);
  const writeRead = pairwiseOverlaps(surfaces, 'shared_resource', surface => [...surface.writes, ...surface.shared_state], surface => surface.reads || []);
  const readWrite = pairwiseOverlaps(surfaces, 'shared_resource', surface => surface.reads || [], surface => [...surface.writes, ...surface.shared_state]);
  const unique = new Map([...overlaps, ...writeWrite, ...writeRead, ...readWrite].map(item => [`${item.kind}:${item.tasks.join(':')}:${item.left}:${item.right}`, item]));
  return [...unique.values()];
}

/**
 * Build deterministic execution waves for the currently runnable tasks.
 *
 * The previous API only returned pairwise conflicts and left the orchestrator
 * to manually turn those conflicts into batches.  That made the parallel path
 * effectively all-or-nothing.  This greedy graph-colouring pass keeps every
 * non-conflicting task in the earliest possible wave while preserving stable
 * task order for reproducible recovery.
 */
export function planParallelTaskBatches(ideaDir, requestedTaskIds = null) {
  const runnable = getNextTasks(ideaDir);
  const requested = requestedTaskIds?.length ? requestedTaskIds : runnable;
  const taskIds = [...new Set(requested)].filter(taskId => runnable.includes(taskId));
  const excluded = requested.filter(taskId => !taskIds.includes(taskId));
  const fileOverlap = taskIds.length > 1 ? getTasksFileOverlap(ideaDir, taskIds) : [];
  const impactOverlap = taskIds.length > 1 ? getTasksImpactOverlap(ideaDir, taskIds) : [];
  const dependencyOverlap = taskIds.length > 1 ? getTasksExportsImportsOverlap(ideaDir, taskIds) : [];
  const conflicts = new Map(taskIds.map(taskId => [taskId, new Set()]));
  const connect = (left, right) => {
    if (!conflicts.has(left) || !conflicts.has(right) || left === right) return;
    conflicts.get(left).add(right);
    conflicts.get(right).add(left);
  };
  for (const overlap of [...fileOverlap, ...impactOverlap]) connect(overlap.tasks?.[0], overlap.tasks?.[1]);
  for (const overlap of dependencyOverlap) connect(overlap.importer, overlap.exporter);

  const batches = [];
  for (const taskId of taskIds) {
    let target = batches.find(batch => batch.every(existing => !conflicts.get(taskId).has(existing)));
    if (!target) {
      target = [];
      batches.push(target);
    }
    target.push(taskId);
  }
  const parallelTasks = batches.reduce((sum, batch) => sum + (batch.length > 1 ? batch.length : 0), 0);
  return {
    task_ids: taskIds,
    excluded,
    batches,
    batch_count: batches.length,
    max_parallelism: Math.max(0, ...batches.map(batch => batch.length)),
    parallel_task_count: parallelTasks,
    serial_task_count: taskIds.length - parallelTasks,
    conflicts: {
      file: fileOverlap,
      impact: impactOverlap,
      exports_imports: dependencyOverlap,
    },
  };
}

export function applyTaskStatus(state, taskId, nextStatus, { now = new Date().toISOString() } = {}) {
  if (!TASK_STATES.includes(nextStatus)) throw new Error(`invalid task status: ${nextStatus}`);
  const task = state.tasks[taskId];
  if (!task) throw new Error(`unknown task: ${taskId}`);
  const current = task.status || 'pending';
  if (!VALID_TRANSITIONS.has(`${current}:${nextStatus}`)) {
    throw new Error(`invalid transition: ${taskId} ${current} -> ${nextStatus}`);
  }
  task.status = nextStatus;
  if (nextStatus === 'coding' || nextStatus === 'repairing') {
    task.started_at = now;
  }
  return task;
}

export function updateTaskStatus(ideaDir, taskId, nextStatus) {
  const file = taskStateFile(ideaDir);
  const state = readTaskState(file);
  const task = applyTaskStatus(state, taskId, nextStatus);
  writeTaskState(file, state);
  return task;
}

export function markCr(ideaDir, taskId, result) {
  const status = result === 'approved' ? 'approved' : result === 'needs_rework' ? 'needs_rework' : 'blocked';
  const file = taskStateFile(ideaDir);
  const state = readTaskState(file);
  const task = state.tasks[taskId];
  if (!task) throw new Error(`unknown task: ${taskId}`);
  const current = task.status;
  if (task.status !== 'reviewing' && task.status !== 'coded') {
    throw new Error(`task ${taskId} is not reviewable from ${task.status}`);
  }
  if (result === 'needs_rework') task.rework_count = Number(task.rework_count || 0) + 1;
  task.status = status;
  if (task.rework_count >= MAX_REWORK_COUNT && status === 'needs_rework') task.status = 'blocked';
  writeTaskState(file, state);
  return task;
}

export function markCrRequirement(ideaDir, result, affectedTaskIds) {
  const file = taskStateFile(ideaDir);
  const state = readTaskState(file);
  const results = [];

  if (result === 'approved') {
    for (const [taskId, task] of Object.entries(state.tasks)) {
      if (task.status === 'reviewing' || task.status === 'coded') {
        const from = task.status;
        task.status = 'approved';
        results.push({ task_id: taskId, from, to: 'approved' });
      }
    }
  } else {
    const affected = affectedTaskIds || [];
    for (const taskId of affected) {
      const task = state.tasks[taskId];
      if (!task) throw new Error(`unknown task: ${taskId}`);
      const from = task.status;
      if (result === 'needs_rework') {
        task.rework_count = Number(task.rework_count || 0) + 1;
        task.status = task.rework_count >= MAX_REWORK_COUNT ? 'blocked' : 'needs_rework';
      } else {
        task.status = 'blocked';
      }
      results.push({ task_id: taskId, from, to: task.status, rework_count: task.rework_count || 0 });
    }
    for (const [taskId, task] of Object.entries(state.tasks)) {
      if (!affected.includes(taskId) && (task.status === 'reviewing' || task.status === 'coded')) {
        const from = task.status;
        task.status = 'approved';
        results.push({ task_id: taskId, from, to: 'approved' });
      }
    }
  }

  writeTaskState(file, state);
  return results;
}

const ROLLBACK_STEPS = {
  'understand:confirm': {
    remove: [
      'clarifications.json',
      'clarifications.md',
      'confirmations/as-is.json',
      '.as-is-confirmed',
      'as-is/ai-input',
      'requirement-clarification.json',
      'requirement-clarification.md',
      'to-be',
      'confirmations/to-be.json',
      'confirmations/strategy.json',
      '.to-be-confirmed',
      'worktree-decision.json',
      'task-workflow-state.yaml',
      'tasks',
      'task-reports',
      'cr',
      'final-summary.md',
      '.done'
    ]
  },
  'understand:generate-ai-input': {
    remove: [
      'as-is/ai-input',
      'requirement-clarification.json',
      'requirement-clarification.md',
      'to-be',
      'confirmations/to-be.json',
      'confirmations/strategy.json',
      '.to-be-confirmed',
      'worktree-decision.json',
      'task-workflow-state.yaml',
      'tasks',
      'task-reports',
      'cr',
      'final-summary.md',
      '.done'
    ]
  },
  'clarify:requirement': {
    remove: [
      'requirement-clarification.json',
      'requirement-clarification.md',
      'requirement-classification.json',
      'scope-escalation.json',
      'document-jobs',
      'to-be',
      'confirmations/to-be.json',
      'confirmations/strategy.json',
      '.to-be-confirmed',
      'worktree-decision.json',
      'task-workflow-state.yaml',
      'tasks',
      'task-reports',
      'cr',
      'final-summary.md',
      '.done'
    ]
  },
  'classify:requirement': {
    remove: [
      'requirement-classification.json',
      'as-is',
      'document-jobs',
      'to-be',
      'confirmations/to-be.json',
      '.to-be-confirmed',
      'worktree-decision.json',
      'task-workflow-state.yaml',
      'tasks',
      'task-reports',
      'cr',
      'final-summary.md',
      '.done'
    ]
  },
  'plan:strategy': {
    remove: [
      'to-be',
      'confirmations/to-be.json',
      'confirmations/strategy.json',
      '.to-be-confirmed',
      'worktree-decision.json',
      'task-workflow-state.yaml',
      'tasks',
      'task-reports',
      'cr',
      'final-summary.md',
      '.done'
    ]
  },
  'plan:strategy-confirm': {
    remove: [
      'confirmations/strategy.json',
      'to-be/tasks.json',
      'to-be/traceability-matrix.json',
      'confirmations/to-be.json',
      '.to-be-confirmed',
      'worktree-decision.json',
      'task-workflow-state.yaml',
      'tasks',
      'task-reports',
      'cr',
      'final-summary.md',
      '.done'
    ]
  },
  'plan:decompose': {
    remove: [
      'to-be/tasks.json',
      'to-be/traceability-matrix.json',
      'confirmations/to-be.json',
      '.to-be-confirmed',
      'worktree-decision.json',
      'task-workflow-state.yaml',
      'tasks',
      'task-reports',
      'cr',
      'final-summary.md',
      '.done'
    ]
  },
  'plan:decompose-confirm': {
    remove: [
      'confirmations/to-be.json',
      '.to-be-confirmed',
      'worktree-decision.json',
      'task-workflow-state.yaml',
      'tasks',
      'task-reports',
      'cr',
      'final-summary.md',
      '.done'
    ]
  },
  'plan:design': {
    remove: [
      'to-be',
      'confirmations/to-be.json',
      'confirmations/strategy.json',
      '.to-be-confirmed',
      'worktree-decision.json',
      'task-workflow-state.yaml',
      'tasks',
      'task-reports',
      'cr',
      'final-summary.md',
      '.done'
    ]
  },
  'plan:confirm': {
    remove: [
      'confirmations/to-be.json',
      '.to-be-confirmed',
      'worktree-decision.json',
      'task-workflow-state.yaml',
      'tasks',
      'task-reports',
      'cr',
      'final-summary.md',
      '.done'
    ]
  },
  'worktree:setup': {
    remove: [
      'worktree-decision.json',
      'task-workflow-state.yaml',
      'tasks',
      'task-reports',
      'cr',
      'final-summary.md',
      '.done'
    ]
  },
  'quick-dev:init': {
    remove: [
      'task-workflow-state.yaml',
      'tasks',
      'task-reports',
      'cr',
      'worktree-decision.json',
      'to-be/traceability-matrix.json',
      'final-summary.md',
      '.done'
    ]
  },
  'tasks:init': {
    remove: [
      'task-workflow-state.yaml',
      'tasks',
      'task-reports',
      'cr',
      'final-summary.md',
      '.done'
    ]
  },
  'implement:code': {
    remove: ['task-reports', 'verify-result.json', 'unit-test-result.json', 'unit-test-runs.json', 'reports/test-report.html', 'confirmations/test-report.json', 'cr', 'confirmations/cr-report.json', 'reports/cr-report.html', 'confirmations/merge-review.json', 'final-summary.md', '.done'],
    reset: {
      from: ['coding', 'coded', 'reviewing', 'approved', 'needs_rework', 'repairing', 'failed', 'blocked'],
      to: 'confirmed'
    }
  },
  'repair:code': {
    remove: ['task-reports', 'verify-result.json', 'unit-test-result.json', 'reports/test-report.html', 'confirmations/test-report.json', 'cr', 'confirmations/cr-report.json', 'reports/cr-report.html', 'confirmations/merge-review.json', 'final-summary.md', '.done'],
    reset: {
      from: ['repairing', 'coded', 'reviewing', 'approved'],
      to: 'needs_rework'
    }
  },
  'test:unit': {
    remove: ['unit-test-result.json', 'reports/test-report.html', 'confirmations/test-report.json', 'cr', 'confirmations/cr-report.json', 'reports/cr-report.html', 'confirmations/merge-review.json', 'final-summary.md', '.done'],
    reset: {
      from: ['reviewing', 'approved', 'needs_rework', 'repairing', 'blocked'],
      to: 'coded'
    }
  },
  'review:cr': {
    remove: ['cr', 'confirmations/cr-report.json', 'reports/cr-report.html', 'confirmations/merge-review.json', 'final-summary.md', '.done'],
    reset: {
      from: ['reviewing', 'approved', 'needs_rework', 'repairing', 'blocked'],
      to: 'coded'
    }
  },
  'review:cr-report': {
    remove: ['cr/review-report.md', 'confirmations/cr-report.json', 'reports/cr-report.html', 'confirmations/merge-review.json', 'final-summary.md', '.done']
  },
  'final:summary': {
    remove: ['final-summary.md', 'cr/current-change-report.json', 'cr/current-change-report.md', 'confirmations/merge-review.json', '.done']
  },
  'review:merge': {
    remove: ['cr/current-change-report.json', 'cr/current-change-report.md', 'cr/merge-review-user-feedback.md', 'confirmations/merge-review.json', '.done']
  }
};

export function rollbackPlan(ideaDir, stepId) {
  const spec = ROLLBACK_STEPS[stepId];
  if (!spec) throw new Error(`unsupported rollback step: ${stepId}`);
  const removed = [];
  const missing = [];
  for (const rel of spec.remove || []) {
    if (existsSync(join(ideaDir, rel))) removed.push(rel);
    else missing.push(rel);
  }
  const taskResets = plannedTaskResets(ideaDir, spec.reset);
  return { to_step: stepId, removed, missing, task_resets: taskResets };
}

function plannedTaskResets(ideaDir, reset) {
  if (!reset || !existsSync(taskStateFile(ideaDir))) return [];
  const state = readTaskState(taskStateFile(ideaDir));
  return Object.entries(state.tasks || {}).flatMap(([taskId, task]) => {
    const current = task.status || 'pending';
    if (!reset.from.includes(current)) return [];
    return [{ task_id: taskId, from: current, to: reset.to }];
  });
}

function applyTaskResets(ideaDir, taskResets) {
  if (taskResets.length === 0 || !existsSync(taskStateFile(ideaDir))) return;
  const state = readTaskState(taskStateFile(ideaDir));
  for (const reset of taskResets) {
    if (!state.tasks[reset.task_id]) continue;
    state.tasks[reset.task_id].status = reset.to;
    if (reset.to === 'confirmed') {
      state.tasks[reset.task_id].changed_files = [];
      state.tasks[reset.task_id].loc_added = 0;
      state.tasks[reset.task_id].loc_deleted = 0;
    }
  }
  writeTaskState(taskStateFile(ideaDir), state);
}

export function rollbackWorkflow(ideaDir, stepId, { dryRun = false } = {}) {
  const plan = rollbackPlan(ideaDir, stepId);
  if (dryRun) return { rolled_back: false, dry_run: true, ...plan };
  for (const rel of plan.removed) {
    rmSync(join(ideaDir, rel), { recursive: true, force: true });
  }
  applyTaskResets(ideaDir, plan.task_resets);
  updateWorkflowPhase(ideaDir, stepId, { resetLaterPhases: true, incrementRevision: true });
  return { rolled_back: true, dry_run: false, ...plan };
}

export function rollbackTask(ideaDir, taskId, { dryRun = false } = {}) {
  const file = taskStateFile(ideaDir);
  const state = readTaskState(file);
  const task = state.tasks[taskId];
  if (!task) throw new Error(`unknown task: ${taskId}`);
  const current = task.status;
  const toRemove = [];
  if (task.report_file && existsSync(join(ideaDir, task.report_file))) toRemove.push(task.report_file);
  if (task.cr_file && existsSync(join(ideaDir, task.cr_file))) toRemove.push(task.cr_file);
  if (dryRun) return { rolled_back: false, dry_run: true, task_id: taskId, from: current, to: 'confirmed', removed: toRemove };
  for (const rel of toRemove) rmSync(join(ideaDir, rel), { recursive: true, force: true });
  task.status = 'confirmed';
  task.changed_files = [];
  task.loc_added = 0;
  task.loc_deleted = 0;
  task.started_at = undefined;
  task.rework_count = 0;
  writeTaskState(file, state);
  return { rolled_back: true, dry_run: false, task_id: taskId, from: current, to: 'confirmed', removed: toRemove };
}

export function getTasksExportsImportsOverlap(ideaDir, taskIds) {
  const state = readTaskState(taskStateFile(ideaDir));
  const exportsByTask = new Map();
  for (const tid of taskIds) {
    const task = state.tasks[tid] || {};
    exportsByTask.set(tid, task.exports || []);
  }
  const overlaps = [];
  for (const tid of taskIds) {
    const task = state.tasks[tid] || {};
    const imports = task.imports || [];
    for (const imp of imports) {
      for (const [exportTid, exports] of exportsByTask) {
        if (exportTid === tid) continue;
        if (exports.includes(imp)) {
          overlaps.push({ importer: tid, exporter: exportTid, symbol: imp });
        }
      }
    }
  }
  return overlaps;
}

export function getStaleCodingTasks(ideaDir, thresholdMs = 30 * 60 * 1000) {
  const state = readTaskState(taskStateFile(ideaDir));
  const now = Date.now();
  return Object.entries(state.tasks)
    .filter(([taskId, task]) => {
      if (task.status !== 'coding' && task.status !== 'repairing') return false;
      const provenanceFile = join(ideaDir, 'task-runs', `${taskId}.json`);
      if (existsSync(provenanceFile)) {
        try {
          const run = JSON.parse(readFileSync(provenanceFile, 'utf8'));
          const attempt = run.attempts?.[run.attempts.length - 1];
          if (attempt && !attempt.finished_at && !attempt.abandoned_at && attempt.lease_until) {
            return new Date(attempt.lease_until).getTime() <= now;
          }
        } catch { /* malformed provenance falls back to legacy stale detection */ }
      }
      if (!task.started_at) return false;
      return now - new Date(task.started_at).getTime() > thresholdMs;
    })
    .map(([taskId, task]) => {
      const provenanceFile = join(ideaDir, 'task-runs', `${taskId}.json`);
      let lease = {};
      try {
        const run = JSON.parse(readFileSync(provenanceFile, 'utf8'));
        const attempt = run.attempts?.[run.attempts.length - 1] || {};
        lease = { run_id: attempt.run_id, owner: attempt.owner, lease_until: attempt.lease_until };
      } catch { /* legacy task */ }
      return { taskId, status: task.status, started_at: task.started_at, ...lease };
    });
}

export function detectRepairStall(ideaDir) {
  const state = readTaskState(taskStateFile(ideaDir));
  const stalled = [];
  for (const [taskId, task] of Object.entries(state.tasks)) {
    if (task.status !== 'repairing') continue;
    if ((task.rework_count || 0) < 2) continue;
    const reportPath = join(ideaDir, 'task-reports', `${taskId}-report.md`);
    if (!existsSync(reportPath)) continue;
    const crDir = join(ideaDir, 'cr');
    if (!existsSync(crDir)) continue;
    stalled.push({
      taskId,
      rework_count: task.rework_count || 0,
      suggestion: task.rework_count >= MAX_REWORK_COUNT
        ? 'mark_blocked'
        : 'consider splitting task or requesting human assistance',
    });
  }
  return stalled;
}

export function resolveProjectName(projectRoot) {
  try {
    const toplevel = execSync('git rev-parse --show-toplevel', { cwd: projectRoot, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    return basename(toplevel);
  } catch {
    return basename(projectRoot);
  }
}

export function detectComplexity(ideaDir) {
  const persisted = readRequirementClassification(ideaDir);
  if (persisted.valid) return persisted.value.routing_complexity;
  const reqPath = join(ideaDir, 'requirement.md');
  if (!existsSync(reqPath)) return 'standard';
  const text = readFileSync(reqPath, 'utf8');
  const explicitMatch = text.match(/^##\s*复杂度(?:[：:]\s*|\s*\n\s*)(hotfix|minor|trivial|moderate|standard|complex)\s*$/m);
  if (explicitMatch) return explicitMatch[1];
  const scopeHeading = text.match(/^##\s+涉及范围(?:（初步）)?\s*$/m);
  // Missing or empty scope is uncertainty, not evidence that a change is trivial.
  // Keep the conservative default until the requirement explicitly supplies scope.
  if (!scopeHeading) return 'standard';
  const scopeSection = text.slice(scopeHeading.index + scopeHeading[0].length).split(/^##\s+/m)[0] || '';
  const scopeItems = scopeSection.split('\n').filter(l => /^-\s+\S/.test(l)).length;
  if (scopeItems === 0) return 'standard';
  const hasNewTable = /新增.*表|新.*table|create.*table|DDL/i.test(text);
  const hasNewApi = /新增.*接口|new.*api|新.*endpoint/i.test(text);
  if (scopeItems <= 2 && !hasNewTable && !hasNewApi) {
    const repoMapPath = join(ideaDir, 'as-is/repo-map.json');
    if (existsSync(repoMapPath)) {
      try {
        const repoMap = JSON.parse(readFileSync(repoMapPath, 'utf8'));
        const topDirs = [...new Set(
          (repoMap.directory_summary || [])
            .filter(d => d.role === 'source')
            .map(d => d.path.split('/')[0].toLowerCase())
        )];
        const scopeTextLower = scopeSection.toLowerCase();
        const hitDirs = topDirs.filter(d => d.length >= 2 && scopeTextLower.includes(d));
        if (hitDirs.length >= 3) return 'standard';
      } catch { /* ignore parse errors */ }
    }
    return 'trivial';
  }
  if (scopeItems <= 4 && !hasNewTable && !hasNewApi) {
    const repoMapPath = join(ideaDir, 'as-is/repo-map.json');
    if (existsSync(repoMapPath)) {
      try {
        const repoMap = JSON.parse(readFileSync(repoMapPath, 'utf8'));
        const topDirs = [...new Set(
          (repoMap.directory_summary || [])
            .filter(d => d.role === 'source')
            .map(d => d.path.split('/')[0].toLowerCase())
        )];
        const scopeTextLower = scopeSection.toLowerCase();
        const hitDirs = topDirs.filter(d => d.length >= 2 && scopeTextLower.includes(d));
        if (hitDirs.length <= 2) return 'moderate';
      } catch { /* fallthrough to standard */ }
    } else {
      return 'moderate';
    }
  }
  if (scopeItems > 5) return 'complex';
  return 'standard';
}

export const REQUIREMENT_CLASSIFICATION_SOURCES = Object.freeze([
  'requirement.md',
  'requirement-clarification.json',
]);

export function requirementClassificationFingerprint(ideaDir) {
  const hash = createHash('sha256');
  for (const rel of REQUIREMENT_CLASSIFICATION_SOURCES) {
    const file = join(ideaDir, rel);
    if (!existsSync(file)) return null;
    hash.update(rel).update('\0').update(readFileSync(file)).update('\0');
  }
  let clarification;
  try { clarification = JSON.parse(readFileSync(join(ideaDir, 'requirement-clarification.json'), 'utf8')); } catch { clarification = null; }
  if (clarification?.schema_version === 2) {
    for (const rel of ['requirement-original.md', 'requirement-inputs.json', 'confirmations/requirement.json']) {
      const file = join(ideaDir, rel);
      if (!existsSync(file)) return null;
      hash.update(rel).update('\0').update(readFileSync(file)).update('\0');
    }
  }
  const escalation = join(ideaDir, 'scope-escalation.json');
  if (existsSync(escalation)) hash.update('scope-escalation.json').update('\0').update(readFileSync(escalation)).update('\0');
  return hash.digest('hex');
}

export function readRequirementClassification(ideaDir) {
  const file = join(ideaDir, 'requirement-classification.json');
  if (!existsSync(file)) return { valid: false, reason: 'requirement-classification.json missing' };
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    if (value?.schema_version !== 1 || value?.source_step !== 'classify:requirement') {
      return { valid: false, reason: 'invalid requirement classification contract' };
    }
    const actual = requirementClassificationFingerprint(ideaDir);
    if (!actual || value.input_fingerprint !== actual) {
      return { valid: false, reason: 'requirement classification is stale' };
    }
    if (!ALL_COMPLEXITIES.includes(value.routing_complexity)) {
      return { valid: false, reason: 'invalid routing_complexity' };
    }
    const expectedDifficulty = ['hotfix', 'minor', 'trivial'].includes(value.routing_complexity) ? 'simple'
      : value.routing_complexity === 'moderate' ? 'moderate' : 'complex';
    const expectedProfile = expectedDifficulty === 'simple' ? 'direct' : expectedDifficulty === 'moderate' ? 'lightweight' : 'full';
    const expectedBudget = expectedDifficulty === 'simple'
      ? { max_concurrent: 1, discovery: 0, planning: 0, document_writers: 0, reviewers: 1 }
      : expectedDifficulty === 'moderate'
        ? { max_concurrent: 2, discovery: 0, planning: 1, document_writers: 1, reviewers: 1 }
        : { max_concurrent: 4, discovery: 2, planning: 1, document_writers: 1, reviewers: 2 };
    if (value.difficulty !== expectedDifficulty || value.execution_profile !== expectedProfile || JSON.stringify(value.subagent_budget) !== JSON.stringify(expectedBudget)) {
      return { valid: false, reason: 'requirement classification difficulty/profile/budget mismatch' };
    }
    if (!value.signals || typeof value.signals !== 'object' || !Array.isArray(value.reasons)) {
      return { valid: false, reason: 'requirement classification signals/reasons missing' };
    }
    return { valid: true, value };
  } catch (error) {
    return { valid: false, reason: `requirement classification is malformed: ${error.message}` };
  }
}

export function classifyChange(ideaDir) {
  const persisted = readRequirementClassification(ideaDir);
  if (persisted.valid) {
    const value = persisted.value;
    return {
      delivery_complexity: value.delivery_complexity,
      risk_level: value.risk_level,
      uncertainty_level: value.uncertainty_level,
      routing_complexity: value.routing_complexity,
      difficulty: value.difficulty,
      execution_profile: value.execution_profile,
      subagent_budget: value.subagent_budget,
      reasons: value.reasons || [],
    };
  }
  const delivery_complexity = detectComplexity(ideaDir);
  let risk_level = 'low';
  let uncertainty_level = 'low';
  const reasons = [];
  const requirementPath = join(ideaDir, 'requirement.md');
  const requirement = existsSync(requirementPath) ? readFileSync(requirementPath, 'utf8') : '';
  const explicitRiskRaw = requirement.match(/^##\s*(?:风险|Risk)(?:[：:]\s*|\s*\n\s*)(low|medium|high|低|中|高)(?:风险)?\s*$/im)?.[1]?.toLowerCase();
  const explicitRisk = explicitRiskRaw === '低' ? 'low' : explicitRiskRaw === '中' ? 'medium' : explicitRiskRaw === '高' ? 'high' : explicitRiskRaw;
  if (explicitRisk) risk_level = explicitRisk;
  const reportPath = join(ideaDir, 'impact-risk-report.json');
  if (existsSync(reportPath)) {
    try {
      const reportRisk = JSON.parse(readFileSync(reportPath, 'utf8'))?.summary?.risk_level;
      if (['low', 'medium', 'high'].includes(reportRisk)) risk_level = reportRisk;
    } catch { uncertainty_level = 'high'; reasons.push('impact-risk-report is malformed'); }
  } else if (!explicitRisk && /(auth|permission|token|payment|billing|migration|ddl|delete|security|鉴权|权限|支付|迁移|删除|安全)/i.test(requirement)) {
    risk_level = 'high';
    reasons.push('requirement contains a high-risk change signal');
  }
  if (/\b(TBD|unknown|unclear|open question)\b|待定|未知|不明确|待确认/i.test(requirement)) {
    uncertainty_level = 'high';
    reasons.push('requirement contains unresolved uncertainty');
  }
  const order = ['hotfix', 'minor', 'trivial', 'moderate', 'standard', 'complex'];
  let routing_complexity = delivery_complexity;
  const promote = target => {
    if (order.indexOf(routing_complexity) < order.indexOf(target)) routing_complexity = target;
  };
  if (risk_level === 'high' || uncertainty_level === 'high') promote('standard');
  else if (risk_level === 'medium') promote('moderate');
  if (routing_complexity !== delivery_complexity) reasons.push(`route promoted from ${delivery_complexity} to ${routing_complexity}`);
  return { delivery_complexity, risk_level, uncertainty_level, routing_complexity, reasons };
}
