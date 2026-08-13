import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'scripts/branch-merge.mjs');
function git(args, cwd, { allowFail = false } = {}) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
  catch (error) { if (allowFail) return ''; throw error; }
}
function nodeJson(args, cwd) { return JSON.parse(execFileSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' })); }
function nodeJsonAllowFailure(args, cwd) {
  try { return { code: 0, value: nodeJson(args, cwd) }; }
  catch (error) { return { code: error.status || 1, value: JSON.parse(String(error.stdout || '').trim() || String(error.stderr || '{}').trim()) }; }
}
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'chisel-merge-'));
  git(['init', '-b', 'main'], dir); git(['config', 'user.email', 'test@example.invalid'], dir); git(['config', 'user.name', 'Test'], dir);
  writeFileSync(join(dir, 'value.txt'), 'base\n'); git(['add', 'value.txt'], dir); git(['commit', '-m', 'base'], dir); return dir;
}

describe('isolated integration delivery', () => {
  it('merges without switching or occupying the developer checkout', () => {
    const dir = repo();
    try {
      git(['switch', '-c', 'feat/one'], dir); writeFileSync(join(dir, 'feature.txt'), 'feature\n'); git(['add', 'feature.txt'], dir); git(['commit', '-m', 'feature'], dir);
      git(['switch', 'main'], dir); const before = git(['rev-parse', 'HEAD'], dir);
      const verifyCommand = JSON.stringify([process.execPath, '-e', 'process.exit(0)']);
      const result = nodeJson(['--merge', '--source', 'feat/one', '--target', 'main', '--repo', dir, '--confirm', '--verify-command-json', verifyCommand], dir);
      assert.equal(result.status, 'merged');
      assert.equal(result.verification.checks.at(-1).status, 'pass');
      assert.equal(git(['branch', '--show-current'], dir), 'main');
      assert.equal(git(['rev-parse', 'HEAD'], dir), before);
      assert.equal(git(['show', `${result.merge_commit}:feature.txt`], result.integration_worktree), 'feature');
      assert.ok(existsSync(result.integration_worktree));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('can advance a clean checked-out local target after isolated verification', () => {
    const dir = repo();
    try {
      git(['switch', '-c', 'feat/local-target'], dir);
      writeFileSync(join(dir, 'feature.txt'), 'feature\n');
      git(['add', 'feature.txt'], dir);
      git(['commit', '-m', 'feature'], dir);
      const featureHead = git(['rev-parse', 'HEAD'], dir);
      git(['switch', 'main'], dir);
      const result = nodeJson([
        '--merge', '--source', 'feat/local-target', '--target', 'main', '--repo', dir,
        '--confirm', '--update-local-target',
      ], dir);
      assert.equal(result.status, 'merged');
      assert.equal(result.local_target.status, 'updated');
      assert.equal(git(['branch', '--show-current'], dir), 'main');
      assert.equal(git(['rev-parse', 'main'], dir), result.merge_commit);
      assert.notEqual(result.merge_commit, featureHead, 'delivery keeps an explicit merge commit');
      assert.equal(readFileSync(join(dir, 'feature.txt'), 'utf8'), 'feature\n');
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('keeps conflict现场, reports base/ours/theirs, and supports continue/abort', () => {
    const dir = repo();
    try {
      git(['switch', '-c', 'feat/conflict'], dir); writeFileSync(join(dir, 'value.txt'), 'source\n'); git(['add', 'value.txt'], dir); git(['commit', '-m', 'source'], dir);
      git(['switch', 'main'], dir); writeFileSync(join(dir, 'value.txt'), 'target\n'); git(['add', 'value.txt'], dir); git(['commit', '-m', 'target'], dir);
      const result = nodeJson(['--merge', '--source', 'feat/conflict', '--target', 'main', '--repo', dir, '--confirm'], dir);
      assert.equal(result.status, 'conflicts_detected');
      assert.ok(result.report_file);
      assert.ok(existsSync(result.report_file));
      const report = JSON.parse(readFileSync(result.report_file, 'utf8'));
      assert.ok(report.base); assert.ok(report.ours); assert.ok(report.theirs); assert.equal(report.conflicts[0].file, 'value.txt');
      writeFileSync(join(result.integration_worktree, 'value.txt'), 'resolved\n'); git(['add', 'value.txt'], result.integration_worktree);
      const continued = nodeJson(['--continue', '--repo', dir, '--integration-worktree', result.integration_worktree, '--confirm'], dir);
      assert.equal(continued.status, 'merged');
      assert.equal(git(['show', `${continued.merge_commit}:value.txt`], result.integration_worktree), 'resolved');
      assert.equal(git(['cat-file', '-e', `${continued.merge_commit}:.chisel-merge-conflict.json`], result.integration_worktree, { allowFail: true }), '');

      // A second independent conflict demonstrates abort/cleanup without deleting feat/conflict.
      git(['switch', 'main'], dir); writeFileSync(join(dir, 'value.txt'), 'target-2\n'); git(['add', 'value.txt'], dir); git(['commit', '-m', 'target2'], dir);
      const aborted = nodeJson(['--merge', '--source', 'feat/conflict', '--target', 'main', '--repo', dir, '--integration-worktree', join(dir, '..', '.chisel', 'integration', 'abort-case'), '--confirm'], dir);
      assert.equal(aborted.status, 'conflicts_detected');
      const abortResult = nodeJson(['--abort', '--repo', dir, '--integration-worktree', aborted.integration_worktree, '--cleanup'], dir);
      assert.equal(abortResult.status, 'aborted'); assert.equal(abortResult.development_branch_preserved, true);
      assert.ok(git(['branch', '--list', 'feat/conflict'], dir).includes('feat/conflict'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('turns a remote target drift into an explicit push failure receipt', () => {
    const dir = repo();
    const remote = mkdtempSync(join(tmpdir(), 'chisel-remote-'));
    const drift = mkdtempSync(join(tmpdir(), 'chisel-drift-'));
    try {
      git(['init', '--bare', remote], remote);
      git(['remote', 'add', 'origin', remote], dir);
      git(['push', '-u', 'origin', 'main'], dir);
      git(['switch', '-c', 'feat/push'], dir); writeFileSync(join(dir, 'feature.txt'), 'feature\n'); git(['add', 'feature.txt'], dir); git(['commit', '-m', 'feature'], dir);
      git(['clone', remote, drift], tmpdir());
      git(['config', 'user.email', 'drift@example.invalid'], drift); git(['config', 'user.name', 'Drift'], drift);
      // A clone may already have a local main branch (or may have checked out
      // another default branch).  Reset/create it from origin/main without
      // assuming that the branch does not exist.
      git(['switch', '-C', 'main', 'origin/main'], drift);
      git(['reset', '--hard', 'origin/main'], drift);
      writeFileSync(join(drift, 'remote.txt'), 'drift\n'); git(['add', 'remote.txt'], drift); git(['commit', '-m', 'remote drift'], drift); git(['push', 'origin', 'main'], drift);
      git(['switch', 'main'], dir);
      const run = nodeJsonAllowFailure(['--merge', '--source', 'feat/push', '--target', 'main', '--repo', dir, '--confirm', '--push'], dir);
      assert.equal(run.code, 1);
      assert.equal(run.value.status, 'push_failed');
      assert.equal(run.value.push.status, 'remote_target_drift');
      assert.ok(run.value.merge_commit);
    } finally { rmSync(dir, { recursive: true, force: true }); rmSync(remote, { recursive: true, force: true }); rmSync(drift, { recursive: true, force: true }); }
  });
});
