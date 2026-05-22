#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  allTasksApproved,
  getBlockedReworkTasks,
  getCodedTasksNeedingReview,
  getNextTasks,
  getReworkTasks,
  getStaleCodingTasks,
  readTaskState,
  taskStateFile,
  updateWorkflowPhase
} from './workflow-lib.mjs';
import { checkGate } from './gate-check.mjs';

const IDEA_DIR = process.argv[2];

if (!IDEA_DIR) {
  process.stderr.write('用法: node orchestration-status.mjs <idea-dir|none>\n');
  process.exit(1);
}

function emit(resumeStep, reason, phaseDetail = {}) {
  const complexity = phaseDetail.complexity || (IDEA_DIR && IDEA_DIR !== 'none' && existsSync(IDEA_DIR) ? detectComplexity(IDEA_DIR) : 'standard');
  console.log(`resume_step: ${resumeStep}`);
  console.log(`reason: ${JSON.stringify(reason)}`);
  console.log(`complexity: ${complexity}`);
  const entries = Object.entries(phaseDetail).filter(([k, v]) => v !== undefined && v !== '' && k !== 'complexity');
  if (entries.length > 0) {
    console.log('phase_detail:');
    for (const [key, value] of entries) console.log(`  ${key}: ${Array.isArray(value) ? value.join(',') : value}`);
  }
  if (IDEA_DIR && IDEA_DIR !== 'none' && existsSync(IDEA_DIR)) {
    updateWorkflowPhase(IDEA_DIR, resumeStep);
    // Silently regenerate dashboard so the browser auto-refresh picks up new state
    try {
      const __dirname = dirname(fileURLToPath(import.meta.url));
      execSync(`node "${join(__dirname, 'dashboard.mjs')}" "${IDEA_DIR}" --no-open`, { stdio: 'ignore', timeout: 5000 });
    } catch { /* non-critical */ }
  }
}

function has(rel) {
  return existsSync(join(IDEA_DIR, rel));
}

function detectComplexity(ideaDir) {
  const reqPath = join(ideaDir, 'requirement.md');
  if (!existsSync(reqPath)) return 'standard';
  const text = readFileSync(reqPath, 'utf8');
  const explicitMatch = text.match(/^##\s*复杂度[：:]\s*(trivial|standard|complex)\s*$/m);
  if (explicitMatch) return explicitMatch[1];
  const scopeSection = text.split('## 涉及范围')[1]?.split('##')[0] || '';
  const scopeItems = scopeSection.split('\n').filter(l => /^-\s+\S/.test(l)).length;
  const hasNewTable = /新增.*表|新.*table|create.*table|DDL/i.test(text);
  const hasNewApi = /新增.*接口|new.*api|新.*endpoint/i.test(text);
  if (scopeItems <= 2 && !hasNewTable && !hasNewApi) return 'trivial';
  if (scopeItems > 5) return 'complex';
  return 'standard';
}

function isInWorktree() {
  try {
    const gitDir = execSync('git rev-parse --git-dir', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    const commonDir = execSync('git rev-parse --git-common-dir', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
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

  const complexity = detectComplexity(IDEA_DIR);

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
    const reworkTasks = getReworkTasks(IDEA_DIR);
    if (reworkTasks.length > 0) {
      emit('repair:code', 'there are tasks that need rework', { next_tasks: reworkTasks, complexity });
      return;
    }
    const codeTasks = getNextTasks(IDEA_DIR);
    if (codeTasks.length > 0) {
      emit('implement:code', 'there are confirmed tasks ready to code', { next_tasks: codeTasks, complexity });
      return;
    }
    const reviewTasks = getCodedTasksNeedingReview(IDEA_DIR);
    if (reviewTasks.length > 0) {
      emit('review:cr-light', 'all tasks coded, spec-only review (trivial)', { next_tasks: reviewTasks, complexity });
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
    }
    if (checkGate(IDEA_DIR, 'done').pass) {
      emit('done', 'workflow is done', { in_worktree: isInWorktree(), complexity });
      return;
    }
    const state = readTaskState(taskStateFile(IDEA_DIR));
    emit('blocked', 'no executable next step found (trivial)', { task_count: Object.keys(state.tasks).length, complexity });
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
  if (complexity !== 'trivial' && !checkGate(IDEA_DIR, 'ai-input-ready').pass) {
    emit('understand:generate-ai-input', 'ai-input documents have not been generated from confirmed as-is', { complexity });
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

  const reworkTasks = getReworkTasks(IDEA_DIR);
  if (reworkTasks.length > 0) {
    emit('repair:code', 'there are tasks that need rework', { next_tasks: reworkTasks, complexity });
    return;
  }

  const codeTasks = getNextTasks(IDEA_DIR);
  if (codeTasks.length > 0) {
    emit('implement:code', 'there are confirmed tasks ready to code', { next_tasks: codeTasks, complexity });
    return;
  }

  const reviewTasks = getCodedTasksNeedingReview(IDEA_DIR);
  if (reviewTasks.length > 0) {
    emit('review:cr', 'all tasks coded, requirement-level review is ready', { next_tasks: reviewTasks, complexity });
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
  }

  if (checkGate(IDEA_DIR, 'done').pass) {
    emit('done', 'workflow is done', { in_worktree: isInWorktree(), complexity });
    return;
  }

  const state = readTaskState(taskStateFile(IDEA_DIR));
  emit('blocked', 'no executable next step found', { task_count: Object.keys(state.tasks).length, complexity });
}

main();
