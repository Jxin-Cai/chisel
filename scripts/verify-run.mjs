#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import { workspaceIdentity } from './verification-lib.mjs';
import { durableAtomicWrite } from './file-transaction.mjs';

function readPackage(projectRoot) {
  const path = join(projectRoot, 'package.json');
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function detectChecks(projectRoot) {
  const pkg = readPackage(projectRoot);
  if (pkg) {
    const scripts = pkg.scripts || {};
    const checks = [];
    for (const id of ['test', 'lint', 'typecheck', 'check', 'build']) {
      if (!scripts[id]) continue;
      // Avoid running both a generic check and its explicit components when possible.
      if (id === 'check' && checks.some(check => ['lint', 'typecheck'].includes(check.id))) continue;
      checks.push({ id, command: 'npm', args: ['run', id] });
    }
    return checks;
  }
  if (existsSync(join(projectRoot, 'pyproject.toml')) || existsSync(join(projectRoot, 'setup.py'))) {
    return [{ id: 'test', command: 'python', args: ['-m', 'pytest'] }];
  }
  if (existsSync(join(projectRoot, 'gradlew'))) {
    return [{ id: 'test', command: './gradlew', args: ['test', '--no-daemon'] }];
  }
  if (existsSync(join(projectRoot, 'mvnw'))) {
    return [{ id: 'test', command: './mvnw', args: ['test', '-q'] }];
  }
  if (existsSync(join(projectRoot, 'pom.xml'))) {
    return [{ id: 'test', command: 'mvn', args: ['test', '-q'] }];
  }
  return [];
}

function runCheck(check, projectRoot) {
  const start = Date.now();
  try {
    const output = execFileSync(check.command, check.args, {
      cwd: projectRoot,
      encoding: 'utf8',
      timeout: Number(check.timeout_ms || 120000),
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 4 * 1024 * 1024,
    });
    return { ...check, status: 'pass', exit_code: 0, duration_ms: Date.now() - start, output: output.slice(-2000) };
  } catch (error) {
    const output = `${error.stdout || ''}\n${error.stderr || ''}`.slice(-3000);
    return { ...check, status: 'fail', exit_code: Number.isInteger(error.status) ? error.status : 1, duration_ms: Date.now() - start, output };
  }
}

function contractPath(ideaDir) { return join(ideaDir, 'verification-contract.json'); }

function contractFingerprint(contract) {
  return createHash('sha256').update(JSON.stringify(contract)).digest('hex');
}

export function createVerificationContract(ideaDir, roots) {
  const contract = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    repositories: roots.map(root => ({
      project_root: resolve(root),
      checks: detectChecks(root).map(check => ({ ...check, timeout_ms: 120000, required: true })),
    })),
  };
  durableAtomicWrite(contractPath(ideaDir), `${JSON.stringify(contract, null, 2)}\n`);
  return contract;
}

function readVerificationContract(ideaDir) {
  const path = contractPath(ideaDir);
  if (!existsSync(path)) return null;
  const contract = JSON.parse(readFileSync(path, 'utf8'));
  if (contract.schema_version !== 1 || !Array.isArray(contract.repositories)) throw new Error('invalid verification-contract.json');
  for (const repo of contract.repositories) {
    if (!repo.project_root || !Array.isArray(repo.checks)) throw new Error('verification contract repository requires project_root and checks');
    for (const check of repo.checks) {
      if (!check.id || !check.command || !Array.isArray(check.args)) throw new Error('verification contract check requires id, command, and args[]');
    }
  }
  return contract;
}

function verificationRoots(ideaDir, fallbackRoot) {
  const decisionPath = join(ideaDir, 'worktree-decision.json');
  if (!existsSync(decisionPath)) return [resolve(fallbackRoot)];
  try {
    const decision = JSON.parse(readFileSync(decisionPath, 'utf8'));
    if (![2, 3].includes(decision.schema_version) || !Array.isArray(decision.repos) || decision.repos.length === 0) return [resolve(fallbackRoot)];
    const roots = decision.repos.map(repo => {
      // v3 worktree records use repo_path + worktree_path; v2 records usually
      // only have path.  Prefer the actual worktree checkout for verification,
      // then tolerate the aliases emitted by older multi-repo commands.
      return repo?.worktree_path || repo?.path || repo?.repo_path || repo?.project_root || repo?.root;
    }).filter(Boolean).map(path => isAbsolute(path) ? path : resolve(fallbackRoot, path));
    return [...new Set(roots)];
  } catch {
    return [resolve(fallbackRoot)];
  }
}

function main() {
  const ideaDir = process.argv[2];
  const projectRoot = process.argv[3] || '.';
  if (!ideaDir) {
    process.stderr.write(`${JSON.stringify({ error: '用法: verify-run.mjs <idea-dir> [project-root]' })}\n`);
    process.exit(1);
  }

  const roots = verificationRoots(ideaDir, projectRoot);
  if (process.argv.includes('--init-contract')) {
    let existing;
    try { existing = readVerificationContract(ideaDir); }
    catch (error) {
      process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
      process.exit(1);
    }
    const contract = existing && !process.argv.includes('--force-contract') ? existing : createVerificationContract(ideaDir, roots);
    console.log(JSON.stringify({ initialized: !existing || process.argv.includes('--force-contract'), existing: Boolean(existing), contract: contractPath(ideaDir), repositories: contract.repositories }));
    return;
  }
  let contract;
  try { contract = readVerificationContract(ideaDir); }
  catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exit(1);
  }
  const repositories = roots.map(root => {
    const entry = contract?.repositories.find(repo => resolve(repo.project_root) === resolve(root));
    const configuredChecks = entry?.checks || detectChecks(root);
    const checks = configuredChecks.map(check => runCheck(check, root));
    const identity = workspaceIdentity(root);
    const status = configuredChecks.length > 0 && checks.every(check => check.status === 'pass') && !identity.error ? 'pass' : 'fail';
    return {
      project_root: root,
      status,
      git_head: identity.head || '',
      workspace_fingerprint: identity.fingerprint || '',
      checks,
      ...(configuredChecks.length === 0 ? { reason: 'no verification command detected; configure test/build commands before review' } : {}),
      ...(identity.error ? { reason: identity.error } : {}),
    };
  });
  const status = repositories.length > 0 && repositories.every(repo => repo.status === 'pass') ? 'pass' : 'fail';
  const result = {
    schema_version: 2,
    status,
    generated_at: new Date().toISOString(),
    verification_contract: contract ? { source: 'explicit', fingerprint: contractFingerprint(contract) } : { source: 'legacy-auto-detected', fingerprint: '' },
    repositories,
  };
  durableAtomicWrite(join(ideaDir, 'verify-result.json'), `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ status, repositories: repositories.map(repo => ({ project_root: repo.project_root, status: repo.status, checks: repo.checks.map(({ id, status: checkStatus }) => ({ id, status: checkStatus })) })) }));
  if (status !== 'pass') process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

export { contractFingerprint, detectChecks, readVerificationContract, runCheck, verificationRoots };
