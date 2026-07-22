#!/usr/bin/env node
// Stop hook: checks if the current workflow step's postcondition gate is met.
// If not, injects corrective context for the next turn.
// Silent exit (no output) when no active workflow or gate passes.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkGate } from '../scripts/gate-check.mjs';

const STEP_GATE_MAP = {
  'receive-requirement': 'requirement-exists',
  'understand:explore': 'as-is-complete',
  'understand:confirm': 'as-is-confirmed',
  'clarify:requirement': 'clarification-complete',
  'plan:design': 'to-be-exists',
  'plan:confirm': 'to-be-confirmed',
  'worktree:setup': 'worktree-decided',
  'tasks:init': 'task-workflow-exists',
  'quick-dev:init': 'task-workflow-exists',
  'implement:code': 'task-report-exists',
  'repair:code': 'task-report-exists',
  'review:cr': 'cr-complete',
  'review:cr-light': 'cr-complete',
  'knowledge:extract': 'knowledge-extracted',
  'final:summary': 'done'
};

function findActiveWorkflow(chiselDir) {
  if (!existsSync(chiselDir)) return null;

  let entries;
  try {
    entries = readdirSync(chiselDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'wiki' && e.name !== 'wiki-candidates');
  } catch {
    return null;
  }

  for (const entry of entries) {
    const ideaDir = join(chiselDir, entry.name);
    if (existsSync(join(ideaDir, '.done'))) continue;
    const wsFile = join(ideaDir, 'workflow-state.yaml');
    if (!existsSync(wsFile)) continue;
    const text = readFileSync(wsFile, 'utf8');
    const step = text.match(/^current_step:\s*(.+)$/m)?.[1]?.trim();
    if (step) return { ideaDir, step };
  }

  return null;
}

function main() {
  const cwd = process.cwd();
  const chiselDir = join(cwd, '.chisel');

  const active = findActiveWorkflow(chiselDir);
  if (!active) return;

  const gateId = STEP_GATE_MAP[active.step];
  if (!gateId) return;

  const result = checkGate(active.ideaDir, gateId);
  if (result.pass) return;

  const output = {
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: `[chisel gate-guard] 当前步骤 "${active.step}" 的 postcondition gate "${gateId}" 未通过: ${result.reason}. 请继续完成当前步骤的产物要求，不要跳步。`
    }
  };
  console.log(JSON.stringify(output));
}

main();
