#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import {
  allTasksApproved,
  classifyChange,
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
  readWorkflowRevision
} from './workflow-lib.mjs';
import { checkGate } from './gate-check.mjs';
import { WORKFLOW_PATHS } from './workflow-definition.mjs';

function readPreviousStep(ideaDir) {
  const p = join(ideaDir, 'workflow-state.yaml');
  if (!existsSync(p)) return null;
  const text = readFileSync(p, 'utf8');
  const m = text.match(/^current_step:\s*(.+)$/m);
  return m ? m[1].trim() : null;
}

function buildResult(resumeStep, reason, ideaDir, phaseDetail = {}) {
  const assessment = ideaDir && ideaDir !== 'none' && existsSync(ideaDir)
    ? classifyChange(ideaDir)
    : { delivery_complexity: 'standard', risk_level: 'low', uncertainty_level: 'low', routing_complexity: 'standard', reasons: [] };
  const complexity = phaseDetail.complexity || assessment.routing_complexity;
  const currentStep = ideaDir && ideaDir !== 'none' && existsSync(ideaDir) ? readPreviousStep(ideaDir) : null;
  const revision = ideaDir && ideaDir !== 'none' && existsSync(ideaDir) ? readWorkflowRevision(ideaDir) : 0;
  const entries = Object.entries(phaseDetail).filter(([k, v]) => v !== undefined && v !== '' && k !== 'complexity');
  return {
    resume_step: resumeStep,
    reason,
    complexity,
    delivery_complexity: assessment.delivery_complexity,
    risk_level: assessment.risk_level,
    uncertainty_level: assessment.uncertainty_level,
    routing_reasons: assessment.reasons.length > 0 ? assessment.reasons : undefined,
    current_step: currentStep || 'none',
    state_revision: revision,
    transition_required: currentStep !== resumeStep,
    phase_detail: entries.length > 0 ? Object.fromEntries(entries) : undefined,
  };
}

function has(ideaDir, rel) {
  return existsSync(join(ideaDir, rel));
}

function ensureVerificationBeforeReview(ideaDir, reviewTasks, reviewStep, reason, phaseDetail = {}) {
  const state = readTaskState(taskStateFile(ideaDir));
  const unstartedReviewTasks = reviewTasks.filter(taskId => state.tasks[taskId]?.status === 'coded');
  if (unstartedReviewTasks.length > 0) {
    const gate = checkGate(ideaDir, 'implementation-verified');
    if (!gate.pass) {
      return buildResult('implement:code', 'post-coding verification is missing, failed, or stale', ideaDir, {
        ...phaseDetail,
        verification_reason: gate.reason,
        verification_tasks: unstartedReviewTasks,
      });
    }
  }
  return buildResult(reviewStep, reason, ideaDir, { ...phaseDetail, next_tasks: reviewTasks });
}

function ensureFinalAndMergeReview(ideaDir, complexity) {
  const summary = checkGate(ideaDir, 'final-summary-complete');
  if (!summary.pass) {
    return buildResult('final:summary', 'all tasks approved, final summary is pending or stale', ideaDir, { complexity, gate_reason: summary.reason });
  }
  const mergeReview = checkGate(ideaDir, 'merge-review-confirmed');
  if (!mergeReview.pass) {
    return buildResult('review:merge', 'current change report and explicit user approval are required before merge', ideaDir, { complexity, gate_reason: mergeReview.reason });
  }
  return buildResult('done', 'workflow is done and merge review is approved', ideaDir, { in_worktree: isInWorktree(), complexity });
}


