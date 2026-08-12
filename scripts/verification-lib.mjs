import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

function contractFingerprint(contract) {
  return createHash('sha256').update(JSON.stringify(contract)).digest('hex');
}

export function verificationPlanFingerprint(plan) {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

function gitOutput(projectRoot, args) {
  return execFileSync('git', args, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 20 * 1024 * 1024,
  }).trim();
}

export function workspaceIdentity(projectRoot = '.') {
  let head = '';
  let trackedDiff = '';
  let untracked = [];
  try {
    head = gitOutput(projectRoot, ['rev-parse', 'HEAD']);
    trackedDiff = gitOutput(projectRoot, ['diff', '--binary', 'HEAD', '--', '.', ':(exclude).chisel/**']);
    untracked = gitOutput(projectRoot, ['ls-files', '--others', '--exclude-standard'])
      .split('\n').filter(file => file && !file.startsWith('.chisel/')).sort();
  } catch (error) {
    return { error: `cannot fingerprint git workspace: ${error.message}` };
  }

  const hash = createHash('sha256');
  hash.update(`head\0${head}\0tracked\0${trackedDiff}\0`);
  for (const file of untracked) {
    const path = join(projectRoot, file);
    hash.update(`untracked\0${file}\0`);
    if (existsSync(path)) {
      const stat = statSync(path);
      hash.update(stat.isFile() ? readFileSync(path) : '<directory>');
    }
    hash.update('\0');
  }
  return { head, fingerprint: hash.digest('hex'), untracked_files: untracked };
}

export function validateVerificationResult(ideaDir, projectRoot = '.') {
  const path = join(ideaDir, 'verify-result.json');
  if (!existsSync(path)) return 'verify-result.json missing';
  let result;
  try {
    result = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return `verify-result.json invalid JSON: ${error.message}`;
  }
  if (result.schema_version !== 2 && result.schema_version !== 3) return 'verify-result.json schema_version must be 2 or 3';
  if (result.status !== 'pass') return `verification status must be pass but is ${result.status || 'missing'}`;
  const contractPath = join(ideaDir, 'verification-contract.json');
  if (existsSync(contractPath)) {
    let contract;
    try { contract = JSON.parse(readFileSync(contractPath, 'utf8')); }
    catch (error) { return `verification-contract.json invalid JSON: ${error.message}`; }
    if (result.verification_contract?.source !== 'explicit') return 'verification result is not bound to the explicit contract';
    if (result.verification_contract.fingerprint !== contractFingerprint(contract)) return 'verification is stale: verification contract changed';
  }
  const repositories = Array.isArray(result.repositories) && result.repositories.length > 0
    ? result.repositories
    : [{ project_root: projectRoot, git_head: result.git_head, workspace_fingerprint: result.workspace_fingerprint, checks: result.checks }];
  for (const repo of repositories) {
    const repositoryRoot = repo.project_root || repo.worktree_path || repo.path || repo.repo_path || repo.root || projectRoot;
    if (repo.status && repo.status !== 'pass') return `verification status must be pass for ${repositoryRoot}`;
    if (!Array.isArray(repo.checks) || repo.checks.length === 0) return `verification checks must be non-empty for ${repositoryRoot}`;
    const failed = repo.checks.filter(check => check.status !== 'pass' || check.exit_code !== 0);
    if (failed.length > 0) return `verification contains failed checks for ${repositoryRoot}: ${failed.map(check => check.id).join(', ')}`;
    const current = workspaceIdentity(repositoryRoot);
    if (current.error) return current.error;
    const recordedHead = repo.git_head || repo.head_commit || repo.head;
    const recordedFingerprint = repo.workspace_fingerprint || repo.fingerprint;
    if (recordedHead !== current.head) return `verification is stale: git HEAD changed for ${repositoryRoot}`;
    if (recordedFingerprint !== current.fingerprint) return `verification is stale: working tree changed for ${repositoryRoot}`;
  }
  return '';
}

export function validateIncrementalVerificationResult(ideaDir, projectRoot = '.') {
  const path = join(ideaDir, 'incremental-verify-result.json');
  const planPath = join(ideaDir, 'repair-verification-plan.json');
  if (!existsSync(path)) return 'incremental-verify-result.json missing';
  if (!existsSync(planPath)) return 'repair-verification-plan.json missing';
  let result;
  let plan;
  try { result = JSON.parse(readFileSync(path, 'utf8')); } catch (error) { return `incremental-verify-result.json invalid JSON: ${error.message}`; }
  try { plan = JSON.parse(readFileSync(planPath, 'utf8')); } catch (error) { return `repair-verification-plan.json invalid JSON: ${error.message}`; }
  if (result.schema_version !== 1 || result.mode !== 'incremental') return 'incremental verification result must use schema_version 1 and mode incremental';
  if (result.status !== 'pass') return `incremental verification status must be pass but is ${result.status || 'missing'}`;
  if (result.plan_fingerprint !== verificationPlanFingerprint(plan)) return 'incremental verification is stale: repair verification plan changed';
  if (!Array.isArray(result.affected_files) || result.affected_files.length === 0) return 'incremental verification affected_files must be non-empty';
  const repositories = Array.isArray(result.repositories) ? result.repositories : [];
  if (repositories.length === 0) return 'incremental verification repositories must be non-empty';
  for (const repo of repositories) {
    const root = repo.project_root || projectRoot;
    if (!Array.isArray(repo.checks) || repo.checks.length === 0) return `incremental verification checks must be non-empty for ${root}`;
    if (repo.checks.some(check => check.status !== 'pass' || check.exit_code !== 0)) return `incremental verification contains failed checks for ${root}`;
    const current = workspaceIdentity(root);
    if (current.error) return current.error;
    if (repo.git_head !== current.head) return `incremental verification is stale: git HEAD changed for ${root}`;
    if (repo.workspace_fingerprint !== current.fingerprint) return `incremental verification is stale: working tree changed for ${root}`;
  }
  return '';
}
