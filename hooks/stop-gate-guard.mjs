#!/usr/bin/env node
// Stop hook: checks if the current workflow step's postcondition gate is met.
// If not, injects corrective context for the next turn.
// Silent exit (no output) when no active workflow or gate passes.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
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
  'review:cr-moderate': 'cr-complete',
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
  if (result.pass) {
    // Empty-diff guard: block stop if implement/repair step has no actual code changes
    if (['implement:code', 'repair:code'].includes(active.step)) {
      try {
        const diffStat = execSync('git diff --stat HEAD', { encoding: 'utf8', timeout: 5000 }).trim();
        const untracked = execSync('git ls-files --others --exclude-standard', { encoding: 'utf8', timeout: 5000 }).trim();
        if (!diffStat && !untracked) {
          const stateFile = join(active.ideaDir, 'task-workflow-state.yaml');
          if (existsSync(stateFile)) {
            const stateText = readFileSync(stateFile, 'utf8');
            const hasCodingTask = /status:\s*(coding|repairing)/m.test(stateText);
            if (hasCodingTask) {
              const reqPath = join(active.ideaDir, 'requirement.md');
              const isRemoval = existsSync(reqPath) && /task_type:\s*removal/i.test(readFileSync(reqPath, 'utf8'));
              if (!isRemoval) {
                const guard = {
                  hookSpecificOutput: {
                    hookEventName: 'Stop',
                    additionalContext: `[chisel empty-diff-guard] 当前步骤 "${active.step}" 检测到 git diff 为空（无实际代码变更），但仍有 coding/repairing 状态的 task。请继续编码实现，确保有实际代码产出后再完成。如果本 task 确实无需代码修改（如纯删除），请在 requirement.md 中标记 "task_type: removal"。`
                  }
                };
                console.log(JSON.stringify(guard));
                return;
              }
            }
          }
        }
      } catch { /* git command failure is non-critical, allow stop */ }
    }
    return;
  }

  const output = {
    hookSpecificOutput: {
      hookEventName: 'Stop',
      additionalContext: `[chisel gate-guard] 当前步骤 "${active.step}" 的 postcondition gate "${gateId}" 未通过: ${result.reason}. 请继续完成当前步骤的产物要求，不要跳步。`
    }
  };
  console.log(JSON.stringify(output));
}

main();
