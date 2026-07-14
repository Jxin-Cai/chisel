#!/usr/bin/env node
// Lightweight, side-effect-free workflow snapshot for !command injection and session-start.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

function readWorkflowState(ideaDir) {
  const wsFile = join(ideaDir, 'workflow-state.yaml');
  if (!existsSync(wsFile)) return null;
  const text = readFileSync(wsFile, 'utf8');
  const step = text.match(/^current_step:\s*(.+)$/m)?.[1]?.trim() || 'unknown';
  const idea = text.match(/^idea:\s*(.+)$/m)?.[1]?.trim() || 'unknown';
  const updated = text.match(/^last_updated_at:\s*(.+)$/m)?.[1]?.trim();
  return { idea, step, updated };
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
  if (!existsSync(chiselDir)) {
    console.log('无活跃工作流');
    return;
  }

  let entries;
  try {
    entries = readdirSync(chiselDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'wiki' && e.name !== 'wiki-candidates');
  } catch {
    console.log('无活跃工作流');
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

  if (workflows.length === 0) {
    console.log('无活跃工作流');
    return;
  }

  for (const w of workflows) {
    const taskLine = w.tasks
      ? Object.entries(w.tasks).map(([s, c]) => `${s}=${c}`).join(', ')
      : '未初始化';
    console.log(`活跃: ${w.idea} @ step=${w.step} | tasks: ${taskLine}`);
  }
  console.log('提示: 必须调用 orchestration-status.mjs 获取权威 resume_step');
}

main();
