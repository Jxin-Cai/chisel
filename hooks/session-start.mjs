#!/usr/bin/env node
// Enhanced SessionStart hook: injects workflow state and iron-rules digest.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { controlRoot } from '../scripts/control-plane.mjs';

function readWorkflowState(ideaDir) {
  const wsFile = join(ideaDir, 'workflow-state.yaml');
  if (!existsSync(wsFile)) return null;
  const text = readFileSync(wsFile, 'utf8');
  const step = text.match(/^current_step:\s*(.+)$/m)?.[1]?.trim() || 'unknown';
  const idea = text.match(/^idea:\s*(.+)$/m)?.[1]?.trim() || 'unknown';
  const revision = Number(text.match(/^revision:\s*(\d+)$/m)?.[1] || 0);
  return { idea, step, revision };
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
  const chiselDir = controlRoot(cwd);

  console.log('chisel plugin is available.');
  console.log('Use /chisel <需求描述或需求文件路径> for legacy system feature enhancement.');

  if (!existsSync(chiselDir)) {
    console.log(`Runtime artifacts are stored in the shared control plane: ${chiselDir}/<idea-name>/.`);
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
      console.log(`  - ${w.idea}: step=${w.step} rev=${w.revision} | ${taskLine}`);
    }
    console.log('');
    console.log('DESIGN PRINCIPLES (root cause of all rules):');
    console.log('  P1: 穷举枚举 — 新增变体=grep全部消费者并原子更新');
    console.log('  P2: 转移完整性 — 状态变更经唯一路径+全副作用原子执行');
    console.log('  P3: 边界快失败 — undefined/null/malformed 在入口点拦截');
    console.log('  P4: 副作用一致 — 改X则更新所有读X的下游');
    console.log('  P5: 唯一来源 — 导入不复制，枚举只定义一次');
    console.log('OPERATIONAL: status=read-only truth | transition.mjs=only step writer | revision required | no skip | user confirm | call status every turn | gate after step | max 5 rework | rounds 4-5 use fresh agent | priority: rules>scripts>skills>defaults | resist rationalization | fix from principle');
  }
}

main();