function isInWorktree() {
  try {
    const gitDir = execSync('git rev-parse --git-dir', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const commonDir = execSync('git rev-parse --git-common-dir', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    return gitDir !== commonDir;
  } catch { return false; }
}

function computeDryRunPlan(ideaDir) {
  const assessment = (ideaDir && ideaDir !== 'none' && existsSync(ideaDir))
    ? classifyChange(ideaDir) : { routing_complexity: 'standard' };
  const complexity = assessment.routing_complexity;

  const steps = WORKFLOW_PATHS[complexity] || WORKFLOW_PATHS.standard;
  const currentStep = readPreviousStep(ideaDir);

  return {
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
}

export function computeStatus(ideaDir, { dryRun = false } = {}) {
  if (dryRun) return computeDryRunPlan(ideaDir);

  if (ideaDir === 'none' || !existsSync(ideaDir)) {
    return buildResult('receive-requirement', 'idea directory does not exist', ideaDir);
  }
  if (!checkGate(ideaDir, 'requirement-exists').pass) {
    return buildResult('receive-requirement', 'requirement.md does not exist', ideaDir);
  }

  const complexity = classifyChange(ideaDir).routing_complexity;

  // === HOTFIX QUICK PATH ===
  if (complexity === 'hotfix') {
    if (!has(ideaDir, 'task-workflow-state.yaml')) {
      return buildResult('quick-dev:init', 'auto-generating hotfix task (single-file, ≤5 lines)', ideaDir, { complexity });
    }
    const staleTasks = getStaleCodingTasks(ideaDir);
    if (staleTasks.length > 0) {
      return buildResult('implement:code', 'stale coding tasks detected', ideaDir, { stale_tasks: staleTasks.map(t => t.taskId), complexity });
    }
    const blocked = getBlockedReworkTasks(ideaDir);
    if (blocked.length > 0) {
      return buildResult('blocked', 'task reached max rework count', ideaDir, { blocked_tasks: blocked, complexity });
    }
    const repairingTasks = getRepairingTasks(ideaDir);
    if (repairingTasks.length > 0) {
      return buildResult('repair:code', 'tasks are already being repaired', ideaDir, { in_progress_tasks: repairingTasks, complexity });
    }
    const reworkTasks = getReworkTasks(ideaDir);
    if (reworkTasks.length > 0) {
      return buildResult('repair:code', 'there are tasks that need rework', ideaDir, { next_tasks: reworkTasks, complexity });
    }
    const reviewTasks = getReviewBacklogTasks(ideaDir);
    if (reviewTasks.length > 0) {
      return ensureVerificationBeforeReview(ideaDir, reviewTasks, 'review:cr-light', 'tasks are ready or already in review (hotfix: spec-only)', { complexity });
    }
    const codingTasks = getCodingTasks(ideaDir);
    if (codingTasks.length > 0) {
      return buildResult('implement:code', 'tasks are already being coded', ideaDir, { in_progress_tasks: codingTasks, complexity });
    }
    const codeTasks = getNextTasks(ideaDir);
    if (codeTasks.length > 0) {
      return buildResult('implement:code', 'there are confirmed tasks ready to code', ideaDir, { next_tasks: codeTasks, complexity });
    }
    if (allTasksApproved(ideaDir)) {
      return ensureFinalAndMergeReview(ideaDir, complexity);
    }
    const state = readTaskState(taskStateFile(ideaDir));
    return buildResult('blocked', 'no executable next step found (hotfix)', ideaDir, { task_count: Object.keys(state.tasks).length, complexity });
  }

  // === MINOR QUICK PATH ===
  if (complexity === 'minor') {
    if (!checkGate(ideaDir, 'clarification-complete').pass) {
      return buildResult('clarify:requirement', 'lightweight clarification needed (minor: functional_scope + acceptance_criteria)', ideaDir, { complexity });
    }
    if (!has(ideaDir, 'task-workflow-state.yaml')) {
      return buildResult('quick-dev:init', 'auto-generating task from requirement-clarification (minor quick-dev)', ideaDir, { complexity });
    }
    const staleTasks = getStaleCodingTasks(ideaDir);
    if (staleTasks.length > 0) {
      return buildResult('implement:code', 'stale coding tasks detected', ideaDir, { stale_tasks: staleTasks.map(t => t.taskId), complexity });
    }
    const blocked = getBlockedReworkTasks(ideaDir);
    if (blocked.length > 0) {
      return buildResult('blocked', 'task reached max rework count', ideaDir, { blocked_tasks: blocked, complexity });
    }
    const repairingTasks = getRepairingTasks(ideaDir);
    if (repairingTasks.length > 0) {
      return buildResult('repair:code', 'tasks are already being repaired', ideaDir, { in_progress_tasks: repairingTasks, complexity });
    }
    const reworkTasks = getReworkTasks(ideaDir);
    if (reworkTasks.length > 0) {
      return buildResult('repair:code', 'there are tasks that need rework', ideaDir, { next_tasks: reworkTasks, complexity });
    }
    const reviewTasks = getReviewBacklogTasks(ideaDir);
    if (reviewTasks.length > 0) {
      return ensureVerificationBeforeReview(ideaDir, reviewTasks, 'review:cr-light', 'tasks are ready or already in review (minor: spec + light)', { complexity });
    }
    const codingTasks = getCodingTasks(ideaDir);
    if (codingTasks.length > 0) {
      return buildResult('implement:code', 'tasks are already being coded', ideaDir, { in_progress_tasks: codingTasks, complexity });
    }
    const codeTasks = getNextTasks(ideaDir);
    if (codeTasks.length > 0) {
      return buildResult('implement:code', 'there are confirmed tasks ready to code', ideaDir, { next_tasks: codeTasks, complexity });
    }
    if (allTasksApproved(ideaDir)) {
      return ensureFinalAndMergeReview(ideaDir, complexity);
    }
    const state = readTaskState(taskStateFile(ideaDir));
    return buildResult('blocked', 'no executable next step found (minor)', ideaDir, { task_count: Object.keys(state.tasks).length, complexity });
  }

  // === TRIVIAL QUICK-DEV PATH ===
  if (complexity === 'trivial') {
    if (!checkGate(ideaDir, 'clarification-complete').pass) {
      return buildResult('clarify:requirement', 'lightweight clarification needed (trivial: only functional_scope + acceptance_criteria)', ideaDir, { complexity });
    }
    if (!has(ideaDir, 'task-workflow-state.yaml')) {
      return buildResult('quick-dev:init', 'auto-generating task from requirement-clarification (trivial quick-dev)', ideaDir, { complexity });
    }
    const staleTasks = getStaleCodingTasks(ideaDir);
    if (staleTasks.length > 0) {
      return buildResult('implement:code', 'stale coding tasks detected', ideaDir, { stale_tasks: staleTasks.map(t => t.taskId), complexity });
    }
    const blocked = getBlockedReworkTasks(ideaDir);
    if (blocked.length > 0) {
      return buildResult('blocked', 'task reached max rework count', ideaDir, { blocked_tasks: blocked, complexity });
    }
    const repairingTasks = getRepairingTasks(ideaDir);
    if (repairingTasks.length > 0) {
      return buildResult('repair:code', 'tasks are already being repaired', ideaDir, { in_progress_tasks: repairingTasks, complexity });
    }
    const reworkTasks = getReworkTasks(ideaDir);
    if (reworkTasks.length > 0) {
      return buildResult('repair:code', 'there are tasks that need rework', ideaDir, { next_tasks: reworkTasks, complexity });
    }
    const reviewTasks = getReviewBacklogTasks(ideaDir);
    if (reviewTasks.length > 0) {
      return ensureVerificationBeforeReview(ideaDir, reviewTasks, 'review:cr-light', 'tasks are ready or already in review (trivial)', { complexity });
    }
    const codingTasks = getCodingTasks(ideaDir);
    if (codingTasks.length > 0) {
      return buildResult('implement:code', 'tasks are already being coded', ideaDir, { in_progress_tasks: codingTasks, complexity });
    }
    const codeTasks = getNextTasks(ideaDir);
    if (codeTasks.length > 0) {
      return buildResult('implement:code', 'there are confirmed tasks ready to code', ideaDir, { next_tasks: codeTasks, complexity });
    }
    if (allTasksApproved(ideaDir)) {
      const traceGate = checkGate(ideaDir, 'traceability-complete');
      if (!traceGate.pass && !traceGate.skipped) {
        return buildResult('blocked', 'traceability incomplete', ideaDir, { complexity, trace_reason: traceGate.reason });
      }
      return ensureFinalAndMergeReview(ideaDir, complexity);
    }
    const state = readTaskState(taskStateFile(ideaDir));
    return buildResult('blocked', 'no executable next step found (trivial)', ideaDir, { task_count: Object.keys(state.tasks).length, complexity });
  }

  // === MODERATE PATH ===
  if (complexity === 'moderate') {
    if (!checkGate(ideaDir, 'clarification-complete').pass) {
      return buildResult('clarify:requirement', 'moderate clarification needed (4 dimensions: functional_scope, acceptance_criteria, compatibility_constraints, priority)', ideaDir, { complexity });
    }
    if (!checkGate(ideaDir, 'to-be-exists').pass) {
      return buildResult('plan:design', 'lightweight plan needed (moderate: no impact-risk-report)', ideaDir, { complexity });
    }
    if (!checkGate(ideaDir, 'to-be-confirmed').pass) {
      return buildResult('plan:confirm', 'plan confirmation is missing', ideaDir, { complexity });
    }
    if (!checkGate(ideaDir, 'worktree-decided').pass) {
      return buildResult('worktree:setup', 'worktree decision has not been made', ideaDir, { complexity });
    }
    if (!has(ideaDir, 'task-workflow-state.yaml')) {
      return buildResult('tasks:init', 'task workflow state does not exist', ideaDir, { complexity });
    }
    const staleTasks = getStaleCodingTasks(ideaDir);
    if (staleTasks.length > 0) {
      return buildResult('implement:code', 'stale coding tasks detected', ideaDir, { stale_tasks: staleTasks.map(t => t.taskId), complexity });
    }
    const blocked = getBlockedReworkTasks(ideaDir);
    if (blocked.length > 0) {
      return buildResult('blocked', 'task reached max rework count', ideaDir, { blocked_tasks: blocked, complexity });
    }
    const repairingTasks = getRepairingTasks(ideaDir);
    if (repairingTasks.length > 0) {
      return buildResult('repair:code', 'tasks are already being repaired', ideaDir, { in_progress_tasks: repairingTasks, complexity });
    }
    const reworkTasks = getReworkTasks(ideaDir);
    if (reworkTasks.length > 0) {
      return buildResult('repair:code', 'there are tasks that need rework', ideaDir, { next_tasks: reworkTasks, complexity });
    }
    const reviewTasks = getReviewBacklogTasks(ideaDir);
    if (reviewTasks.length > 0) {
      return ensureVerificationBeforeReview(ideaDir, reviewTasks, 'review:cr-moderate', 'tasks are ready or already in review (moderate: spec+D3+D4+D5)', { complexity });
    }
    const codingTasks = getCodingTasks(ideaDir);
    if (codingTasks.length > 0) {
      return buildResult('implement:code', 'tasks are already being coded', ideaDir, { in_progress_tasks: codingTasks, complexity });
    }
    const codeTasks = getNextTasks(ideaDir);
    if (codeTasks.length > 0) {
      return buildResult('implement:code', 'there are confirmed tasks ready to code', ideaDir, { next_tasks: codeTasks, complexity });
    }
    if (allTasksApproved(ideaDir)) {
      const traceGate = checkGate(ideaDir, 'traceability-complete');
      if (!traceGate.pass && !traceGate.skipped) {
        return buildResult('blocked', 'traceability incomplete', ideaDir, { complexity, trace_reason: traceGate.reason });
      }
      return ensureFinalAndMergeReview(ideaDir, complexity);
    }
    const state = readTaskState(taskStateFile(ideaDir));
    return buildResult('blocked', 'no executable next step found (moderate)', ideaDir, { task_count: Object.keys(state.tasks).length, complexity });
  }

  // === STANDARD / COMPLEX PATH ===
  const asIsGate = checkGate(ideaDir, 'as-is-complete');
  if (!asIsGate.pass) {
    return buildResult('understand:explore', 'as-is documents are incomplete', ideaDir, { gate_reason: asIsGate.reason });
  }
  if (!checkGate(ideaDir, 'as-is-confirmed').pass) {
    return buildResult('understand:confirm', 'as-is structured confirmation is missing or invalid', ideaDir);
  }
  if (!checkGate(ideaDir, 'clarification-complete').pass) {
    return buildResult('clarify:requirement', 'requirement clarification is incomplete', ideaDir, { complexity });
  }
  if (!checkGate(ideaDir, 'to-be-exists').pass) {
    return buildResult('plan:design', 'implementation plan does not exist', ideaDir, { complexity });
  }
  if (!checkGate(ideaDir, 'to-be-confirmed').pass) {
    return buildResult('plan:confirm', 'plan confirmation is missing', ideaDir, { complexity });
  }
  if (!checkGate(ideaDir, 'worktree-decided').pass) {
    return buildResult('worktree:setup', 'worktree decision has not been made', ideaDir, { complexity });
  }
  if (!has(ideaDir, 'task-workflow-state.yaml')) {
    return buildResult('tasks:init', 'task workflow state does not exist', ideaDir, { complexity });
  }

  const staleTasks = getStaleCodingTasks(ideaDir);
  if (staleTasks.length > 0) {
    return buildResult('implement:code', 'stale coding tasks detected — may need rollback', ideaDir, { stale_tasks: staleTasks.map(t => t.taskId), complexity });
  }

  const blocked = getBlockedReworkTasks(ideaDir);
  if (blocked.length > 0) {
    return buildResult('blocked', 'task reached max rework count', ideaDir, { blocked_tasks: blocked, complexity });
  }

  const repairingTasks = getRepairingTasks(ideaDir);
  if (repairingTasks.length > 0) {
    const stallInfo = detectRepairStall(ideaDir);
    const detail = { in_progress_tasks: repairingTasks, complexity };
    if (stallInfo.length > 0) {
      detail.stall_detected = true;
      detail.stall_suggestions = stallInfo.map(s => `${s.taskId}: ${s.suggestion}`);
    }
    return buildResult('repair:code', 'tasks are already being repaired', ideaDir, detail);
  }

  const reworkTasks = getReworkTasks(ideaDir);
  if (reworkTasks.length > 0) {
    return buildResult('repair:code', 'there are tasks that need rework', ideaDir, { next_tasks: reworkTasks, complexity });
  }

  const reviewTasks = getReviewBacklogTasks(ideaDir);
  if (reviewTasks.length > 0) {
    return ensureVerificationBeforeReview(ideaDir, reviewTasks, 'review:cr', 'tasks are ready or already in requirement-level review', { complexity });
  }

  const codingTasks = getCodingTasks(ideaDir);
  if (codingTasks.length > 0) {
    return buildResult('implement:code', 'tasks are already being coded', ideaDir, { in_progress_tasks: codingTasks, complexity });
  }

  const codeTasks = getNextTasks(ideaDir);
  if (codeTasks.length > 0) {
    return buildResult('implement:code', 'there are confirmed tasks ready to code', ideaDir, { next_tasks: codeTasks, complexity });
  }

  if (allTasksApproved(ideaDir)) {
    const state = readTaskState(taskStateFile(ideaDir));
    const taskCount = Object.keys(state.tasks).length;
    if (taskCount > 1 && (complexity === 'standard' || complexity === 'complex')) {
      const integrationGate = checkGate(ideaDir, 'integration-cr-complete');
      if (!integrationGate.pass) {
        return buildResult('review:integration', 'integration review is missing, incomplete, or did not pass', ideaDir, { complexity, task_count: taskCount, integration_reason: integrationGate.reason });
      }
    }

    const traceGate = checkGate(ideaDir, 'traceability-complete');
    if (!traceGate.pass && !traceGate.skipped) {
      return buildResult('blocked', 'traceability incomplete — not all requirements covered by approved tasks', ideaDir, { complexity, trace_reason: traceGate.reason });
    }
    return ensureFinalAndMergeReview(ideaDir, complexity);
  }

  const state = readTaskState(taskStateFile(ideaDir));
  return buildResult('blocked', 'no executable next step found', ideaDir, { task_count: Object.keys(state.tasks).length, complexity });
}

function formatOutput(result, compact) {
  console.log(`resume_step: ${result.resume_step}`);
  console.log(`reason: ${JSON.stringify(result.reason)}`);
  console.log(`complexity: ${result.complexity}`);
  console.log(`delivery_complexity: ${result.delivery_complexity}`);
  console.log(`risk_level: ${result.risk_level}`);
  console.log(`uncertainty_level: ${result.uncertainty_level}`);
  if (result.routing_reasons) console.log(`routing_reasons: ${JSON.stringify(result.routing_reasons)}`);
  console.log(`current_step: ${result.current_step}`);
  console.log(`state_revision: ${result.state_revision}`);
  console.log(`transition_required: ${result.transition_required}`);
  if (result.phase_detail) {
    const entries = Object.entries(result.phase_detail);
    if (entries.length > 0) {
      if (compact) {
        console.log(`phase_detail: ${entries.map(([k, v]) => `${k}=${Array.isArray(v) ? v.join(',') : v}`).join('|')}`);
      } else {
        console.log('phase_detail:');
        for (const [key, value] of entries) console.log(`  ${key}: ${Array.isArray(value) ? value.join(',') : value}`);
      }
    }
  }
}

function main() {
  const ideaDir = process.argv[2];
  const compact = process.argv.includes('--compact');
  const dryRun = process.argv.includes('--dry-run');

  if (!ideaDir) {
    process.stderr.write('用法: node orchestration-status.mjs <idea-dir|none> [--compact] [--dry-run]\n');
    process.exit(1);
  }

  if (dryRun) {
    const plan = computeStatus(ideaDir, { dryRun: true });
    console.log(JSON.stringify(plan, null, 2));
    return;
  }

  const result = computeStatus(ideaDir);
  formatOutput(result, compact);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
