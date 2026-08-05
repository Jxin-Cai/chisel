#!/usr/bin/env node
// Deterministic Stop hook. Automated workflow steps block one stop attempt when
// their gate is incomplete; human-decision steps are always allowed to yield.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkGate } from '../scripts/gate-check.mjs';
import { readTaskState, STEP_GATE_MAP, taskStateFile } from '../scripts/workflow-lib.mjs';
import { changedFilesForProject } from '../scripts/task-provenance.mjs';

const HUMAN_WAIT_STEPS = new Set(['understand:confirm', 'clarify:requirement', 'plan:confirm', 'worktree:setup', 'blocked']);

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

export function evaluateStop(chiselDir, { projectRoot = '.', stopHookActive = false } = {}) {
  // Claude sets this on the retry caused by a blocking Stop hook. Never create
  // an infinite loop; the next regular turn/session will enforce the gate again.
  if (stopHookActive) return { blockers: [], recursive_retry: true };
  const blockers = [];
  for (const workflow of findActiveWorkflows(chiselDir)) {
    if (HUMAN_WAIT_STEPS.has(workflow.step) || workflow.step === 'done') continue;
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
      else blockers.push(`${workflow.idea}: gate "${gateId}" passed; run authoritative status + explicit transition before stopping`);
    } catch (error) {
      blockers.push(`${workflow.idea}: gate evaluation error for "${gateId}": ${error.message}`);
    }
  }
  return { blockers, recursive_retry: false };
}

function main() {
  const input = readInput();
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  const evaluation = evaluateStop(join(cwd, '.chisel'), { projectRoot: cwd, stopHookActive: input.stop_hook_active === true });
  if (evaluation.blockers.length === 0) return;
  const reason = `[chisel stop-gate] ${evaluation.blockers.join(' | ')}. Continue the automated workflow; yield only when a human decision or external authority is required.`;
  console.log(JSON.stringify({ decision: 'block', reason, systemMessage: reason }));
}

if (import.meta.url === `file://${process.argv[1]}`) main();
