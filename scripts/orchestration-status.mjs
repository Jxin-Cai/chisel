#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import {
  allTasksApproved,
  getBlockedReworkTasks,
  getCodedTasksNeedingReview,
  getNextTasks,
  getReworkTasks,
  readTaskState,
  taskStateFile,
  updateWorkflowPhase
} from './workflow-lib.mjs';
import { checkGate } from './gate-check.mjs';
import { appendAuditLog, lastStepTransition } from './audit-log.mjs';

const IDEA_DIR = process.argv[2];

if (!IDEA_DIR) {
  process.stderr.write('用法: node orchestration-status.mjs <idea-dir|none>\n');
  process.exit(1);
}

function emit(resumeStep, reason, phaseDetail = {}) {
  console.log(`resume_step: ${resumeStep}`);
  console.log(`reason: ${JSON.stringify(reason)}`);
  const entries = Object.entries(phaseDetail).filter(([, value]) => value !== undefined && value !== '');
  if (entries.length > 0) {
    console.log('phase_detail:');
    for (const [key, value] of entries) console.log(`  ${key}: ${Array.isArray(value) ? value.join(',') : value}`);
  }
  if (IDEA_DIR && IDEA_DIR !== 'none' && existsSync(IDEA_DIR)) {
    const prev = lastStepTransition(IDEA_DIR);
    appendAuditLog(IDEA_DIR, { type: 'step_transition', from: prev?.to || 'unknown', to: resumeStep, reason });
    updateWorkflowPhase(IDEA_DIR, resumeStep);
  }
}

function has(rel) {
  return existsSync(join(IDEA_DIR, rel));
}

function isInWorktree() {
  try {
    const gitDir = execSync('git rev-parse --git-dir', { encoding: 'utf8' }).trim();
    const commonDir = execSync('git rev-parse --git-common-dir', { encoding: 'utf8' }).trim();
    return gitDir !== commonDir;
  } catch { return false; }
}

function main() {
  if (IDEA_DIR === 'none' || !existsSync(IDEA_DIR)) {
    emit('receive-requirement', 'idea directory does not exist');
    return;
  }
  if (!checkGate(IDEA_DIR, 'requirement-exists').pass) {
    emit('receive-requirement', 'requirement.md does not exist');
    return;
  }
  if (!checkGate(IDEA_DIR, 'as-is-complete').pass) {
    emit('understand:explore', 'as-is documents are incomplete');
    return;
  }
  if (!checkGate(IDEA_DIR, 'as-is-confirmed').pass) {
    emit('understand:confirm', 'as-is structured confirmation is missing or invalid');
    return;
  }
  if (!checkGate(IDEA_DIR, 'ai-input-ready').pass) {
    emit('understand:generate-ai-input', 'ai-input documents have not been generated from confirmed as-is');
    return;
  }
  if (!checkGate(IDEA_DIR, 'to-be-exists').pass) {
    emit('plan:design', 'to-be implementation plan does not exist');
    return;
  }
  if (!checkGate(IDEA_DIR, 'to-be-confirmed').pass) {
    emit('plan:confirm', 'to-be structured confirmation is missing or invalid');
    return;
  }
  if (!has('task-workflow-state.yaml')) {
    emit('tasks:init', 'task workflow state does not exist');
    return;
  }

  const blocked = getBlockedReworkTasks(IDEA_DIR);
  if (blocked.length > 0) {
    emit('blocked', 'task reached max rework count', { blocked_tasks: blocked });
    return;
  }

  const reworkTasks = getReworkTasks(IDEA_DIR);
  if (reworkTasks.length > 0) {
    emit('repair:code', 'there are tasks that need rework', { next_tasks: reworkTasks });
    return;
  }

  const reviewTasks = getCodedTasksNeedingReview(IDEA_DIR);
  if (reviewTasks.length > 0) {
    emit('review:cr', 'there are coded tasks needing architecture review', { next_tasks: reviewTasks });
    return;
  }

  const codeTasks = getNextTasks(IDEA_DIR);
  if (codeTasks.length > 0) {
    emit('implement:code', 'there are confirmed tasks ready to code', { next_tasks: codeTasks });
    return;
  }

  if (allTasksApproved(IDEA_DIR) && !checkGate(IDEA_DIR, 'done').pass) {
    if (!checkGate(IDEA_DIR, 'knowledge-extracted').pass) {
      emit('knowledge:extract', 'all tasks approved, knowledge candidate extraction is pending');
      return;
    }
    emit('final:summary', 'all tasks approved, final summary is pending');
    return;
  }

  if (checkGate(IDEA_DIR, 'done').pass) {
    emit('done', 'workflow is done', { in_worktree: isInWorktree() });
    return;
  }

  const state = readTaskState(taskStateFile(IDEA_DIR));
  emit('blocked', 'no executable next step found', { task_count: Object.keys(state.tasks).length });
}

main();
