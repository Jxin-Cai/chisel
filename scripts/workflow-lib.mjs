import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
      expected_files: Array.isArray(obj.expected_files) ? obj.expected_files : []
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
    out.push(`    report_file: ${quoteYaml(task.report_file || `task-reports/${taskId}-report.md`)}`);
    out.push(`    cr_file: ${quoteYaml(task.cr_file || `cr/${taskId}-cr.md`)}`);
    out.push(`    rework_count: ${Number(task.rework_count || 0)}`);
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
  'plan:design': 'plan',
  'plan:confirm': 'plan',
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
