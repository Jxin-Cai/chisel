#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, resolve } from 'node:path';
import { verificationPlanFingerprint, workspaceIdentity } from './verification-lib.mjs';
import { durableAtomicWrite } from './file-transaction.mjs';
import { recordDuration } from './session-metrics.mjs';
import { appendUnitTestRun } from './unit-test-evidence.mjs';
import { resolveExistingIdeaDirectory } from './control-plane.mjs';

const FULL_CHECK_OUTPUT = Symbol('full-check-output');

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

function isUnitTestCheck(check = {}) {
  return /(?:^|[-_:])(test|tests|unit|coverage)(?:$|[-_:])/i.test(String(check.id || ''))
    || /(?:test|pytest|jest|vitest|mocha|coverage)/i.test([check.command, ...(check.args || [])].join(' '));
}

function matchingPassLine(output, marker) {
  return String(output || '').split('\n').map(line => line.trim()).find(line => {
    if (!line.includes(marker) || /(?:#\s*(?:SKIP|TODO)|\bSKIPPED\b)/i.test(line)) return false;
    return /^(?:ok\s+\d+\s+-\s+|[✔✓]\s+|PASS(?:ED)?\b|\S+::\S+.*\bPASSED\b)/i.test(line);
  }) || '';
}

function requirementCaseEvidence(cases, checks, projectRoot) {
  return cases.map(testCase => {
    const check = checks.find(item => item.id === testCase.check_id);
    const output = String(check?.[FULL_CHECK_OUTPUT] || check?.output || '');
    const passLine = matchingPassLine(output, testCase.pass_evidence);
    const testFile = join(projectRoot, testCase.test_file);
    return {
      ...testCase,
      status: check?.status === 'pass' && check?.exit_code === 0 && passLine && existsSync(testFile) ? 'pass' : 'fail',
      evidence: {
        command: check ? [check.command, ...(check.args || [])].join(' ') : '',
        exit_code: check?.exit_code ?? null,
        duration_ms: check?.duration_ms || 0,
        output_excerpt: passLine,
        test_file_sha256: existsSync(testFile) ? createHash('sha256').update(readFileSync(testFile)).digest('hex') : '',
      },
      ...(!check ? { reason: `check not executed: ${testCase.check_id}` }
        : !existsSync(testFile) ? { reason: `test file missing: ${testCase.test_file}` }
          : !passLine ? { reason: `passing test line not found in ${testCase.check_id} output: ${testCase.pass_evidence}` } : {}),
    };
  });
}

function validateRequirementCases(repo, knownTraceRefs = null) {
  const unitCheckIds = new Set((repo.checks || []).filter(isUnitTestCheck).map(check => check.id));
  if (unitCheckIds.size === 0) return;
  const cases = repo.requirement_cases;
  if (!Array.isArray(cases) || cases.length === 0) throw new Error(`repository ${repo.project_root} requires non-empty requirement_cases for its unit-test checks`);
  const ids = new Set();
  const passMarkers = new Set();
  for (const [index, testCase] of cases.entries()) {
    const label = `requirement_cases[${index}]`;
    for (const field of ['id', 'test_file', 'test_name', 'given', 'when', 'then', 'failure_mode', 'check_id', 'pass_evidence']) {
      if (typeof testCase?.[field] !== 'string' || !testCase[field].trim()) throw new Error(`${label}.${field} must be non-empty`);
    }
    if (ids.has(testCase.id)) throw new Error(`duplicate requirement case id: ${testCase.id}`);
    ids.add(testCase.id);
    if (passMarkers.has(testCase.pass_evidence)) throw new Error(`duplicate requirement case pass_evidence: ${testCase.pass_evidence}`);
    passMarkers.add(testCase.pass_evidence);
    if (!Array.isArray(testCase.trace_refs) || testCase.trace_refs.length === 0) throw new Error(`${label}.trace_refs must be non-empty`);
    if (!unitCheckIds.has(testCase.check_id)) throw new Error(`${label}.check_id must reference a unit-test check`);
    if (isAbsolute(testCase.test_file) || testCase.test_file.split(/[\\/]/).includes('..')) throw new Error(`${label}.test_file must be a repository-relative path`);
    if (knownTraceRefs) {
      const unknown = testCase.trace_refs.filter(ref => !knownTraceRefs.has(ref));
      if (unknown.length > 0) throw new Error(`${label}.trace_refs contains unknown requirement refs: ${unknown.join(', ')}`);
    }
  }
}

function requirementTraceRefs(ideaDir) {
  try {
    const matrix = JSON.parse(readFileSync(join(ideaDir, 'to-be/traceability-matrix.json'), 'utf8'));
    return new Set((matrix.items || []).map(item => item.id).filter(Boolean));
  } catch { return null; }
}

function runCheck(check, projectRoot) {
  const start = Date.now();
  const environment = { ...process.env };
  delete environment.NODE_TEST_CONTEXT;
  const executed = spawnSync(check.command, check.args, {
    cwd: projectRoot,
    encoding: 'utf8',
    timeout: Number(check.timeout_ms || 120000),
    stdio: ['pipe', 'pipe', 'pipe'],
    maxBuffer: 4 * 1024 * 1024,
    env: environment,
  });
  const output = `${executed.stdout || ''}${executed.stderr || ''}`;
  const passed = !executed.error && executed.status === 0;
  const result = {
    ...check,
    status: passed ? 'pass' : 'fail',
    exit_code: Number.isInteger(executed.status) ? executed.status : 1,
    duration_ms: Date.now() - start,
    output: output.slice(passed ? -64 * 1024 : -3000),
    ...(executed.error ? { error: executed.error.message } : {}),
  };
  result[FULL_CHECK_OUTPUT] = output;
  return result;
}

function contractPath(ideaDir) { return join(ideaDir, 'verification-contract.json'); }

function contractFingerprint(contract) {
  return createHash('sha256').update(JSON.stringify(contract)).digest('hex');
}

export function createVerificationContract(ideaDir, roots) {
  const contract = {
    schema_version: 2,
    generated_at: new Date().toISOString(),
    repositories: roots.map(root => ({
      project_root: resolve(root),
      checks: detectChecks(root).map(check => ({ ...check, timeout_ms: 120000, required: true })),
      requirement_cases: [],
    })),
  };
  durableAtomicWrite(contractPath(ideaDir), `${JSON.stringify(contract, null, 2)}\n`);
  return contract;
}

function readVerificationContract(ideaDir) {
  const path = contractPath(ideaDir);
  if (!existsSync(path)) return null;
  const contract = JSON.parse(readFileSync(path, 'utf8'));
  if (![1, 2].includes(contract.schema_version) || !Array.isArray(contract.repositories)) throw new Error('invalid verification-contract.json');
  const knownTraceRefs = requirementTraceRefs(ideaDir);
  for (const repo of contract.repositories) {
    if (!repo.project_root || !Array.isArray(repo.checks)) throw new Error('verification contract repository requires project_root and checks');
    for (const check of repo.checks) {
      if (!check.id || !check.command || !Array.isArray(check.args)) throw new Error('verification contract check requires id, command, and args[]');
    }
    validateRequirementCases(repo, knownTraceRefs);
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
    validateRequirementCases(repo, requirementTraceRefs(ideaDir));
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
  const ideaDir = process.argv[2] ? resolveExistingIdeaDirectory(process.argv[2], process.cwd()) : '';
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
    console.log(JSON.stringify({ initialized: !existing || process.argv.includes('--force-contract'), existing: Boolean(existing), contract: resolve(contractPath(ideaDir)), repositories: contract.repositories }));
    return;
  }
  if (incremental) {
    let plan;
    try { plan = readRepairVerificationPlan(ideaDir, projectRoot); }
    catch (error) { process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exit(1); }
    const repositories = plan.repositories.map(repo => {
      const repositoryRoot = repairRepositoryRoot(repo.project_root, projectRoot);
      const checks = repo.checks.map(check => runCheck(check, repositoryRoot));
      const requirementCases = requirementCaseEvidence(repo.requirement_cases || [], checks, repositoryRoot);
      const identity = workspaceIdentity(repositoryRoot);
      return {
        project_root: repositoryRoot,
        status: checks.every(check => check.status === 'pass') && requirementCases.every(testCase => testCase.status === 'pass') && !identity.error ? 'pass' : 'fail',
        git_head: identity.head || '', workspace_fingerprint: identity.fingerprint || '', checks,
        requirement_case_evidence: requirementCases,
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
    console.log(JSON.stringify({ status, mode: 'incremental', result_file: resolve(ideaDir, 'incremental-verify-result.json'), affected_files: result.affected_files, repositories: repositories.map(repo => ({ project_root: repo.project_root, status: repo.status })) }));
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
    const requirementCases = requirementCaseEvidence(entry?.requirement_cases || [], checks, root);
    const identity = workspaceIdentity(root);
    const hasUnitChecks = configuredChecks.some(isUnitTestCheck);
    const status = configuredChecks.length > 0 && checks.every(check => check.status === 'pass')
      && (!hasUnitChecks || requirementCases.length > 0 && requirementCases.every(testCase => testCase.status === 'pass')) && !identity.error ? 'pass' : 'fail';
    return {
      project_root: root,
      status,
      git_head: identity.head || '',
      workspace_fingerprint: identity.fingerprint || '',
      checks,
      requirement_case_evidence: requirementCases,
      ...(configuredChecks.length === 0 ? { reason: 'no verification command detected; configure test/build commands before review' } : {}),
      ...(hasUnitChecks && requirementCases.length === 0 ? { reason: 'unit-test checks require requirement_cases with verifiable PASS output' } : {}),
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
  console.log(JSON.stringify({ status, result_file: resolve(ideaDir, 'verify-result.json'), repositories: repositories.map(repo => ({ project_root: repo.project_root, status: repo.status, checks: repo.checks.map(({ id, status: checkStatus }) => ({ id, status: checkStatus })) })) }));
  if (status !== 'pass') process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main();

export { contractFingerprint, detectChecks, readVerificationContract, runCheck, verificationRoots };
