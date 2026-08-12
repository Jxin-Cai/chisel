#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import { verificationPlanFingerprint, workspaceIdentity } from './verification-lib.mjs';
import { durableAtomicWrite } from './file-transaction.mjs';
import { recordDuration } from './session-metrics.mjs';
import { appendUnitTestRun } from './unit-test-evidence.mjs';

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
    const coverageScript = ['test:coverage', 'coverage'].find(id => scripts[id]);
    if (coverageScript) checks.push({ id: 'unit-test-coverage', command: 'npm', args: ['run', coverageScript] });
    for (const id of ['test', 'lint', 'typecheck', 'check', 'build']) {
      if (!scripts[id]) continue;
      if (id === 'test' && coverageScript) continue;
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

function readRepairVerificationPlan(ideaDir, fallbackRoot) {
  const path = join(ideaDir, 'repair-verification-plan.json');
  if (!existsSync(path)) throw new Error('repair-verification-plan.json missing; repair rounds require explicit affected files and targeted checks');
  const plan = JSON.parse(readFileSync(path, 'utf8'));
  if (plan.schema_version !== 1 || !Array.isArray(plan.affected_files) || plan.affected_files.length === 0) {
    throw new Error('repair-verification-plan.json requires schema_version 1 and non-empty affected_files');
  }
  if (!Array.isArray(plan.repositories) || plan.repositories.length === 0) throw new Error('repair-verification-plan.json repositories must be non-empty');
  for (const repo of plan.repositories) {
    const repositoryRoot = repairRepositoryRoot(repo.project_root, fallbackRoot);
    if (!Array.isArray(repo.checks) || repo.checks.length === 0) throw new Error(`repair verification checks must be non-empty for ${repositoryRoot}`);
    for (const check of repo.checks) if (!check.id || !check.command || !Array.isArray(check.args)) throw new Error('repair verification checks require id, command and args[]');
  }
  return plan;
}

function repairRepositoryRoot(value, fallbackRoot) {
  if (!value) return resolve(fallbackRoot);
  return isAbsolute(value) ? resolve(value) : resolve(fallbackRoot, value);
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
  const verifyStartedAt = Date.now();
  const ideaDir = process.argv[2];
  const projectRoot = process.argv[3] || '.';
  if (!ideaDir) {
    process.stderr.write(`${JSON.stringify({ error: '用法: verify-run.mjs <idea-dir> [project-root]' })}\n`);
    process.exit(1);
  }

  const incremental = process.argv.includes('--incremental');
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
  if (incremental) {
    let plan;
    try { plan = readRepairVerificationPlan(ideaDir, projectRoot); }
    catch (error) { process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exit(1); }
    const repositories = plan.repositories.map(repo => {
      const repositoryRoot = repairRepositoryRoot(repo.project_root, projectRoot);
      const checks = repo.checks.map(check => runCheck(check, repositoryRoot));
      const identity = workspaceIdentity(repositoryRoot);
      return {
        project_root: repositoryRoot,
        status: checks.every(check => check.status === 'pass') && !identity.error ? 'pass' : 'fail',
        git_head: identity.head || '', workspace_fingerprint: identity.fingerprint || '', checks,
        ...(identity.error ? { reason: identity.error } : {}),
      };
    });
    const status = repositories.every(repo => repo.status === 'pass') ? 'pass' : 'fail';
    const result = {
      schema_version: 1, mode: 'incremental', status, generated_at: new Date().toISOString(),
      affected_files: [...new Set(plan.affected_files)].sort(),
      affected_dimensions: [...new Set(plan.affected_dimensions || [])].sort(),
      plan_fingerprint: verificationPlanFingerprint(plan), repositories,
    };
    durableAtomicWrite(join(ideaDir, 'incremental-verify-result.json'), `${JSON.stringify(result, null, 2)}\n`);
    try { appendUnitTestRun(ideaDir, result); } catch { /* history is non-critical */ }
    console.log(JSON.stringify({ status, mode: 'incremental', affected_files: result.affected_files, repositories: repositories.map(repo => ({ project_root: repo.project_root, status: repo.status })) }));
    if (status !== 'pass') process.exit(1);
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
    mode: 'full',
    status,
    generated_at: new Date().toISOString(),
    verification_contract: contract ? { source: 'explicit', fingerprint: contractFingerprint(contract) } : { source: 'legacy-auto-detected', fingerprint: '' },
    repositories,
  };
  durableAtomicWrite(join(ideaDir, 'verify-result.json'), `${JSON.stringify(result, null, 2)}\n`);
  try { appendUnitTestRun(ideaDir, result); } catch (error) {
    process.stderr.write(`${JSON.stringify({ warning: `cannot record unit-test run: ${error.message}` })}\n`);
  }
  try { recordDuration(ideaDir, 'verification', 'verify-run', Date.now() - verifyStartedAt, { repositories: repositories.length, checks: repositories.reduce((sum, repo) => sum + repo.checks.length, 0) }, status); } catch { /* metrics are non-critical */ }
  console.log(JSON.stringify({ status, repositories: repositories.map(repo => ({ project_root: repo.project_root, status: repo.status, checks: repo.checks.map(({ id, status: checkStatus }) => ({ id, status: checkStatus })) })) }));
  if (status !== 'pass') process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

export { contractFingerprint, detectChecks, readVerificationContract, runCheck, verificationRoots };
