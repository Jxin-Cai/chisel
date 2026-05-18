#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { readTaskExpectedFiles, readTaskState, taskStateFile, writeTaskState } from './workflow-lib.mjs';

function fail(message) {
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(1);
}

function parseNumstat(output) {
  return output.split('\n').filter(Boolean).map(line => {
    const [added, deleted, file] = line.split('\t');
    return {
      file,
      added: Number(added) || 0,
      deleted: Number(deleted) || 0
    };
  });
}

function gitNames(args) {
  return execFileSync('git', args, { encoding: 'utf8' }).split('\n').filter(Boolean);
}

function matchesScope(file, patterns) {
  if (patterns.length === 0) return true;
  return patterns.some(pattern => file === pattern || pattern.endsWith('/') && file.startsWith(pattern) || pattern.endsWith('/*') && file.startsWith(pattern.slice(0, -1)) || pattern.endsWith('/**') && file.startsWith(pattern.slice(0, -2)));
}

function lineCount(file) {
  try {
    const text = readFileSync(file, 'utf8');
    if (!text) return 0;
    return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
  } catch {
    return 0;
  }
}

function collectRows(scopedFiles = []) {
  let trackedRows = [];
  let untrackedFiles = [];
  try {
    trackedRows = parseNumstat(execFileSync('git', ['diff', '--numstat', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    trackedRows = [];
  }
  try {
    untrackedFiles = gitNames(['ls-files', '--others', '--exclude-standard']);
  } catch {
    untrackedFiles = [];
  }
  const trackedFiles = new Set(trackedRows.map(row => row.file));
  const rows = [
    ...trackedRows,
    ...untrackedFiles.filter(file => !trackedFiles.has(file)).map(file => ({ file, added: lineCount(file), deleted: 0 }))
  ];
  return rows.filter(row => row.file && !row.file.startsWith('.chisel/') && matchesScope(row.file, scopedFiles));
}

function updateTaskMetrics(ideaDir, taskId = '') {
  if (!existsSync(taskStateFile(ideaDir))) throw new Error('task-workflow-state.yaml missing');

  const state = readTaskState(taskStateFile(ideaDir));
  const task = taskId ? state.tasks[taskId] : null;
  const taskFile = task ? join(ideaDir, task.file) : '';
  const expectedFiles = readTaskExpectedFiles(taskFile);
  const scopedFiles = expectedFiles.length > 0 ? expectedFiles : task?.expected_files || [];
  const rows = collectRows(scopedFiles);

  const metricsDir = join(ideaDir, 'metrics');
  mkdirSync(metricsDir, { recursive: true });
  const changedFiles = rows.map(row => row.file);
  const locAdded = rows.reduce((sum, row) => sum + row.added, 0);
  const locDeleted = rows.reduce((sum, row) => sum + row.deleted, 0);

  writeFileSync(join(metricsDir, 'changed-files.json'), `${JSON.stringify(changedFiles, null, 2)}\n`);
  writeFileSync(join(metricsDir, 'loc-delta.json'), `${JSON.stringify({ added: locAdded, deleted: locDeleted }, null, 2)}\n`);

  if (taskId && state.tasks[taskId]) {
    state.tasks[taskId].expected_files = scopedFiles;
    state.tasks[taskId].changed_files = changedFiles;
    state.tasks[taskId].loc_added = locAdded;
    state.tasks[taskId].loc_deleted = locDeleted;
    writeTaskState(taskStateFile(ideaDir), state);
  }

  const summary = {
    task_id: taskId || null,
    expected_files: scopedFiles,
    changed_files: changedFiles,
    loc_added: locAdded,
    loc_deleted: locDeleted
  };
  writeFileSync(join(metricsDir, 'task-summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  return summary;
}

function main(argv) {
  const ideaDir = argv[0];
  const taskId = argv[1] || '';
  if (!ideaDir) fail('用法: task-metrics.mjs <idea-dir> [task-id]');
  try {
    console.log(JSON.stringify(updateTaskMetrics(ideaDir, taskId)));
  } catch (error) {
    fail(error.message);
  }
}

export { collectRows, parseNumstat, updateTaskMetrics };

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
