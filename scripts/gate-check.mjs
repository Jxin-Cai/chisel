#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { allTasksApproved, readTaskState, taskStateFile } from './workflow-lib.mjs';

const AS_IS_FILES = [
  'as-is/overview.md',
  'as-is/call-chain-sequence.md',
  'as-is/core-logic.md',
  'as-is/er-diagram.md',
  'as-is/api-contracts.md',
  'as-is/change-points.md',
  'as-is/evidence-index.md'
];

function has(ideaDir, rel) {
  return existsSync(join(ideaDir, rel));
}

function taskEntries(ideaDir) {
  return Object.entries(readTaskState(taskStateFile(ideaDir)).tasks || {});
}

export function checkGate(ideaDir, gateId) {
  if (!ideaDir || ideaDir === 'none') return { pass: false, gate: gateId, reason: 'idea-dir does not exist' };
  switch (gateId) {
    case 'requirement-exists':
      return result(gateId, has(ideaDir, 'requirement.md'), 'requirement.md missing');
    case 'as-is-complete': {
      const missing = AS_IS_FILES.filter(file => !has(ideaDir, file));
      return missing.length === 0 ? result(gateId, true) : result(gateId, false, `missing: ${missing.join(', ')}`);
    }
    case 'as-is-confirmed':
      return result(gateId, has(ideaDir, '.as-is-confirmed'), '.as-is-confirmed missing');
    case 'to-be-exists':
      return result(gateId, has(ideaDir, 'to-be/implementation-plan.md'), 'to-be/implementation-plan.md missing');
    case 'to-be-confirmed':
      return result(gateId, has(ideaDir, '.to-be-confirmed'), '.to-be-confirmed missing');
    case 'tasks-exist':
      return result(gateId, has(ideaDir, 'tasks'), 'tasks directory missing');
    case 'task-workflow-exists':
      return result(gateId, has(ideaDir, 'task-workflow-state.yaml'), 'task-workflow-state.yaml missing');
    case 'task-integrity': {
      if (!has(ideaDir, 'task-workflow-state.yaml')) return result(gateId, false, 'task-workflow-state.yaml missing');
      const missing = taskEntries(ideaDir).filter(([, task]) => !has(ideaDir, task.file)).map(([taskId]) => taskId);
      return missing.length === 0 ? result(gateId, true) : result(gateId, false, `missing task files: ${missing.join(', ')}`);
    }
    case 'task-report-exists': {
      if (!has(ideaDir, 'task-workflow-state.yaml')) return result(gateId, false, 'task-workflow-state.yaml missing');
      const missing = taskEntries(ideaDir).filter(([, task]) => ['coded', 'reviewing', 'approved', 'needs_rework', 'blocked'].includes(task.status) && !has(ideaDir, task.report_file)).map(([taskId]) => taskId);
      return missing.length === 0 ? result(gateId, true) : result(gateId, false, `missing task reports: ${missing.join(', ')}`);
    }
    case 'cr-complete': {
      if (!has(ideaDir, 'task-workflow-state.yaml')) return result(gateId, false, 'task-workflow-state.yaml missing');
      const missing = taskEntries(ideaDir).filter(([, task]) => ['approved', 'needs_rework', 'blocked'].includes(task.status) && !has(ideaDir, task.cr_file)).map(([taskId]) => taskId);
      return missing.length === 0 ? result(gateId, true) : result(gateId, false, `missing cr files: ${missing.join(', ')}`);
    }
    case 'rework-limit': {
      if (!has(ideaDir, 'task-workflow-state.yaml')) return result(gateId, false, 'task-workflow-state.yaml missing');
      const over = taskEntries(ideaDir).filter(([, task]) => Number(task.rework_count || 0) > 3).map(([taskId]) => taskId);
      return over.length === 0 ? result(gateId, true) : result(gateId, false, `rework over limit: ${over.join(', ')}`);
    }
    case 'all-approved':
      return result(gateId, has(ideaDir, 'task-workflow-state.yaml') && allTasksApproved(ideaDir), 'not all tasks approved');
    case 'done':
      return result(gateId, has(ideaDir, '.done'), '.done missing');
    default:
      return { pass: false, gate: gateId, reason: `unknown gate: ${gateId}` };
  }
}

function result(gate, pass, reason = '') {
  return pass ? { pass: true, gate } : { pass: false, gate, reason };
}

export async function main(argv) {
  const ideaDir = argv[0];
  const gateId = argv[1];
  if (!ideaDir || !gateId) {
    process.stderr.write('用法: gate-check.mjs <idea-dir> <gate-id>\n');
    process.exit(1);
  }
  const checked = checkGate(ideaDir, gateId);
  console.log(JSON.stringify(checked));
  if (!checked.pass) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
