#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  allTasksApproved,
  detectComplexity,
  detectRepairStall,
  getBlockedReworkTasks,
  getCodingTasks,
  getRepairingTasks,
  getReviewBacklogTasks,
  getNextTasks,
  getReworkTasks,
  getStaleCodingTasks,
  readTaskState,
  taskStateFile,
  updateWorkflowPhase
} from './workflow-lib.mjs';
import { checkGate } from './gate-check.mjs';
import { recordStepStart, recordStepFinish } from './session-metrics.mjs';
import { createSnapshot } from './checkpoint.mjs';

const IDEA_DIR = process.argv[2];
const compact = process.argv.includes('--compact');
const dryRun = process.argv.includes('--dry-run');

if (!IDEA_DIR) {
  process.stderr.write('用法: node orchestration-status.mjs <idea-dir|none> [--compact] [--dry-run]\n');
  process.exit(1);
}

function readPreviousStep(ideaDir) {
  const p = join(ideaDir, 'workflow-state.yaml');
  if (!existsSync(p)) return null;
  const text = readFileSync(p, 'utf8');
  const m = text.match(/^current_step:\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

function emit(resumeStep, reason, phaseDetail = {}) {
  const complexity = phaseDetail.complexity || (IDEA_DIR && IDEA_DIR !== 'none' && existsSync(IDEA_DIR) ? detectComplexity(IDEA_DIR) : 'standard');
  console.log(`resume_step: ${resumeStep}`);
  console.log(`reason: ${JSON.stringify(reason)}`);
  console.log(`complexity: ${complexity}`);
  const entries = Object.entries(phaseDetail).filter(([k, v]) => v !== undefined && v !== '' && k !== 'complexity');
  if (entries.length > 0) {
    if (compact) {
      console.log(`phase_detail: ${entries.map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`).join('|')}`);
    } else {
      console.log('phase_detail:');
      for (const [key, value] of entries) console.log(`  ${key}: ${Array.isArray(value) ? value.join(',') : value}`);
    }
  }
  if (IDEA_DIR && IDEA_DIR !== 'none' && existsSync(IDEA_DIR)) {
    const prevStep = readPreviousStep(IDEA_DIR);
    if (prevStep && prevStep !== resumeStep) {
      try { recordStepFinish(IDEA_DIR, prevStep); } catch { /* non-critical */ }
      try { createSnapshot(IDEA_DIR); } catch { /* non-critical */ }
    }
    try { recordStepStart(IDEA_DIR, resumeStep); } catch { /* non-critical */ }
    updateWorkflowPhase(IDEA_DIR, resumeStep);
    const shouldOpen = prevStep !== resumeStep;
    try {
      const __dirname = dirname(fileURLToPath(import.meta.url));
      const openFlag = shouldOpen ? '' : ' --no-open';
      execSync(`node "${join(__dirname, 'dashboard.mjs')}" "${IDEA_DIR}"${openFlag}`, { stdio: 'ignore', timeout: 5000 });
    } catch { /* non-critical */ }
    if (shouldOpen) console.log('dashboard_opened: true');
  }
}

function has(rel) {
  return existsSync(join(IDEA_DIR, rel));
}


function isInWorktree() {
  try {
    const gitDir = execSync('git rev-parse --git-dir', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const commonDir = execSync('git rev-parse --git-common-dir', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    return gitDir !== commonDir;
  } catch { return false; }
}

function dryRunPlan() {
  const complexity = (IDEA_DIR && IDEA_DIR !== 'none' && existsSync(IDEA_DIR))
    ? detectComplexity(IDEA_DIR) : 'standard';

  const PATHS = {
    hotfix: [
      { step: 'receive-requirement', phase: 'requirement' },
      { step: 'quick-dev:init', phase: 'tasks' },
      { step: 'implement:code', phase: 'implement' },
      { step: 'review:cr-light', phase: 'review' },
      { step: 'final:summary', phase: 'final' },
    ],
    minor: [
      { step: 'receive-requirement', phase: 'requirement' },
      { step: 'clarify:requirement', phase: 'clarify', note: '2 dimensions: functional_scope + acceptance_criteria' },
      { step: 'quick-dev:init', phase: 'tasks' },
      { step: 'implement:code', phase: 'implement' },
      { step: 'review:cr-light', phase: 'review' },
      { step: 'final:summary', phase: 'final' },
    ],
    trivial: [
      { step: 'receive-requirement', phase: 'requirement' },
      { step: 'clarify:requirement', phase: 'clarify', note: '2 dimensions: functional_scope + acceptance_criteria' },
      { step: 'quick-dev:init', phase: 'tasks' },
      { step: 'implement:code', phase: 'implement' },
      { step: 'review:cr-light', phase: 'review' },
      { step: 'final:summary', phase: 'final' },
    ],
    moderate: [
      { step: 'receive-requirement', phase: 'requirement' },
      { step: 'clarify:requirement', phase: 'clarify', note: '4 dimensions' },
      { step: 'plan:design', phase: 'plan', note: 'no impact-risk-report' },
      { step: 'plan:confirm', phase: 'plan' },
      { step: 'worktree:setup', phase: 'plan' },
      { step: 'tasks:init', phase: 'tasks' },
      { step: 'implement:code', phase: 'implement' },
      { step: 'review:cr-moderate', phase: 'review', note: 'spec + D3 + D4 + D5' },
      { step: 'final:summary', phase: 'final' },
    ],
    standard: [
      { step: 'receive-requirement', phase: 'requirement' },
      { step: 'understand:explore', phase: 'understand' },
      { step: 'understand:confirm', phase: 'understand' },
      { step: 'clarify:requirement', phase: 'clarify', note: '7 dimensions' },
      { step: 'plan:design', phase: 'plan' },
      { step: 'plan:confirm', phase: 'plan' },
      { step: 'worktree:setup', phase: 'plan' },
      { step: 'tasks:init', phase: 'tasks' },
      { step: 'implement:code', phase: 'implement' },
      { step: 'review:cr', phase: 'review', note: 'spec gate + D2-D8' },
      { step: 'knowledge:extract', phase: 'knowledge', note: 'parallel side-branch' },
      { step: 'final:summary', phase: 'final' },
    ],
    complex: [
      { step: 'receive-requirement', phase: 'requirement' },
      { step: 'understand:explore', phase: 'understand' },
      { step: 'understand:confirm', phase: 'understand' },
      { step: 'clarify:requirement', phase: 'clarify', note: '7 dimensions' },
      { step: 'plan:design', phase: 'plan' },
      { step: 'plan:confirm', phase: 'plan' },
      { step: 'worktree:setup', phase: 'plan' },
      { step: 'tasks:init', phase: 'tasks' },
      { step: 'implement:code', phase: 'implement' },
      { step: 'review:cr', phase: 'review', note: 'spec gate + D2-D8' },
      { step: 'knowledge:extract', phase: 'knowledge', note: 'parallel side-branch' },
      { step: 'final:summary', phase: 'final' },
    ],
  };

  const steps = PATHS[complexity] || PATHS.standard;
  const currentStep = readPreviousStep(IDEA_DIR);

  const output = {
    dry_run: true,
    complexity,
    current_step: currentStep || 'none',
    steps: steps.map(s => ({
      step: s.step,
      phase: s.phase,
      ...(s.note ? { note: s.note } : {}),
      ...(currentStep && s.step === currentStep ? { current: true } : {}),
    })),
  };
  console.log(JSON.stringify(output, null, 2));
}

function main() {
  if (dryRun) { dryRunPlan(); return; }

  if (IDEA_DIR === 'none' || !existsSync(IDEA_DIR)) {
    emit('receive-requirement', 'idea directory does not exist');
    return;
  }
  if (!checkGate(IDEA_DIR, 'requirement-exists').pass) {
    emit('receive-requirement', 'requirement.md does not exist');
    return;
  }

  const complexity = detectComplexity(IDEA_DIR);

  // === HOTFIX QUICK PATH ===
  if (complexity === 'hotfix') {
    if (!has('task-workflow-state.yaml')) {
      emit('quick-dev:init', 'auto-generating hotfix task (single-file, ≤5 lines)', { complexity });
      return;
    }
    const staleTasks = getStaleCodingTasks(IDEA_DIR);
    if (staleTasks.length > 0) {
      emit('implement:code', 'stale coding tasks detected', { stale_tasks: staleTasks.map(t => t.taskId), complexity });
      return;
    }
    const blocked = getBlockedReworkTasks(IDEA_DIR);
    if (blocked.length > 0) {
      emit('blocked', 'task reached max rework count', { blocked_tasks: blocked, complexity });
      return;
    }
    const repairingTasks = getRepairingTasks(IDEA_DIR);
    if (repairingTasks.length > 0) {
      emit('repair:code', 'tasks are already being repaired', { in_progress_tasks: repairingTasks, complexity });
      return;
    }
    const reworkTasks = getReworkTasks(IDEA_DIR);
    if (reworkTasks.length > 0) {
      emit('repair:code', 'there are tasks that need rework', { next_tasks: reworkTasks, complexity });
      return;
    }
    const reviewTasks = getReviewBacklogTasks(IDEA_DIR);
    if (reviewTasks.length > 0) {
      emit('review:cr-light', 'tasks are ready or already in review (hotfix: spec-only)', { next_tasks: reviewTasks, complexity });
      return;
    }
    const codingTasks = getCodingTasks(IDEA_DIR);
    if (codingTasks.length > 0) {
      emit('implement:code', 'tasks are already being coded', { in_progress_tasks: codingTasks, complexity });
      return;
    }
    const codeTasks = getNextTasks(IDEA_DIR);
    if (codeTasks.length > 0) {
      emit('implement:code', 'there are confirmed tasks ready to code', { next_tasks: codeTasks, complexity });
      return;
    }
    if (allTasksApproved(IDEA_DIR)) {
      if (!checkGate(IDEA_DIR, 'done').pass) {
        emit('final:summary', 'all tasks approved, final summary is pending', { complexity });
        return;
      }
      emit('done', 'workflow is done', { in_worktree: isInWorktree(), complexity });
      return;
    }
    const state = readTaskState(taskStateFile(IDEA_DIR));
    emit('blocked', 'no executable next step found (hotfix)', { task_count: Object.keys(state.tasks).length, complexity });
    return;
  }

  // === MINOR QUICK PATH ===
  if (complexity === 'minor') {
    if (!checkGate(IDEA_DIR, 'clarification-complete').pass) {
      emit('clarify:requirement', 'lightweight clarification needed (minor: functional_scope + acceptance_criteria)', { complexity });
      return;
    }
    if (!has('task-workflow-state.yaml')) {
      emit('quick-dev:init', 'auto-generating task from requirement-clarification (minor quick-dev)', { complexity });
      return;
    }
    const staleTasks = getStaleCodingTasks(IDEA_DIR);
    if (staleTasks.length > 0) {
      emit('implement:code', 'stale coding tasks detected', { stale_tasks: staleTasks.map(t => t.taskId), complexity });
      return;
    }
    const blocked = getBlockedReworkTasks(IDEA_DIR);
    if (blocked.length > 0) {
      emit('blocked', 'task reached max rework count', { blocked_tasks: blocked, complexity });
      return;
    }
    const repairingTasks = getRepairingTasks(IDEA_DIR);
    if (repairingTasks.length > 0) {
      emit('repair:code', 'tasks are already being repaired', { in_progress_tasks: repairingTasks, complexity });
      return;
    }
    const reworkTasks = getReworkTasks(IDEA_DIR);
    if (reworkTasks.length > 0) {
      emit('repair:code', 'there are tasks that need rework', { next_tasks: reworkTasks, complexity });
      return;
    }
    const reviewTasks = getReviewBacklogTasks(IDEA_DIR);
    if (reviewTasks.length > 0) {
      emit('review:cr-light', 'tasks are ready or already in review (minor: spec + light)', { next_tasks: reviewTasks, complexity });
      return;
    }
    const codingTasks = getCodingTasks(IDEA_DIR);
    if (codingTasks.length > 0) {
      emit('implement:code', 'tasks are already being coded', { in_progress_tasks: codingTasks, complexity });
      return;
    }
    const codeTasks = getNextTasks(IDEA_DIR);
    if (codeTasks.length > 0) {
      emit('implement:code', 'there are confirmed tasks ready to code', { next_tasks: codeTasks, complexity });
      return;
    }
    if (allTasksApproved(IDEA_DIR)) {
      if (!checkGate(IDEA_DIR, 'done').pass) {
        emit('final:summary', 'all tasks approved, final summary is pending', { complexity });
        return;
      }
      emit('done', 'workflow is done', { in_worktree: isInWorktree(), complexity });
      return;
    }
    const state = readTaskState(taskStateFile(IDEA_DIR));
    emit('blocked', 'no executable next step found (minor)', { task_count: Object.keys(state.tasks).length, complexity });
    return;
  }

  // === TRIVIAL QUICK-DEV PATH ===
  if (complexity === 'trivial') {
    if (!checkGate(IDEA_DIR, 'clarification-complete').pass) {
      emit('clarify:requirement', 'lightweight clarification needed (trivial: only functional_scope + acceptance_criteria)', { complexity });
      return;
    }
    if (!has('task-workflow-state.yaml')) {
      emit('quick-dev:init', 'auto-generating task from requirement-clarification (trivial quick-dev)', { complexity });
      return;
    }
    // From here, trivial reuses the standard implement/review loop
    const staleTasks = getStaleCodingTasks(IDEA_DIR);
    if (staleTasks.length > 0) {
      emit('implement:code', 'stale coding tasks detected', { stale_tasks: staleTasks.map(t => t.taskId), complexity });
      return;
    }
    const blocked = getBlockedReworkTasks(IDEA_DIR);
    if (blocked.length > 0) {
      emit('blocked', 'task reached max rework count', { blocked_tasks: blocked, complexity });
      return;
    }
    const repairingTasks = getRepairingTasks(IDEA_DIR);
    if (repairingTasks.length > 0) {
      emit('repair:code', 'tasks are already being repaired', { in_progress_tasks: repairingTasks, complexity });
      return;
    }
    const reworkTasks = getReworkTasks(IDEA_DIR);
    if (reworkTasks.length > 0) {
      emit('repair:code', 'there are tasks that need rework', { next_tasks: reworkTasks, complexity });
      return;
    }
    const reviewTasks = getReviewBacklogTasks(IDEA_DIR);
    if (reviewTasks.length > 0) {
      emit('review:cr-light', 'tasks are ready or already in review (trivial)', { next_tasks: reviewTasks, complexity });
      return;
    }
    const codingTasks = getCodingTasks(IDEA_DIR);
    if (codingTasks.length > 0) {
      emit('implement:code', 'tasks are already being coded', { in_progress_tasks: codingTasks, complexity });
      return;
    }
    const codeTasks = getNextTasks(IDEA_DIR);
    if (codeTasks.length > 0) {
      emit('implement:code', 'there are confirmed tasks ready to code', { next_tasks: codeTasks, complexity });
      return;
    }
    if (allTasksApproved(IDEA_DIR)) {
      const traceGate = checkGate(IDEA_DIR, 'traceability-complete');
      if (!traceGate.pass && !traceGate.skipped) {
        emit('blocked', 'traceability incomplete', { complexity, trace_reason: traceGate.reason });
        return;
      }
      if (!checkGate(IDEA_DIR, 'done').pass) {
        emit('final:summary', 'all tasks approved, final summary is pending', { complexity });
        return;
      }
      emit('done', 'workflow is done', { in_worktree: isInWorktree(), complexity });
      return;
    }
    const state = readTaskState(taskStateFile(IDEA_DIR));
    emit('blocked', 'no executable next step found (trivial)', { task_count: Object.keys(state.tasks).length, complexity });
    return;
  }

  // === MODERATE PATH ===
  if (complexity === 'moderate') {
    if (!checkGate(IDEA_DIR, 'clarification-complete').pass) {
      emit('clarify:requirement', 'moderate clarification needed (4 dimensions: functional_scope, acceptance_criteria, compatibility_constraints, priority)', { complexity });
      return;
    }
    if (!checkGate(IDEA_DIR, 'to-be-exists').pass) {
      emit('plan:design', 'lightweight plan needed (moderate: no impact-risk-report)', { complexity });
      return;
    }
    if (!checkGate(IDEA_DIR, 'to-be-confirmed').pass) {
      emit('plan:confirm', 'plan confirmation is missing', { complexity });
      return;
    }
    if (!checkGate(IDEA_DIR, 'worktree-decided').pass) {
      emit('worktree:setup', 'worktree decision has not been made', { complexity });
      return;
    }
    if (!has('task-workflow-state.yaml')) {
      emit('tasks:init', 'task workflow state does not exist', { complexity });
      return;
    }
    const staleTasks = getStaleCodingTasks(IDEA_DIR);
    if (staleTasks.length > 0) {
      emit('implement:code', 'stale coding tasks detected', { stale_tasks: staleTasks.map(t => t.taskId), complexity });
      return;
    }
    const blocked = getBlockedReworkTasks(IDEA_DIR);
    if (blocked.length > 0) {
      emit('blocked', 'task reached max rework count', { blocked_tasks: blocked, complexity });
      return;
    }
    const repairingTasks = getRepairingTasks(IDEA_DIR);
    if (repairingTasks.length > 0) {
      emit('repair:code', 'tasks are already being repaired', { in_progress_tasks: repairingTasks, complexity });
      return;
    }
    const reworkTasks = getReworkTasks(IDEA_DIR);
    if (reworkTasks.length > 0) {
      emit('repair:code', 'there are tasks that need rework', { next_tasks: reworkTasks, complexity });
      return;
    }
    const reviewTasks = getReviewBacklogTasks(IDEA_DIR);
    if (reviewTasks.length > 0) {
      emit('review:cr-moderate', 'tasks are ready or already in review (moderate: spec+D3+D4+D5)', { next_tasks: reviewTasks, complexity });
      return;
    }
    const codingTasks = getCodingTasks(IDEA_DIR);
    if (codingTasks.length > 0) {
      emit('implement:code', 'tasks are already being coded', { in_progress_tasks: codingTasks, complexity });
      return;
    }
    const codeTasks = getNextTasks(IDEA_DIR);
    if (codeTasks.length > 0) {
      emit('implement:code', 'there are confirmed tasks ready to code', { next_tasks: codeTasks, complexity });
      return;
    }
    if (allTasksApproved(IDEA_DIR)) {
      const traceGate = checkGate(IDEA_DIR, 'traceability-complete');
      if (!traceGate.pass && !traceGate.skipped) {
        emit('blocked', 'traceability incomplete', { complexity, trace_reason: traceGate.reason });
        return;
      }
      if (!checkGate(IDEA_DIR, 'done').pass) {
        emit('final:summary', 'all tasks approved, final summary is pending', { complexity });
        return;
      }
      emit('done', 'workflow is done', { in_worktree: isInWorktree(), complexity });
      return;
    }
    const state = readTaskState(taskStateFile(IDEA_DIR));
    emit('blocked', 'no executable next step found (moderate)', { task_count: Object.keys(state.tasks).length, complexity });
    return;
  }

  // === STANDARD / COMPLEX PATH ===
  const asIsGate = checkGate(IDEA_DIR, 'as-is-complete');
  if (!asIsGate.pass) {
    emit('understand:explore', 'as-is documents are incomplete', { gate_reason: asIsGate.reason });
    return;
  }
  if (!checkGate(IDEA_DIR, 'as-is-confirmed').pass) {
    emit('understand:confirm', 'as-is structured confirmation is missing or invalid');
    return;
  }
  if (!checkGate(IDEA_DIR, 'clarification-complete').pass) {
    emit('clarify:requirement', 'requirement clarification is incomplete', { complexity });
    return;
  }
  if (!checkGate(IDEA_DIR, 'to-be-exists').pass) {
    emit('plan:design', 'implementation plan does not exist', { complexity });
    return;
  }
  if (!checkGate(IDEA_DIR, 'to-be-confirmed').pass) {
    emit('plan:confirm', 'plan confirmation is missing', { complexity });
    return;
  }
  // knowledge:extract is now a parallel side-branch, not blocking the main path.
  // It runs concurrently after plan:confirm and is checked before final:summary.
  if (!checkGate(IDEA_DIR, 'worktree-decided').pass) {
    emit('worktree:setup', 'worktree decision has not been made', { complexity });
    return;
  }
  if (!has('task-workflow-state.yaml')) {
    emit('tasks:init', 'task workflow state does not exist', { complexity });
    return;
  }

  const staleTasks = getStaleCodingTasks(IDEA_DIR);
  if (staleTasks.length > 0) {
    emit('implement:code', 'stale coding tasks detected — may need rollback', { stale_tasks: staleTasks.map(t => t.taskId), complexity });
    return;
  }

  const blocked = getBlockedReworkTasks(IDEA_DIR);
  if (blocked.length > 0) {
    emit('blocked', 'task reached max rework count', { blocked_tasks: blocked, complexity });
    return;
  }

  const repairingTasks = getRepairingTasks(IDEA_DIR);
  if (repairingTasks.length > 0) {
    const stallInfo = detectRepairStall(IDEA_DIR);
    const detail = { in_progress_tasks: repairingTasks, complexity };
    if (stallInfo.length > 0) {
      detail.stall_detected = true;
      detail.stall_suggestions = stallInfo.map(s => `${s.taskId}: ${s.suggestion}`);
    }
    emit('repair:code', 'tasks are already being repaired', detail);
    return;
  }

  const reworkTasks = getReworkTasks(IDEA_DIR);
  if (reworkTasks.length > 0) {
    emit('repair:code', 'there are tasks that need rework', { next_tasks: reworkTasks, complexity });
    return;
  }

  const reviewTasks = getReviewBacklogTasks(IDEA_DIR);
  if (reviewTasks.length > 0) {
    emit('review:cr', 'tasks are ready or already in requirement-level review', { next_tasks: reviewTasks, complexity });
    return;
  }

  const codingTasks = getCodingTasks(IDEA_DIR);
  if (codingTasks.length > 0) {
    emit('implement:code', 'tasks are already being coded', { in_progress_tasks: codingTasks, complexity });
    return;
  }

  const codeTasks = getNextTasks(IDEA_DIR);
  if (codeTasks.length > 0) {
    emit('implement:code', 'there are confirmed tasks ready to code', { next_tasks: codeTasks, complexity });
    return;
  }

  if (allTasksApproved(IDEA_DIR)) {
    const traceGate = checkGate(IDEA_DIR, 'traceability-complete');
    if (!traceGate.pass && !traceGate.skipped) {
      emit('blocked', 'traceability incomplete — not all requirements covered by approved tasks', { complexity, trace_reason: traceGate.reason });
      return;
    }
    // Knowledge extraction runs in parallel; sync here before final summary
    if (complexity !== 'trivial' && !checkGate(IDEA_DIR, 'knowledge-extracted').pass) {
      emit('knowledge:extract', 'all tasks approved but knowledge extraction not yet complete — must finish before final summary', { complexity });
      return;
    }
    if (!checkGate(IDEA_DIR, 'done').pass) {
      emit('final:summary', 'all tasks approved, final summary is pending', { complexity });
      return;
    }
    emit('done', 'workflow is done', { in_worktree: isInWorktree(), complexity });
    return;
  }

  const state = readTaskState(taskStateFile(IDEA_DIR));
  emit('blocked', 'no executable next step found', { task_count: Object.keys(state.tasks).length, complexity });
}

main();
