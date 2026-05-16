#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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

function main(argv) {
  const ideaDir = argv[0];
  const taskId = argv[1] || '';
  if (!ideaDir) fail('用法: task-metrics.mjs <idea-dir> [task-id]');
  if (!existsSync(taskStateFile(ideaDir))) fail('task-workflow-state.yaml missing');

  const state = readTaskState(taskStateFile(ideaDir));
  const task = taskId ? state.tasks[taskId] : null;
  const taskFile = task ? join(ideaDir, task.file) : '';
  const expectedFiles = readTaskExpectedFiles(taskFile);
  const scopedFiles = expectedFiles.length > 0 ? expectedFiles : task?.expected_files || [];
  let rows = [];
  try {
    const args = ['diff', '--numstat'];
    if (scopedFiles.length > 0) args.push('--', ...scopedFiles);
    rows = parseNumstat(execFileSync('git', args, { encoding: 'utf8' }));
  } catch {
    rows = [];
  }

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
  console.log(JSON.stringify(summary));
}

main(process.argv.slice(2));
