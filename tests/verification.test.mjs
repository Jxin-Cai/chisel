import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateIncrementalVerificationResult, validateVerificationResult, verificationPlanFingerprint, workspaceIdentity } from '../scripts/verification-lib.mjs';
import { contractFingerprint, createVerificationContract, verificationRoots } from '../scripts/verify-run.mjs';

describe('verification evidence', () => {
  let root;
  let ideaDir;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'chisel-verification-'));
    ideaDir = join(root, '.chisel', 'test');
    mkdirSync(ideaDir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: root });
    writeFileSync(join(root, 'app.js'), 'export const value = 1;\n');
    execFileSync('git', ['add', 'app.js'], { cwd: root });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: root });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function writePassingResult() {
    const identity = workspaceIdentity(root);
    writeFileSync(join(ideaDir, 'verify-result.json'), JSON.stringify({
      schema_version: 2,
      status: 'pass',
      git_head: identity.head,
      workspace_fingerprint: identity.fingerprint,
      checks: [{ id: 'test', status: 'pass', exit_code: 0 }],
    }));
  }

  it('accepts passing checks bound to the current workspace', () => {
    writePassingResult();
    assert.equal(validateVerificationResult(ideaDir, root), '');
  });

  it('rejects evidence after the working tree changes', () => {
    writePassingResult();
    writeFileSync(join(root, 'app.js'), 'export const value = 2;\n');
    assert.match(validateVerificationResult(ideaDir, root), /working tree changed/);
  });

  it('rejects skipped or failed verification', () => {
    const identity = workspaceIdentity(root);
    writeFileSync(join(ideaDir, 'verify-result.json'), JSON.stringify({
      schema_version: 2,
      status: 'fail',
      git_head: identity.head,
      workspace_fingerprint: identity.fingerprint,
      checks: [],
    }));
    assert.match(validateVerificationResult(ideaDir, root), /must be pass/);
  });

  it('validates every repository in an aggregated result', () => {
    const secondRoot = join(root, 'nested-repo');
    mkdirSync(secondRoot);
    execFileSync('git', ['init', '-q'], { cwd: secondRoot });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: secondRoot });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: secondRoot });
    writeFileSync(join(secondRoot, 'service.js'), 'export const service = true;\n');
    execFileSync('git', ['add', 'service.js'], { cwd: secondRoot });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: secondRoot });
    const identities = [root, secondRoot].map(projectRoot => ({ projectRoot, identity: workspaceIdentity(projectRoot) }));
    writeFileSync(join(ideaDir, 'verify-result.json'), JSON.stringify({
      schema_version: 2,
      status: 'pass',
      repositories: identities.map(({ projectRoot, identity }) => ({
        project_root: projectRoot,
        git_head: identity.head,
        workspace_fingerprint: identity.fingerprint,
        checks: [{ id: 'test', status: 'pass', exit_code: 0 }],
      })),
    }));
    assert.equal(validateVerificationResult(ideaDir, root), '');
    writeFileSync(join(secondRoot, 'service.js'), 'export const service = false;\n');
    assert.match(validateVerificationResult(ideaDir, root), /nested-repo/);
  });

  it('binds evidence to an explicit verification contract', () => {
    writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }));
    const contract = createVerificationContract(ideaDir, [root]);
    const identity = workspaceIdentity(root);
    writeFileSync(join(ideaDir, 'verify-result.json'), JSON.stringify({
      schema_version: 2,
      status: 'pass',
      verification_contract: { source: 'explicit', fingerprint: contractFingerprint(contract) },
      repositories: [{
        project_root: root,
        git_head: identity.head,
        workspace_fingerprint: identity.fingerprint,
        checks: [{ id: 'test', status: 'pass', exit_code: 0 }],
      }],
    }));
    assert.equal(validateVerificationResult(ideaDir, root), '');
    contract.repositories[0].checks.push({ id: 'lint', command: 'npm', args: ['run', 'lint'], required: true });
    writeFileSync(join(ideaDir, 'verification-contract.json'), JSON.stringify(contract));
    assert.match(validateVerificationResult(ideaDir, root), /contract changed/);
  });

  it('selects every schema v3 worktree repository for verification', () => {
    const secondRoot = join(root, 'second-worktree');
    mkdirSync(secondRoot);
    writeFileSync(join(ideaDir, 'worktree-decision.json'), JSON.stringify({
      schema_version: 3,
      repos: [
        { repo_path: root, worktree_path: root },
        { repo_path: secondRoot, worktree_path: secondRoot },
      ],
    }));
    assert.deepEqual(verificationRoots(ideaDir, root), [root, secondRoot]);
  });

  it('accepts targeted repair verification but invalidates it when plan or workspace changes', () => {
    const plan = {
      schema_version: 1,
      affected_files: ['app.js'],
      affected_dimensions: ['spec'],
      repositories: [{ project_root: root, checks: [{ id: 'targeted', command: 'node', args: ['--test'] }] }],
    };
    writeFileSync(join(ideaDir, 'repair-verification-plan.json'), JSON.stringify(plan));
    const identity = workspaceIdentity(root);
    writeFileSync(join(ideaDir, 'incremental-verify-result.json'), JSON.stringify({
      schema_version: 1, mode: 'incremental', status: 'pass', affected_files: ['app.js'],
      plan_fingerprint: verificationPlanFingerprint(plan),
      repositories: [{ project_root: root, git_head: identity.head, workspace_fingerprint: identity.fingerprint, checks: [{ id: 'targeted', status: 'pass', exit_code: 0 }] }],
    }));
    assert.equal(validateIncrementalVerificationResult(ideaDir, root), '');
    plan.affected_files.push('other.js');
    writeFileSync(join(ideaDir, 'repair-verification-plan.json'), JSON.stringify(plan));
    assert.match(validateIncrementalVerificationResult(ideaDir, root), /plan changed/);
  });

  it('executes an incremental plan relative to the supplied project root and binds the unmodified plan', () => {
    const plan = {
      schema_version: 1, affected_files: ['app.js'], affected_dimensions: ['spec'],
      repositories: [{ project_root: '.', checks: [{ id: 'targeted', command: process.execPath, args: ['-e', 'process.exit(0)'] }] }],
    };
    writeFileSync(join(ideaDir, 'repair-verification-plan.json'), JSON.stringify(plan));
    execFileSync(process.execPath, ['scripts/verify-run.mjs', ideaDir, root, '--incremental'], { cwd: process.cwd() });
    assert.equal(existsSync(join(ideaDir, 'incremental-verify-result.json')), true);
    assert.equal(JSON.parse(readFileSync(join(ideaDir, 'incremental-verify-result.json'))).repositories[0].project_root, root);
    assert.equal(validateIncrementalVerificationResult(ideaDir, root), '');
  });
});
