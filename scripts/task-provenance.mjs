#!/usr/bin/env node
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, join, resolve } from 'node:path';
import { verificationRoots } from './verify-run.mjs';
import { resolveExistingIdeaDirectory } from './control-plane.mjs';

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

export function serializeTaskRun(run) {
  return `${JSON.stringify(run, null, 2)}\n`;
}

function leaseExpiry(now, leaseSeconds) {
  const seconds = Number(leaseSeconds);
  if (!Number.isFinite(seconds) || seconds < 30) throw new Error('leaseSeconds must be at least 30');
  return new Date(new Date(now).getTime() + seconds * 1000).toISOString();
}

export function activeTaskAttempt(run) {
  const attempt = run?.attempts?.[run.attempts.length - 1];
  return attempt && !attempt.finished_at && !attempt.abandoned_at ? attempt : null;
}

export function taskAttemptLease(attempt, now = new Date().toISOString()) {
  if (!attempt) return { active: false, expired: false };
  const expiresAt = new Date(attempt.lease_until || attempt.started_at || 0).getTime();
  const expired = !Number.isFinite(expiresAt) || expiresAt <= new Date(now).getTime();
  return { active: !expired, expired, run_id: attempt.run_id || '', owner: attempt.owner || '', lease_until: attempt.lease_until || '' };
}

export function buildStartedTaskRun(ideaDir, taskId, { projectRoots, replaceCurrent = false, runId, owner = 'main-orchestrator', leaseSeconds = 3600, now = new Date().toISOString() } = {}) {
  const roots = projectRoots?.length ? projectRoots.map(root => resolve(root)) : verificationRoots(ideaDir, '.');
  const run = readTaskRun(ideaDir, taskId) || { schema_version: 2, task_id: taskId, attempts: [] };
  run.schema_version = 2;
  const current = activeTaskAttempt(run);
  if (replaceCurrent && current?.run_id && current.run_id !== runId) throw new Error(`task ${taskId} run ownership mismatch`);
  if (current && !replaceCurrent) {
    const lease = taskAttemptLease(current, now);
    if (lease.active) {
      if (current.owner !== owner) throw new Error(`task ${taskId} is leased by ${current.owner} until ${current.lease_until}`);
      current.last_heartbeat = now;
      current.lease_until = leaseExpiry(now, leaseSeconds);
      return { run, attempt: current, resumed: true };
    }
    current.abandoned_at = now;
    current.abandon_reason = 'lease_expired';
  }
  const attempt = {
    attempt: replaceCurrent && current ? current.attempt : run.attempts.length + 1,
    run_id: replaceCurrent && current?.run_id ? current.run_id : randomUUID(),
    owner: replaceCurrent && current?.owner ? current.owner : owner,
    started_at: replaceCurrent && current?.started_at ? current.started_at : now,
    last_heartbeat: now,
    lease_until: leaseExpiry(now, leaseSeconds),
    baseline: roots.map(snapshotRepository),
  };
  const failed = attempt.baseline.find(repository => repository.error);
  if (failed) throw new Error(failed.error);
  if (replaceCurrent && current) run.attempts[run.attempts.length - 1] = attempt;
  else run.attempts.push(attempt);
  return { run, attempt, resumed: false };
}

export function startTaskRun(ideaDir, taskId, options = {}) {
  const { run, attempt } = buildStartedTaskRun(ideaDir, taskId, options);
  writeTaskRun(ideaDir, taskId, run);
  return attempt;
}

export function heartbeatTaskRun(ideaDir, taskId, runId, { leaseSeconds = 3600, now = new Date().toISOString() } = {}) {
  const run = readTaskRun(ideaDir, taskId);
  const attempt = activeTaskAttempt(run);
  if (!attempt) throw new Error(`task ${taskId} has no active attempt`);
  if (!runId || attempt.run_id !== runId) throw new Error(`task ${taskId} run ownership mismatch`);
  if (taskAttemptLease(attempt, now).expired) throw new Error(`task ${taskId} lease expired; claim a new run`);
  attempt.last_heartbeat = now;
  attempt.lease_until = leaseExpiry(now, leaseSeconds);
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

export function buildFinishedTaskRun(ideaDir, taskId, runId, { now = new Date().toISOString() } = {}) {
  const run = readTaskRun(ideaDir, taskId);
  const attempt = run?.attempts?.[run.attempts.length - 1];
  if (!attempt) throw new Error(`task provenance missing for ${taskId}`);
  if (attempt.finished_at) return { run, attempt };
  if (attempt.run_id && (!runId || attempt.run_id !== runId)) throw new Error(`task ${taskId} run ownership mismatch`);
  if (attempt.lease_until && taskAttemptLease(attempt, now).expired) throw new Error(`task ${taskId} lease expired; claim a new run`);
  const preview = previewTaskChanges(ideaDir, taskId);
  attempt.finished_at = now;
  attempt.result = preview.repositories.map(repo => repo.after);
  attempt.repositories = preview.repositories.map(({ project_root, changed_files }) => ({ project_root, changed_files }));
  attempt.changed_files = [...new Set(attempt.repositories.flatMap(repo => repo.changed_files))].sort();
  return { run, attempt };
}

export function finishTaskRun(ideaDir, taskId, runId) {
  const { run, attempt } = buildFinishedTaskRun(ideaDir, taskId, runId);
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
  const ideaDir = args[0] ? resolveExistingIdeaDirectory(args[0], process.cwd()) : '';
  const taskId = args[1];
  const mode = args[2];
  if (!ideaDir || !taskId || !['--start', '--rebase-baseline', '--heartbeat', '--preview', '--finish'].includes(mode)) {
    process.stderr.write('用法: task-provenance.mjs <idea-dir> <task-id> --start|--rebase-baseline|--heartbeat|--preview|--finish [--project-root <path>] [--owner <id>] [--run-id <id>] [--lease-seconds <n>]\n');
    process.exit(1);
  }
  const rootIndex = args.indexOf('--project-root');
  const projectRoots = rootIndex >= 0 ? [args[rootIndex + 1]] : undefined;
  const ownerIndex = args.indexOf('--owner');
  const owner = ownerIndex >= 0 ? args[ownerIndex + 1] : undefined;
  const runIdIndex = args.indexOf('--run-id');
  const runId = runIdIndex >= 0 ? args[runIdIndex + 1] : undefined;
  const leaseIndex = args.indexOf('--lease-seconds');
  const leaseSeconds = leaseIndex >= 0 ? Number(args[leaseIndex + 1]) : undefined;
  try {
    const result = mode === '--start'
      ? startTaskRun(ideaDir, taskId, { projectRoots, owner, leaseSeconds })
      : mode === '--rebase-baseline'
        ? startTaskRun(ideaDir, taskId, { projectRoots, replaceCurrent: true, runId, owner, leaseSeconds })
        : mode === '--heartbeat'
          ? heartbeatTaskRun(ideaDir, taskId, runId, { leaseSeconds })
        : mode === '--finish'
          ? finishTaskRun(ideaDir, taskId, runId)
          : previewTaskChanges(ideaDir, taskId);
    console.log(JSON.stringify(result));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
