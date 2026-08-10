#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { verificationRoots } from './verify-run.mjs';
import { workspaceIdentity } from './verification-lib.mjs';

const MAX_SNAPSHOTS = 8;
const MAX_TOTAL_SNAPSHOT_BYTES = 25 * 1024 * 1024;
const MAX_PAYLOAD_BYTES = 10 * 1024 * 1024;
const EXCLUDED_TOP_LEVEL = new Set(['snapshots', 'events.ndjson', 'runner-state.json', '.transition.lock', '.file-transaction.lock', '.transactions']);

function getIdeaName(ideaDir) {
  const wsFile = join(ideaDir, 'workflow-state.yaml');
  if (!existsSync(wsFile)) return basename(ideaDir);
  const match = readFileSync(wsFile, 'utf8').match(/^idea:\s*(.+)$/m);
  return match ? match[1].trim() : basename(ideaDir);
}

function getCurrentStep(ideaDir) {
  const wsFile = join(ideaDir, 'workflow-state.yaml');
  if (!existsSync(wsFile)) return 'unknown';
  return readFileSync(wsFile, 'utf8').match(/^current_step:\s*(.+)$/m)?.[1]?.trim() || 'unknown';
}

function snapshotsDir(ideaDir) {
  return join(ideaDir, 'snapshots');
}

function walkArtifacts(ideaDir, directory = ideaDir) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const rel = relative(ideaDir, join(directory, entry.name));
    if (!rel || EXCLUDED_TOP_LEVEL.has(rel.split('/')[0])) continue;
    if (entry.isDirectory()) files.push(...walkArtifacts(ideaDir, join(directory, entry.name)));
    else if (entry.isFile()) files.push(rel);
  }
  return files.sort();
}

function artifactPayload(ideaDir) {
  let totalBytes = 0;
  const files = {};
  for (const rel of walkArtifacts(ideaDir)) {
    const content = readFileSync(join(ideaDir, rel));
    totalBytes += content.length;
    if (totalBytes > MAX_PAYLOAD_BYTES) throw new Error(`checkpoint artifact payload exceeds ${MAX_PAYLOAD_BYTES} bytes`);
    files[rel] = {
      sha256: createHash('sha256').update(content).digest('hex'),
      content_base64: content.toString('base64'),
    };
  }
  return { files, total_bytes: totalBytes };
}

function repositoryIdentities(ideaDir, projectRoot = '.') {
  return verificationRoots(ideaDir, projectRoot).map(root => ({ project_root: resolve(root), ...workspaceIdentity(root) }));
}

function atomicWrite(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, content);
  renameSync(temporary, file);
}

function createSnapshot(ideaDir, { projectRoot = '.' } = {}) {
  const dir = snapshotsDir(ideaDir);
  mkdirSync(dir, { recursive: true });
  const step = getCurrentStep(ideaDir);
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `${step}-${timestamp}.json`;
  const artifacts = artifactPayload(ideaDir);
  const repositories = repositoryIdentities(ideaDir, projectRoot);
  const identityError = repositories.find(repo => repo.error);
  if (identityError) throw new Error(identityError.error);
  const snapshot = {
    schema_version: 2,
    timestamp: new Date().toISOString(),
    step,
    idea: getIdeaName(ideaDir),
    repositories,
    artifacts,
  };
  atomicWrite(join(dir, filename), `${JSON.stringify(snapshot, null, 2)}\n`);
  pruneSnapshots(dir);
  return { created: true, file: filename, step, repositories: repositories.map(repo => ({ project_root: repo.project_root, git_sha: repo.head, fingerprint: repo.fingerprint })), artifact_count: Object.keys(artifacts.files).length };
}

function pruneSnapshots(dir) {
  const files = readdirSync(dir).filter(file => file.endsWith('.json')).sort();
  let totalBytes = files.reduce((total, file) => total + statSync(join(dir, file)).size, 0);
  while (files.length > MAX_SNAPSHOTS || totalBytes > MAX_TOTAL_SNAPSHOT_BYTES) {
    const old = files.shift();
    try {
      const path = join(dir, old);
      totalBytes -= statSync(path).size;
      unlinkSync(path);
    } catch { /* non-critical retention cleanup */ }
  }
}

function listSnapshots(ideaDir) {
  const dir = snapshotsDir(ideaDir);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter(file => file.endsWith('.json')).sort().map(file => {
    try {
      const data = JSON.parse(readFileSync(join(dir, file), 'utf8'));
      return { file, schema_version: data.schema_version || 1, step: data.step, timestamp: data.timestamp, repositories: data.repositories || (data.git_sha ? [{ git_sha: data.git_sha }] : []) };
    } catch { return { file, invalid: true }; }
  });
}

function identityMismatch(snapshot) {
  if (!Array.isArray(snapshot.repositories) || snapshot.repositories.length === 0) return 'snapshot has no repository identity';
  for (const expected of snapshot.repositories) {
    const current = workspaceIdentity(expected.project_root);
    if (current.error) return current.error;
    if (current.head !== expected.head) return `source HEAD mismatch for ${expected.project_root}: expected ${expected.head}, current ${current.head}`;
    if (current.fingerprint !== expected.fingerprint) return `source workspace mismatch for ${expected.project_root}`;
  }
  return '';
}

