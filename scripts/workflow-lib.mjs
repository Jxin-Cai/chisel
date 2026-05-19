import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { appendAuditLog } from './audit-log.mjs';

export const TASK_STATES = ['pending', 'confirmed', 'coding', 'coded', 'reviewing', 'approved', 'needs_rework', 'repairing', 'failed', 'blocked'];
export const MAX_REWORK_COUNT = 3;

const VALID_TRANSITIONS = new Set([
  'pending:confirmed',
  'confirmed:coding',
  'coding:coded',
  'coding:failed',
  'failed:confirmed',
  'coded:reviewing',
  'reviewing:approved',
  'reviewing:needs_rework',
  'needs_rework:repairing',
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
  if (trimmed.startsWith('{')) return JSON.parse(trimmed);
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  return trimmed.replace(/^['"]|['"]$/g, '');
}

export function readTaskExpectedFiles(taskFile) {
  if (!taskFile || !existsSync(taskFile)) return [];
  const text = readFileSync(taskFile, 'utf8');
  const parsed = readFrontmatter(text);
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
    shared_state: Array.isArray(surface.shared_state) ? surface.shared_state : []
  };
}

export function writeTaskState(file, state) {
  ensureDir(dirname(file));
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
  atomicWriteFile(file, `${out.join('\n')}\n`);
}

export function initWorkflowState(ideaDir, ideaName) {
  ensureDir(ideaDir);
  const now = new Date().toISOString();
  atomicWriteFile(workflowStateFile(ideaDir), [
    `idea: ${ideaName}`,
    `started_at: ${now}`,
    `last_updated_at: ${now}`,
    `current_step: receive-requirement`,
    'phase:',
    '  requirement: done',
    '  understand: pending',
    '  clarify: pending',
    '  plan: pending',
    '  tasks: pending',
    '  implement: pending',
    '  review: pending',
    '  knowledge: pending',
    '  final: pending',
    ''
  ].join('\n'));
}

const STEP_TO_PHASE = {
  'receive-requirement': 'requirement',
  'understand:explore': 'understand',
  'understand:confirm': 'understand',
  'understand:generate-ai-input': 'understand',
  'clarify:requirement': 'clarify',
  'plan:strategy': 'plan',
  'plan:strategy-confirm': 'plan',
  'plan:decompose': 'plan',
  'plan:decompose-confirm': 'plan',
  'plan:design': 'plan',
  'plan:confirm': 'plan',
  'worktree:setup': 'plan',
  'tasks:init': 'tasks',
  'implement:code': 'implement',
  'repair:code': 'implement',
  'review:cr': 'review',
  'knowledge:extract': 'knowledge',
  'final:summary': 'final'
};

export function updateWorkflowPhase(ideaDir, stepId) {
  const file = workflowStateFile(ideaDir);
  if (!existsSync(file)) return;
  let text = readFileSync(file, 'utf8');
  const now = new Date().toISOString();
  text = text.replace(/^last_updated_at:.*$/m, `last_updated_at: ${now}`);
  text = text.replace(/^current_step:.*$/m, `current_step: ${stepId}`);
  const phase = STEP_TO_PHASE[stepId];
  if (phase) {
    text = text.replace(new RegExp(`^(  ${phase}:).*$`, 'm'), `$1 in_progress`);
  }
  atomicWriteFile(file, text);
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

export function getCodedTasksNeedingReview(ideaDir) {
  const state = readTaskState(taskStateFile(ideaDir));
  return Object.entries(state.tasks).filter(([, task]) => task.status === 'coded').map(([taskId]) => taskId);
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

export function getTasksFileOverlap(ideaDir, taskIds) {
  const state = readTaskState(taskStateFile(ideaDir));
  const fileMap = {};
  for (const tid of taskIds) {
    for (const f of (state.tasks[tid]?.expected_files || [])) {
      (fileMap[f] ??= []).push(tid);
    }
  }
  return Object.entries(fileMap)
    .filter(([, tasks]) => tasks.length > 1)
    .map(([file, tasks]) => ({ file, tasks }));
}

export function getTasksImpactOverlap(ideaDir, taskIds) {
  const state = readTaskState(taskStateFile(ideaDir));
  const byKind = { files: {}, symbols: {}, invariants: {}, shared_state: {} };
  for (const tid of taskIds) {
    const task = state.tasks[tid] || {};
    const surface = normalizeImpactSurface(task.impact_surface || { files: task.expected_files || [] });
    for (const kind of Object.keys(byKind)) {
      for (const value of surface[kind] || []) {
        (byKind[kind][value] ??= []).push(tid);
      }
    }
  }
  return Object.entries(byKind).flatMap(([kind, values]) => Object.entries(values)
    .filter(([, tasks]) => tasks.length > 1)
    .map(([value, tasks]) => ({ kind, value, tasks })));
}

export function updateTaskStatus(ideaDir, taskId, nextStatus) {
  if (!TASK_STATES.includes(nextStatus)) throw new Error(`invalid task status: ${nextStatus}`);
  const file = taskStateFile(ideaDir);
  const state = readTaskState(file);
  const task = state.tasks[taskId];
  if (!task) throw new Error(`unknown task: ${taskId}`);
  const current = task.status || 'pending';
  if (!VALID_TRANSITIONS.has(`${current}:${nextStatus}`)) {
    throw new Error(`invalid transition: ${taskId} ${current} -> ${nextStatus}`);
  }
  task.status = nextStatus;
  if (nextStatus === 'coding' || nextStatus === 'repairing') {
    task.started_at = new Date().toISOString();
  }
  writeTaskState(file, state);
  appendAuditLog(ideaDir, { type: 'task_state_change', task_id: taskId, from: current, to: nextStatus });
  return task;
}

export function markCr(ideaDir, taskId, result) {
  const status = result === 'approved' ? 'approved' : result === 'needs_rework' ? 'needs_rework' : 'blocked';
  const file = taskStateFile(ideaDir);
  const state = readTaskState(file);
  const task = state.tasks[taskId];
  if (!task) throw new Error(`unknown task: ${taskId}`);
  const current = task.status;
  if (task.status !== 'reviewing' && task.status !== 'coded' && task.status !== status) {
    throw new Error(`task ${taskId} is not reviewable from ${task.status}`);
  }
  if (result === 'needs_rework') task.rework_count = Number(task.rework_count || 0) + 1;
  task.status = status;
  if (task.rework_count >= MAX_REWORK_COUNT && status === 'needs_rework') task.status = 'blocked';
  writeTaskState(file, state);
  appendAuditLog(ideaDir, { type: 'task_state_change', task_id: taskId, from: current, to: task.status, detail: { cr_result: result, rework_count: task.rework_count || 0 } });
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
        appendAuditLog(ideaDir, { type: 'task_state_change', task_id: taskId, from, to: 'approved', detail: { cr_result: 'approved', review_level: 'requirement' } });
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
      appendAuditLog(ideaDir, { type: 'task_state_change', task_id: taskId, from, to: task.status, detail: { cr_result: result, review_level: 'requirement', rework_count: task.rework_count || 0 } });
    }
    for (const [taskId, task] of Object.entries(state.tasks)) {
      if (!affected.includes(taskId) && (task.status === 'reviewing' || task.status === 'coded')) {
        const from = task.status;
        task.status = 'approved';
        results.push({ task_id: taskId, from, to: 'approved' });
        appendAuditLog(ideaDir, { type: 'task_state_change', task_id: taskId, from, to: 'approved', detail: { cr_result: 'approved', review_level: 'requirement' } });
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
      '.knowledge-extracted',
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
      '.knowledge-extracted',
      'final-summary.md',
      '.done'
    ]
  },
  'clarify:requirement': {
    remove: [
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
      '.knowledge-extracted',
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
      '.knowledge-extracted',
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
      '.knowledge-extracted',
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
      '.knowledge-extracted',
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
      '.knowledge-extracted',
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
      '.knowledge-extracted',
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
      '.knowledge-extracted',
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
      '.knowledge-extracted',
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
      '.knowledge-extracted',
      'final-summary.md',
      '.done'
    ]
  },
  'implement:code': {
    remove: ['task-reports', 'cr', '.knowledge-extracted', 'final-summary.md', '.done'],
    reset: {
      from: ['coding', 'coded', 'reviewing', 'approved', 'needs_rework', 'repairing', 'failed', 'blocked'],
      to: 'confirmed'
    }
  },
  'review:cr': {
    remove: ['cr', '.knowledge-extracted', 'final-summary.md', '.done'],
    reset: {
      from: ['reviewing', 'approved', 'needs_rework', 'repairing', 'blocked'],
      to: 'coded'
    }
  },
  'knowledge:extract': {
    remove: ['.knowledge-extracted', 'final-summary.md', '.done']
  },
  'final:summary': {
    remove: ['final-summary.md', '.done']
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
  updateWorkflowPhase(ideaDir, stepId);
  appendAuditLog(ideaDir, { type: 'rollback', to_step: stepId, removed: plan.removed, missing: plan.missing, task_resets: plan.task_resets });
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
  writeTaskState(file, state);
  appendAuditLog(ideaDir, { type: 'task_rollback', task_id: taskId, from: current, to: 'confirmed', removed: toRemove });
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
    .filter(([, task]) => {
      if (task.status !== 'coding' && task.status !== 'repairing') return false;
      if (!task.started_at) return false;
      return now - new Date(task.started_at).getTime() > thresholdMs;
    })
    .map(([taskId, task]) => ({ taskId, status: task.status, started_at: task.started_at }));
}

export function resolveProjectName(projectRoot) {
  try {
    const toplevel = execSync('git rev-parse --show-toplevel', { cwd: projectRoot, encoding: 'utf8' }).trim();
    return basename(toplevel);
  } catch {
    return basename(projectRoot);
  }
}
