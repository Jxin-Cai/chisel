#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { readTaskState, taskStateFile } from './workflow-lib.mjs';

function getBaseRef(ideaDir) {
  const wdPath = join(ideaDir, 'worktree-decision.json');
  if (!existsSync(wdPath)) return null;
  try {
    const wd = JSON.parse(readFileSync(wdPath, 'utf8'));
    return wd.base_ref || wd.base_branch || null;
  } catch { return null; }
}

function getActualChangedFiles(baseRef) {
  try {
    const cmd = baseRef
      ? `git diff --name-only ${baseRef}...HEAD`
      : 'git diff --name-only HEAD~1';
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
      .trim().split('\n').filter(Boolean);
  } catch { return []; }
}

function getPlannedFiles(ideaDir) {
  const tasksPath = join(ideaDir, 'to-be/tasks.json');
  if (!existsSync(tasksPath)) return { planned: new Map(), taskFiles: new Map() };
  try {
    const tasks = JSON.parse(readFileSync(tasksPath, 'utf8'));
    const taskList = Array.isArray(tasks) ? tasks : (tasks.tasks || []);
    const planned = new Map();
    const taskFiles = new Map();
    for (const task of taskList) {
      const taskId = task.id || task.task_id;
      const files = [];
      if (task.file_plan) {
        for (const fp of (Array.isArray(task.file_plan) ? task.file_plan : [task.file_plan])) {
          const path = typeof fp === 'string' ? fp : (fp.path || fp.file);
          if (path) { planned.set(path, taskId); files.push(path); }
        }
      }
      if (task.files) {
        for (const f of task.files) {
          const path = typeof f === 'string' ? f : (f.path || f.file);
          if (path) { planned.set(path, taskId); files.push(path); }
        }
      }
      if (files.length) taskFiles.set(taskId, files);
    }
    return { planned, taskFiles };
  } catch { return { planned: new Map(), taskFiles: new Map() }; }
}

function getScopeFiles(ideaDir) {
  const state = readTaskState(taskStateFile(ideaDir));
  const allScope = new Set();
  for (const [, task] of Object.entries(state.tasks || {})) {
    if (task.scope_files) {
      for (const f of task.scope_files) allScope.add(f);
    }
  }
  return allScope;
}

export function detectDrift(ideaDir, baseRef) {
  const ref = baseRef || getBaseRef(ideaDir);
  const actualFiles = getActualChangedFiles(ref);
  const { planned, taskFiles } = getPlannedFiles(ideaDir);

  if (planned.size === 0) return { drift_items: [], score: 100, note: 'no file_plan in tasks.json' };

  const driftItems = [];

  // Missing: planned but not actually changed
  for (const [file, taskId] of planned.entries()) {
    if (!actualFiles.includes(file)) {
      driftItems.push({ type: 'missing', file, task_id: taskId, severity: 'medium' });
    }
  }

  // Unexpected: actually changed but not in any plan
  const chiselPattern = /^\.chisel\//;
  for (const file of actualFiles) {
    if (chiselPattern.test(file)) continue;
    if (!planned.has(file)) {
      driftItems.push({ type: 'unexpected', file, task_id: null, severity: 'low' });
    }
  }

  // Score calculation
  const total = Math.max(planned.size, actualFiles.filter(f => !chiselPattern.test(f)).length, 1);
  const issues = driftItems.filter(d => d.severity !== 'low').length;
  const score = Math.max(0, Math.round(100 - (issues / total) * 100));

  return { drift_items: driftItems, score, base_ref: ref, planned_count: planned.size, actual_count: actualFiles.length };
}

function main() {
  const args = process.argv.slice(2);
  const ideaDir = args.find(a => !a.startsWith('--'));
  const baseRefIdx = args.indexOf('--base-ref');
  const baseRef = baseRefIdx !== -1 ? args[baseRefIdx + 1] : null;

  if (!ideaDir || args.includes('--help')) {
    console.log('用法: node drift-detect.mjs <idea-dir> [--base-ref <ref>]');
    process.exit(0);
  }

  if (!existsSync(ideaDir)) {
    process.stderr.write(`idea-dir not found: ${ideaDir}\n`);
    process.exit(1);
  }

  const result = detectDrift(ideaDir, baseRef);
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.score < 40 ? 1 : 0);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