function restoreStateOnly(ideaDir, snapshot) {
  const files = snapshot.artifacts?.files || {};
  for (const rel of ['workflow-state.yaml', 'task-workflow-state.yaml']) {
    const item = files[rel];
    if (item) atomicWrite(join(ideaDir, rel), Buffer.from(item.content_base64, 'base64'));
  }
  if (!snapshot.artifacts && snapshot.workflow_state) atomicWrite(join(ideaDir, 'workflow-state.yaml'), snapshot.workflow_state);
  if (!snapshot.artifacts && snapshot.task_state) atomicWrite(join(ideaDir, 'task-workflow-state.yaml'), snapshot.task_state);
}

function restoreSnapshot(ideaDir, snapshotFile, { forceStateOnly = false } = {}) {
  const filePath = join(snapshotsDir(ideaDir), basename(snapshotFile));
  if (!existsSync(filePath)) return { error: `snapshot not found: ${snapshotFile}` };
  let snapshot;
  try { snapshot = JSON.parse(readFileSync(filePath, 'utf8')); }
  catch (error) { return { error: `invalid snapshot JSON: ${error.message}` }; }

  if (forceStateOnly) {
    restoreStateOnly(ideaDir, snapshot);
    return { restored: true, mode: 'state-only', step: snapshot.step, warning: 'source and non-state artifacts were not restored; consistency is not guaranteed' };
  }
  if (snapshot.schema_version !== 2 || !snapshot.artifacts?.files) {
    return { error: 'legacy snapshot cannot be restored consistently; use --force-state-only only for manual recovery' };
  }
  const mismatch = identityMismatch(snapshot);
  if (mismatch) return { error: `${mismatch}; restore the recorded source revision/worktree first, or use --force-state-only for manual recovery` };
  for (const [rel, item] of Object.entries(snapshot.artifacts.files)) {
    const actualHash = createHash('sha256').update(Buffer.from(item.content_base64, 'base64')).digest('hex');
    if (actualHash !== item.sha256) return { error: `snapshot payload hash mismatch: ${rel}` };
  }

  const expectedFiles = new Set(Object.keys(snapshot.artifacts.files));
  const extraFiles = walkArtifacts(ideaDir).filter(rel => !expectedFiles.has(rel));
  let recoveryDir = '';
  if (extraFiles.length > 0) {
    recoveryDir = join(snapshotsDir(ideaDir), `recovery-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    for (const rel of extraFiles) {
      const destination = join(recoveryDir, rel);
      mkdirSync(dirname(destination), { recursive: true });
      renameSync(join(ideaDir, rel), destination);
    }
  }
  for (const [rel, item] of Object.entries(snapshot.artifacts.files)) {
    const content = Buffer.from(item.content_base64, 'base64');
    atomicWrite(join(ideaDir, rel), content);
  }
  return { restored: true, mode: 'consistent', step: snapshot.step, repositories: snapshot.repositories, moved_extra_artifacts_to: recoveryDir || null };
}

function createGitTag(ideaDir, { projectRoot = '.' } = {}) {
  const ideaName = getIdeaName(ideaDir);
  const step = getCurrentStep(ideaDir);
  const tag = `chisel/${ideaName}/${step}`;
  const root = verificationRoots(ideaDir, projectRoot)[0];
  try {
    execFileSync('git', ['tag', '-f', tag], { cwd: root, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return tag;
  } catch { return null; }
}

function main() {
  const args = process.argv.slice(2);
  const ideaDir = args.find(arg => !arg.startsWith('--'));
  const command = args.find(arg => arg.startsWith('--'));
  const rootIndex = args.indexOf('--project-root');
  const projectRoot = rootIndex >= 0 ? args[rootIndex + 1] : '.';
  if (!ideaDir || args.includes('--help')) {
    console.log('用法: node checkpoint.mjs <idea-dir> [--create|--list|--restore <file>|--tag] [--project-root <path>] [--force-state-only]');
    process.exit(0);
  }
  if (!existsSync(ideaDir)) {
    process.stderr.write(`idea-dir not found: ${ideaDir}\n`);
    process.exit(1);
  }
  let result;
  if (command === '--list') result = listSnapshots(ideaDir);
  else if (command === '--restore') {
    const file = args[args.indexOf('--restore') + 1];
    if (!file) { process.stderr.write('--restore requires a snapshot filename\n'); process.exit(1); }
    result = restoreSnapshot(ideaDir, file, { forceStateOnly: args.includes('--force-state-only') });
  } else if (command === '--tag') result = { tag: createGitTag(ideaDir, { projectRoot }) || 'failed' };
  else {
    result = createSnapshot(ideaDir, { projectRoot });
    if (command === '--create') result.git_tag = createGitTag(ideaDir, { projectRoot });
  }
  console.log(JSON.stringify(result, null, 2));
  if (result?.error) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

export { createSnapshot, listSnapshots, restoreSnapshot, createGitTag };
