#!/usr/bin/env node
// Enhanced SessionStart hook: injects workflow state and iron-rules digest.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function readWorkflowState(ideaDir) {
  const wsFile = join(ideaDir, 'workflow-state.yaml');
  if (!existsSync(wsFile)) return null;
  const text = readFileSync(wsFile, 'utf8');
  const step = text.match(/^current_step:\s*(.+)$/m)?.[1]?.trim() || 'unknown';
  const idea = text.match(/^idea:\s*(.+)$/m)?.[1]?.trim() || 'unknown';
  return { idea, step };
}

function readTaskSummary(ideaDir) {
  const tsFile = join(ideaDir, 'task-workflow-state.yaml');
  if (!existsSync(tsFile)) return null;
  const text = readFileSync(tsFile, 'utf8');
  const counts = {};
  for (const m of text.matchAll(/^\s{4}status:\s*(.+)$/gm)) {
    const s = m[1].trim();
    counts[s] = (counts[s] || 0) + 1;
  }
  return counts;
}

function isDone(ideaDir) {
  return existsSync(join(ideaDir, '.done'));
}

function main() {
  const cwd = process.cwd();
  const chiselDir = join(cwd, '.chisel');

  console.log('chisel plugin is available.');
  console.log('Use /chisel <需求描述或需求文件路径> for legacy system feature enhancement.');

  if (!existsSync(chiselDir)) {
    console.log('Runtime artifacts are stored under .chisel/<idea-name>/ in the target project.');
    return;
  }

  let entries;
  try {
    entries = readdirSync(chiselDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'wiki' && e.name !== 'wiki-candidates');
  } catch {
    return;
  }

  const workflows = [];
  for (const entry of entries) {
    const ideaDir = join(chiselDir, entry.name);
    if (isDone(ideaDir)) continue;
    const ws = readWorkflowState(ideaDir);
    if (!ws) continue;
    const tasks = readTaskSummary(ideaDir);
    workflows.push({ ...ws, tasks });
  }

  if (workflows.length > 0) {
    console.log('');
    console.log('Active workflows:');
    for (const w of workflows) {
      const taskLine = w.tasks
        ? Object.entries(w.tasks).map(([s, c]) => `${s}=${c}`).join(', ')
        : 'tasks not initialized';
      console.log(`  - ${w.idea}: step=${w.step} | ${taskLine}`);
    }
    console.log('');
    console.log('IRON RULES REMINDER:');
    console.log('  1. orchestration-status.mjs output = only source of truth for resume point');
    console.log('  2. Never skip steps (each step has prerequisites)');
    console.log('  3. User confirmation required before writing confirmation files');
    console.log('  4. Must call orchestration-status.mjs every turn');
    console.log('  5. Must run gate-check.mjs after each deliverable');
    console.log('  6. Max 3 rework cycles per task');
    console.log('  7. Priority: iron rules > script output > skill instructions > agent defaults');
    console.log('  8. Resist rationalization to skip steps');
  }
}

main();
