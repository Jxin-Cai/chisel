#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { verificationRoots } from './verify-run.mjs';

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 20 * 1024 * 1024 }).trim();
}

function fileHash(root, file) {
  const path = join(root, file);
  if (!existsSync(path)) return null;
  try {
    const stat = statSync(path);
    return createHash('sha256').update(String(stat.mode)).update('\0').update(readFileSync(path)).digest('hex');
  } catch { return '<non-file>'; }
}

function changedCandidates(root) {
  const values = [];
  for (const args of [
    ['diff', '--name-only', 'HEAD'],
    ['ls-files', '--others', '--exclude-standard'],
  ]) {
    try { values.push(...git(root, args).split('\n').filter(Boolean)); } catch { /* handled by snapshot error */ }
  }
  return [...new Set(values)].filter(file => file && !file.startsWith('.chisel/')).sort();
}

export function snapshotRepository(root) {
  const projectRoot = resolve(root);
  try {
    const head = git(projectRoot, ['rev-parse', 'HEAD']);
    const candidates = changedCandidates(projectRoot);
    return {
      project_root: projectRoot,
      repo: basename(projectRoot),
      head,
      dirty_files: Object.fromEntries(candidates.map(file => [file, fileHash(projectRoot, file)])),
    };
  } catch (error) {
    return { project_root: projectRoot, repo: basename(projectRoot), error: error.message, head: '', dirty_files: {} };
  }
}

function committedFiles(root, from, to) {
  if (!from || !to || from === to) return [];
  try { return git(root, ['diff', '--name-only', `${from}..${to}`]).split('\n').filter(Boolean); } catch { return []; }
}

export function compareRepositorySnapshots(before, after) {
  if (!before || !after) return [];
  const committed = new Set(committedFiles(after.project_root, before.head, after.head));
  const files = new Set([
    ...Object.keys(before.dirty_files || {}),
    ...Object.keys(after.dirty_files || {}),
    ...committed,
  ]);
  return [...files].filter(file => {
    if (committed.has(file)) {
      // A pre-existing dirty file that was merely included in a later commit is
      // not task work unless its content/mode changed after the task baseline.
      if (Object.hasOwn(before.dirty_files || {}, file)) return before.dirty_files[file] !== fileHash(after.project_root, file);
      return true;
    }
    return (before.dirty_files || {})[file] !== (after.dirty_files || {})[file];
  }).sort();
}

export function taskRunPath(ideaDir, taskId) {
  return join(ideaDir, 'task-runs', `${taskId}.json`);
}

export function readTaskRun(ideaDir, taskId) {
  const path = taskRunPath(ideaDir, taskId);
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch (error) { throw new Error(`invalid task provenance for ${taskId}: ${error.message}`); }
}

function writeTaskRun(ideaDir, taskId, run) {
  mkdirSync(join(ideaDir, 'task-runs'), { recursive: true });
  const target = taskRunPath(ideaDir, taskId);
  const temporary = `${target}.tmp-${process.pid}`;
  writeFileSync(temporary, `${JSON.stringify(run, null, 2)}\n`);
  renameSync(temporary, target);
}

export function startTaskRun(ideaDir, taskId, { projectRoots, replaceCurrent = false } = {}) {
  const roots = projectRoots?.length ? projectRoots.map(root => resolve(root)) : verificationRoots(ideaDir, '.');
  const run = readTaskRun(ideaDir, taskId) || { schema_version: 1, task_id: taskId, attempts: [] };
  const current = run.attempts[run.attempts.length - 1];
  const attempt = {
    attempt: replaceCurrent && current && !current.finished_at ? current.attempt : run.attempts.length + 1,
    started_at: new Date().toISOString(),
    baseline: roots.map(snapshotRepository),
  };
  const failed = attempt.baseline.find(repository => repository.error);
  if (failed) throw new Error(failed.error);
  if (replaceCurrent && current && !current.finished_at) run.attempts[run.attempts.length - 1] = attempt;
  else run.attempts.push(attempt);
  writeTaskRun(ideaDir, taskId, run);
  return attempt;
}

export function previewTaskChanges(ideaDir, taskId) {
  const run = readTaskRun(ideaDir, taskId);
  const attempt = run?.attempts?.[run.attempts.length - 1];
  if (!attempt?.baseline) return null;
  const repositories = attempt.baseline.map(before => {
    const after = snapshotRepository(before.project_root);
    if (after.error) throw new Error(after.error);
    return { project_root: before.project_root, changed_files: compareRepositorySnapshots(before, after), before, after };
  });
  return { task_id: taskId, attempt: attempt.attempt, repositories };
}

export function finishTaskRun(ideaDir, taskId) {
  const run = readTaskRun(ideaDir, taskId);
  const attempt = run?.attempts?.[run.attempts.length - 1];
  if (!attempt) throw new Error(`task provenance missing for ${taskId}`);
  if (attempt.finished_at) return attempt;
  const preview = previewTaskChanges(ideaDir, taskId);
  attempt.finished_at = new Date().toISOString();
  attempt.result = preview.repositories.map(repo => repo.after);
  attempt.repositories = preview.repositories.map(({ project_root, changed_files }) => ({ project_root, changed_files }));
  attempt.changed_files = [...new Set(attempt.repositories.flatMap(repo => repo.changed_files))].sort();
  writeTaskRun(ideaDir, taskId, run);
  return attempt;
}

export function changedFilesForProject(ideaDir, taskId, projectRoot = '.') {
  const run = readTaskRun(ideaDir, taskId);
  const attempt = run?.attempts?.[run.attempts.length - 1];
  if (!attempt) return null;
  if (attempt.finished_at) {
    const root = resolve(projectRoot);
    const repositories = attempt.repositories || [];
    const matching = repositories.find(repo => resolve(repo.project_root) === root);
    if (matching) return matching.changed_files || [];
    return repositories.length === 1 ? repositories[0].changed_files || [] : [];
  }
  const preview = previewTaskChanges(ideaDir, taskId);
  const root = resolve(projectRoot);
  const matching = preview.repositories.find(repo => resolve(repo.project_root) === root);
  if (matching) return matching.changed_files || [];
  return preview.repositories.length === 1 ? preview.repositories[0].changed_files || [] : [];
}

function main() {
  const args = process.argv.slice(2);
  const ideaDir = args[0];
  const taskId = args[1];
  const mode = args[2];
  if (!ideaDir || !taskId || !['--start', '--rebase-baseline', '--preview', '--finish'].includes(mode)) {
    process.stderr.write('用法: task-provenance.mjs <idea-dir> <task-id> --start|--rebase-baseline|--preview|--finish [--project-root <path>]\n');
    process.exit(1);
  }
  const rootIndex = args.indexOf('--project-root');
  const projectRoots = rootIndex >= 0 ? [args[rootIndex + 1]] : undefined;
  try {
    const result = mode === '--start'
      ? startTaskRun(ideaDir, taskId, { projectRoots })
      : mode === '--rebase-baseline'
        ? startTaskRun(ideaDir, taskId, { projectRoots, replaceCurrent: true })
        : mode === '--finish'
          ? finishTaskRun(ideaDir, taskId)
          : previewTaskChanges(ideaDir, taskId);
    console.log(JSON.stringify(result));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
