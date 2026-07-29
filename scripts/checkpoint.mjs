#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, basename } from 'node:path';

const MAX_SNAPSHOTS = 20;

function getGitSha() {
  try { return execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
  catch { return null; }
}

function getIdeaName(ideaDir) {
  const wsFile = join(ideaDir, 'workflow-state.yaml');
  if (!existsSync(wsFile)) return basename(ideaDir);
  const text = readFileSync(wsFile, 'utf8');
  const m = text.match(/^idea:\s*(.+)$/m);
  return m ? m[1].trim() : basename(ideaDir);
}

function getCurrentStep(ideaDir) {
  const wsFile = join(ideaDir, 'workflow-state.yaml');
  if (!existsSync(wsFile)) return 'unknown';
  const text = readFileSync(wsFile, 'utf8');
  const m = text.match(/^current_step:\s*(.+)$/m);
  return m ? m[1].trim() : 'unknown';
}

function snapshotsDir(ideaDir) {
  return join(ideaDir, 'snapshots');
}

function createSnapshot(ideaDir) {
  const dir = snapshotsDir(ideaDir);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const step = getCurrentStep(ideaDir);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${step}-${timestamp}.json`;

  const snapshot = {
    timestamp: new Date().toISOString(),
    git_sha: getGitSha(),
    step,
    idea: getIdeaName(ideaDir),
  };

  const wsFile = join(ideaDir, 'workflow-state.yaml');
  if (existsSync(wsFile)) snapshot.workflow_state = readFileSync(wsFile, 'utf8');

  const tsFile = join(ideaDir, 'task-workflow-state.yaml');
  if (existsSync(tsFile)) snapshot.task_state = readFileSync(tsFile, 'utf8');

  const artifacts = ['requirement.md', 'to-be/tasks.json', 'to-be/traceability-matrix.json',
    'worktree-decision.json', 'metrics.json'];
  snapshot.artifacts_exist = artifacts.filter(a => existsSync(join(ideaDir, a)));

  writeFileSync(join(dir, filename), JSON.stringify(snapshot, null, 2));
  pruneSnapshots(dir);

  return { created: true, file: filename, step, git_sha: snapshot.git_sha };
}

function pruneSnapshots(dir) {
  const files = readdirSync(dir).filter(f => f.endsWith('.json')).sort();
  while (files.length > MAX_SNAPSHOTS) {
    const old = files.shift();
    try { unlinkSync(join(dir, old)); } catch { /* ignore */ }
  }
}

function listSnapshots(ideaDir) {
  const dir = snapshotsDir(ideaDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => {
    try {
      const data = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      return { file: f, step: data.step, timestamp: data.timestamp, git_sha: data.git_sha };
    } catch { return { file: f }; }
  });
}

function restoreSnapshot(ideaDir, snapshotFile) {
  const dir = snapshotsDir(ideaDir);
  const filePath = join(dir, snapshotFile);
  if (!existsSync(filePath)) return { error: `snapshot not found: ${snapshotFile}` };

  let snapshot;
  try { snapshot = JSON.parse(readFileSync(filePath, 'utf8')); }
  catch (e) { return { error: `invalid snapshot JSON: ${e.message}` }; }

  if (snapshot.workflow_state) {
    writeFileSync(join(ideaDir, 'workflow-state.yaml'), snapshot.workflow_state);
  }
  if (snapshot.task_state) {
    writeFileSync(join(ideaDir, 'task-workflow-state.yaml'), snapshot.task_state);
  }

  return { restored: true, step: snapshot.step, git_sha: snapshot.git_sha, note: 'state files restored; git checkout is NOT automatic — run manually if needed' };
}

function createGitTag(ideaDir) {
  const ideaName = getIdeaName(ideaDir);
  const step = getCurrentStep(ideaDir);
  const tag = `chisel/${ideaName}/${step}`;
  try {
    execSync(`git tag -f "${tag}"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return tag;
  } catch { return null; }
}

function main() {
  const args = process.argv.slice(2);
  const ideaDir = args.find(a => !a.startsWith('--'));
  const command = args.find(a => a.startsWith('--'));

  if (!ideaDir || args.includes('--help')) {
    console.log('用法: node checkpoint.mjs <idea-dir> [--create|--list|--restore <file>|--tag]');
    process.exit(0);
  }

  if (!existsSync(ideaDir)) {
    process.stderr.write(`idea-dir not found: ${ideaDir}\n`);
    process.exit(1);
  }

  if (command === '--create') {
    const result = createSnapshot(ideaDir);
    const tag = createGitTag(ideaDir);
    if (tag) result.git_tag = tag;
    console.log(JSON.stringify(result, null, 2));
  } else if (command === '--list') {
    console.log(JSON.stringify(listSnapshots(ideaDir), null, 2));
  } else if (command === '--restore') {
    const fileIdx = args.indexOf('--restore');
    const file = args[fileIdx + 1];
    if (!file) { process.stderr.write('--restore requires a snapshot filename\n'); process.exit(1); }
    console.log(JSON.stringify(restoreSnapshot(ideaDir, file), null, 2));
  } else if (command === '--tag') {
    const tag = createGitTag(ideaDir);
    console.log(JSON.stringify({ tag: tag || 'failed' }));
  } else {
    const result = createSnapshot(ideaDir);
    console.log(JSON.stringify(result, null, 2));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export { createSnapshot, listSnapshots, restoreSnapshot, createGitTag };
