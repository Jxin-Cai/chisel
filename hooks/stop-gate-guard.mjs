#!/usr/bin/env node
// Deterministic Stop hook. Automated workflow steps block one stop attempt when
// their gate is incomplete; human-decision steps are always allowed to yield.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkGate } from '../scripts/gate-check.mjs';
import { getStaleCodingTasks, readTaskState, STEP_GATE_MAP, taskStateFile } from '../scripts/workflow-lib.mjs';
import { changedFilesForProject } from '../scripts/task-provenance.mjs';
import { controlRoot } from '../scripts/control-plane.mjs';

const HUMAN_WAIT_STEPS = new Set(['understand:confirm', 'clarify:requirement', 'plan:confirm', 'worktree:setup', 'test:unit', 'review:cr-report', 'final:summary', 'review:merge', 'blocked']);

function readInput() {
  try {
    const text = readFileSync(0, 'utf8').trim();
    return text ? JSON.parse(text) : {};
  } catch { return {}; }
}

export function findActiveWorkflows(chiselDir) {
  if (!existsSync(chiselDir)) return [];
  let entries;
  try {
    entries = readdirSync(chiselDir, { withFileTypes: true })
      .filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'wiki' && entry.name !== 'wiki-candidates')
      .sort((left, right) => left.name.localeCompare(right.name));
  } catch { return []; }
  return entries.flatMap(entry => {
    const ideaDir = join(chiselDir, entry.name);
    if (existsSync(join(ideaDir, '.done'))) return [];
    const stateFile = join(ideaDir, 'workflow-state.yaml');
    if (!existsSync(stateFile)) return [];
    try {
      const text = readFileSync(stateFile, 'utf8');
      const step = text.match(/^current_step:\s*(.+)$/m)?.[1]?.trim();
      const idea = text.match(/^idea:\s*(.+)$/m)?.[1]?.trim() || entry.name;
      return step ? [{ ideaDir, idea, step }] : [];
    } catch { return []; }
  });
}

function emptyCodingTaskReason(workflow, projectRoot) {
  if (!['implement:code', 'repair:code'].includes(workflow.step)) return '';
  const file = taskStateFile(workflow.ideaDir);
  if (!existsSync(file)) return '';
  let state;
  try { state = readTaskState(file); } catch { return 'task state cannot be read'; }
  const active = Object.entries(state.tasks || {}).filter(([, task]) => ['coding', 'repairing'].includes(task.status));
  for (const [taskId] of active) {
    const changed = changedFilesForProject(workflow.ideaDir, taskId, projectRoot);
    if (changed !== null && changed.length === 0) return `${taskId} has no changes after its execution baseline`;
  }
  return '';
}

function liveCodingTasks(workflow) {
  if (!['implement:code', 'repair:code'].includes(workflow.step)) return [];
  const file = taskStateFile(workflow.ideaDir);
  if (!existsSync(file)) return [];
  try {
    const state = readTaskState(file);
    const stale = new Set(getStaleCodingTasks(workflow.ideaDir).map(task => task.taskId));
    return Object.entries(state.tasks || {})
      .filter(([taskId, task]) => ['coding', 'repairing'].includes(task.status) && !stale.has(taskId))
      .map(([taskId]) => taskId);
  } catch {
    return [];
  }
}

function liveCodingBlocker(workflow, taskIds) {
  return `${workflow.idea}: ${taskIds.join(', ')} still have live coding leases; do not yield or only say that you are waiting. Join every background Agent with TaskOutput(task_id, block: true), then merge/finish its result and continue the workflow`;
}

function pendingAdversarialReviewBlocker(workflow) {
  if (workflow.step !== 'plan:adversarial-review') return '';
  try {
    if (checkGate(workflow.ideaDir, 'to-be-adversarial-approved').pass) return '';
  } catch {
    // Gate errors still mean that the automated review step is unfinished.
  }
  return `${workflow.idea}: fresh adversarial reviewer result has not been collected; do not yield or only say that you are waiting. Join the background reviewer with TaskOutput(task_id, block: true), persist its actual findings to adversarial-review.json/.md, validate the gate, and continue the workflow`;
}

export function evaluateStop(chiselDir, { projectRoot = '.', stopHookActive = false } = {}) {
  const workflows = findActiveWorkflows(chiselDir);
  // Claude sets this on the retry caused by a blocking Stop hook. Normally the
  // retry is allowed through to avoid an infinite loop. Live coding Agents and
  // a pending fresh adversarial reviewer are different: background work is
  // still owned by this turn, so yielding would orphan its result. Keep the
  // orchestrator alive until it joins the Agent. Expired coding leases are
  // deliberately excluded so crashed coding work cannot trap the session.
  if (stopHookActive) {
    const liveBlockers = workflows.flatMap(workflow => {
      const taskIds = liveCodingTasks(workflow);
      if (taskIds.length > 0) return [liveCodingBlocker(workflow, taskIds)];
      const reviewerBlocker = pendingAdversarialReviewBlocker(workflow);
      return reviewerBlocker ? [reviewerBlocker] : [];
    });
    return { blockers: liveBlockers, recursive_retry: true };
  }
  const blockers = [];
  for (const workflow of workflows) {
    if (HUMAN_WAIT_STEPS.has(workflow.step) || workflow.step === 'done') continue;
    const liveTasks = liveCodingTasks(workflow);
    if (liveTasks.length > 0) {
      blockers.push(liveCodingBlocker(workflow, liveTasks));
      continue;
    }
    const reviewerBlocker = pendingAdversarialReviewBlocker(workflow);
    if (reviewerBlocker) {
      blockers.push(reviewerBlocker);
      continue;
    }
    const gateId = STEP_GATE_MAP[workflow.step];
    if (!gateId) {
      blockers.push(`${workflow.idea}: automated step "${workflow.step}" has no canonical gate mapping`);
      continue;
    }
    try {
      const gate = checkGate(workflow.ideaDir, gateId);
      const emptyReason = gate.pass ? emptyCodingTaskReason(workflow, projectRoot) : '';
      if (!gate.pass) blockers.push(`${workflow.idea}: step "${workflow.step}" gate "${gateId}" failed: ${gate.reason}`);
      else if (emptyReason) blockers.push(`${workflow.idea}: ${emptyReason}`);
      else blockers.push(`${workflow.idea}: gate "${gateId}" passed; run phase-artifacts.mjs for "${workflow.step}", publish its Markdown links, then run authoritative status + explicit transition before stopping`);
    } catch (error) {
      blockers.push(`${workflow.idea}: gate evaluation error for "${gateId}": ${error.message}`);
    }
  }
  return { blockers, recursive_retry: false };
}

function main() {
  const input = readInput();
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const evaluation = evaluateStop(controlRoot(cwd), { projectRoot: cwd, stopHookActive: input.stop_hook_active === true });
  if (evaluation.blockers.length === 0) return;
  const reason = `[chisel stop-gate] ${evaluation.blockers.join(' | ')}. Continue the automated workflow; yield only when a human decision or external authority is required.`;
  console.log(JSON.stringify({ decision: 'block', reason, systemMessage: reason }));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
