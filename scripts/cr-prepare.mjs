#!/usr/bin/env node
import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readFrontmatter, readTaskState, taskStateFile } from './workflow-lib.mjs';
import { checkScope } from './scope-check.mjs';

function fail(msg) {
  process.stderr.write(`${JSON.stringify({ error: msg })}\n`);
  process.exit(1);
}

function readTaskFile(ideaDir, taskId) {
  const state = readTaskState(taskStateFile(ideaDir));
  const task = state.tasks[taskId];
  if (!task) return null;
  const filePath = join(ideaDir, task.file);
  if (!existsSync(filePath)) return null;
  const content = readFileSync(filePath, 'utf8');
  const fm = readFrontmatter(content);
  return { frontmatter: fm, content, status: task.status, rework_count: task.rework_count || 0 };
}

function readTaskReport(ideaDir, taskId) {
  const reportPath = join(ideaDir, 'task-reports', `${taskId}-report.md`);
  if (!existsSync(reportPath)) return null;
  const content = readFileSync(reportPath, 'utf8');
  const fm = readFrontmatter(content);
  return { frontmatter: fm, content, changed_files: fm.changed_files || [] };
}

function computeDiff(baseRef, changedFiles, projectRoot) {
  if (!changedFiles.length) return '';
  try {
    if (baseRef) {
      return execFileSync('git', ['diff', `${baseRef}...HEAD`, '--', ...changedFiles], {
        cwd: projectRoot, encoding: 'utf8', maxBuffer: 5 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe']
      });
    }
    return execFileSync('git', ['log', '--format=', '-p', 'HEAD', '--', ...changedFiles], {
      cwd: projectRoot, encoding: 'utf8', maxBuffer: 5 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch {
    return '';
  }
}

function queryWiki(projectRoot, text) {
  const scriptDir = new URL('.', import.meta.url).pathname;
  try {
    const result = execFileSync('node', [
      join(scriptDir, 'wiki-manage.mjs'), '--query', projectRoot,
      '--text', text, '--min-score', '2', '--load-plan', '--limit', '10'
    ], { encoding: 'utf8', maxBuffer: 2 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
    return JSON.parse(result);
  } catch {
    return { status: 'ok', matches: [], warnings: ['wiki query failed'] };
  }
}

function computeRepairDiffFiles(ideaDir, currentChangedFiles) {
  const prevPath = join(ideaDir, 'cr', 'cr-context-prev.json');
  if (!existsSync(prevPath)) return currentChangedFiles;
  try {
    const prev = JSON.parse(readFileSync(prevPath, 'utf8'));
    const prevFiles = new Set(Object.values(prev.tasks || {}).flatMap(t => t.changed_files || []));
    return currentChangedFiles.filter(f => !prevFiles.has(f));
  } catch {
    return currentChangedFiles;
  }
}

function computeReworkCycle(ideaDir) {
  const prevPath = join(ideaDir, 'cr', 'cr-context-prev.json');
  if (!existsSync(prevPath)) return 0;
  try {
    const prev = JSON.parse(readFileSync(prevPath, 'utf8'));
    return (prev.rework_cycle || 0) + 1;
  } catch {
    return 0;
  }
}

function main() {
  const ideaDir = process.argv[2];
  const baseRef = process.argv[3] || '';
  const projectRoot = process.argv[4] || '.';
  const pathsOnly = process.argv.includes('--paths-only');
  const compactMode = process.argv.includes('--compact');

  if (!ideaDir) fail('用法: cr-prepare.mjs <idea-dir> [base-ref] [project-root] [--paths-only] [--compact]');

  const state = readTaskState(taskStateFile(ideaDir));
  const taskIds = Object.entries(state.tasks)
    .filter(([, t]) => t.status === 'reviewing' || t.status === 'coded')
    .map(([id]) => id)
    .sort();

  if (!taskIds.length) fail('无待审查 task');

  const allChangedFiles = new Set();
  const tasks = {};

  for (const taskId of taskIds) {
    const taskFile = readTaskFile(ideaDir, taskId);
    const report = readTaskReport(ideaDir, taskId);
    const changedFiles = report?.changed_files || [];
    changedFiles.forEach(f => allChangedFiles.add(f));

    const scopeResult = checkScope(ideaDir, taskId, projectRoot);

    if (pathsOnly) {
      const taskState = state.tasks[taskId];
      const taskFilePath = taskState ? join(ideaDir, taskState.file) : '';
      const reportFilePath = join(ideaDir, 'task-reports', `${taskId}-report.md`);
      tasks[taskId] = {
        task_file_path: taskFilePath,
        report_file_path: reportFilePath,
        changed_files: changedFiles,
        rework_count: taskFile?.rework_count || 0,
        scope_check: scopeResult
      };
    } else {
      tasks[taskId] = {
        task_content: taskFile?.content || '',
        report_content: report?.content || '',
        changed_files: changedFiles,
        rework_count: taskFile?.rework_count || 0,
        scope_check: scopeResult
      };
    }
  }

  const diff = computeDiff(baseRef, [...allChangedFiles], projectRoot);

  const wikiText = taskIds.map(id => {
    const content = pathsOnly
      ? (tasks[id].task_file_path && existsSync(tasks[id].task_file_path) ? readFileSync(tasks[id].task_file_path, 'utf8') : '')
      : (tasks[id].task_content || '');
    const fm = content.split('---')[1] || '';
    return fm;
  }).join(' ');
  const wikiResult = queryWiki(projectRoot, wikiText.slice(0, 500));

  const context = {
    schema_version: 1,
    mode: compactMode ? 'compact' : pathsOnly ? 'paths-only' : 'inline',
    generated_at: new Date().toISOString(),
    idea_dir: ideaDir,
    base_ref: baseRef,
    project_root: projectRoot,
    task_ids: taskIds,
    tasks,
    unified_diff: diff,
    wiki_query: wikiResult
  };

  const crDir = join(ideaDir, 'cr');
  mkdirSync(crDir, { recursive: true });
  const outPath = join(crDir, 'cr-context.json');

  // Incremental review: save previous context before overwriting
  if (existsSync(outPath)) {
    try {
      renameSync(outPath, join(crDir, 'cr-context-prev.json'));
    } catch { /* non-critical: full re-review if rename fails */ }
  }

  // Compute incremental review fields
  const reworkCycle = computeReworkCycle(ideaDir);
  const allChangedFilesList = [...allChangedFiles];
  const repairDiffFiles = reworkCycle > 0 ? computeRepairDiffFiles(ideaDir, allChangedFilesList) : [];

  context.rework_cycle = reworkCycle;
  context.repair_diff_files = repairDiffFiles;

  // Compact mode: trim verbose content to save tokens
  if (compactMode || JSON.stringify(context).length > 50 * 1024) {
    context.mode = 'compact';
    for (const [id, t] of Object.entries(context.tasks)) {
      if (t.task_content) {
        const fmMatch = t.task_content.match(/^---\n([\s\S]*?)\n---/);
        t.task_content = fmMatch ? `---\n${fmMatch[1]}\n---` : '';
      }
      if (t.report_content) {
        const fmMatch = t.report_content.match(/^---\n([\s\S]*?)\n---/);
        const statusMatch = t.report_content.match(/## Completion Status[\s\S]*?(?=\n## |$)/);
        t.report_content = (fmMatch ? `---\n${fmMatch[1]}\n---\n` : '') + (statusMatch ? statusMatch[0] : '');
      }
    }
    if (context.unified_diff && context.unified_diff.length > 20 * 1024) {
      const lines = context.unified_diff.split('\n');
      const summary = lines.filter(l => l.startsWith('diff --git') || l.startsWith('+++'))
        .map(l => l.replace('diff --git a/', '').replace(/ b\/.*/, ''))
        .filter(l => l.startsWith('+++'))
        .map(l => l.replace('+++ b/', ''));
      context.unified_diff = `[compact: ${summary.length} files, full diff ${Math.round(context.unified_diff.length/1024)}KB — use git diff to read]\n` + summary.map(f => `+++ ${f}`).join('\n');
    }
    if (context.wiki_query?.matches) {
      context.wiki_query.matches = context.wiki_query.matches.map(m => ({ id: m.id, score: m.score, category: m.category }));
    }
  }

  writeFileSync(outPath, JSON.stringify(context, null, 2));
  console.log(JSON.stringify({ status: 'ok', path: outPath, task_count: taskIds.length, diff_lines: diff.split('\n').length, rework_cycle: reworkCycle, repair_diff_files_count: repairDiffFiles.length }));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
