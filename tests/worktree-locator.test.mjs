import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const ROOT = process.cwd();
const SCRIPT = join(ROOT, 'scripts/multi-repo-worktree.mjs');
const CONTROL = join(ROOT, 'scripts/control-plane.mjs');

function runGit(args, cwd) { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
function runNode(script, args, cwd) { return JSON.parse(execFileSync(process.execPath, [script, ...args], { cwd, encoding: 'utf8' })); }
function initRepo(root, name) {
  const repo = join(root, name); mkdirSync(repo, { recursive: true });
  runGit(['init', '-b', 'main'], repo);
  runGit(['config', 'user.email', 'test@example.invalid'], repo);
  runGit(['config', 'user.name', 'Test'], repo);
  writeFileSync(join(repo, 'README.md'), `${name}\n`);
  runGit(['add', 'README.md'], repo); runGit(['commit', '-m', 'base'], repo);
  return repo;
}

describe('registry-backed multi-repo locator', () => {
  it('allocates every default start as a new isolated requirement', () => {
    const outer = mkdtempSync(join(tmpdir(), 'chisel-isolated-'));
    try {
      const repo = initRepo(outer, 'service');
      const first = runNode(CONTROL, ['--new', '--project-root', repo, '--idea', 'team-kanban'], repo);
      writeFileSync(join(first.idea_dir, 'requirement.md'), 'first requirement\n');
      const second = runNode(CONTROL, ['--new', '--project-root', repo, '--idea', 'team-kanban'], repo);

      assert.equal(first.allocated_idea_name, 'team-kanban');
      assert.equal(second.allocated_idea_name, 'team-kanban-2');
      assert.equal(first.reused, false);
      assert.equal(second.reused, false);
      assert.notEqual(first.idea_dir, second.idea_dir);
      assert.equal(existsSync(join(second.idea_dir, 'requirement.md')), false);

      const resumed = runNode(CONTROL, ['--resume', '--project-root', repo, '--idea', 'team-kanban'], repo);
      assert.equal(resumed.idea_dir, first.idea_dir);
      assert.equal(readFileSync(join(resumed.idea_dir, 'requirement.md'), 'utf8'), 'first requirement\n');

      assert.throws(
        () => execFileSync(process.execPath, [CONTROL, '--resume', '--project-root', repo, '--idea', 'missing'], { cwd: repo, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }),
        /cannot resume unknown idea: missing/,
      );
    } finally { rmSync(outer, { recursive: true, force: true }); }
  });

  it('supports an outer non-Git workspace and resumes from a linked worktree', () => {
    const outer = mkdtempSync(join(tmpdir(), 'chisel-outer-'));
    try {
      const repoA = initRepo(outer, 'service-a');
      const repoB = initRepo(outer, 'service-b');
      const created = runNode(SCRIPT, ['--create', 'multi-change', '--workspace', outer, '--repos', `${repoA},${repoB}`, '--branch', 'feat/multi-change'], outer);
      assert.equal(created.schema_version, 3);
      assert.equal(created.repos.length, 2);
      for (const record of created.repos) {
        assert.ok(existsSync(record.worktree_path));
        assert.match(runGit(['worktree', 'list', '--porcelain'], record.repo_path), new RegExp(record.worktree_path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      }
      const firstWorktree = created.repos[0].worktree_path;
      const located = runNode(CONTROL, ['--locate', '--project-root', firstWorktree, '--idea', 'multi-change'], outer);
      assert.equal(located.record.branch, 'feat/multi-change');
      assert.equal(located.record.workspace_root, outer);
      const status = runNode(SCRIPT, ['--status', 'multi-change', '--project-root', firstWorktree], firstWorktree);
      assert.equal(status.repos.length, 2);
      assert.ok(status.repos.every(repo => repo.status === 'active'));

      const converted = runNode(SCRIPT, ['--convert', 'multi-change', '--project-root', outer], outer);
      assert.ok(converted.repos.every(repo => repo.status === 'converted'));
      assert.equal(runGit(['branch', '--show-current'], repoA), 'main');
      assert.ok(runGit(['branch', '--list', 'feat/multi-change'], repoA).includes('feat/multi-change'));
      const after = runNode(CONTROL, ['--locate', '--project-root', outer, '--idea', 'multi-change'], outer);
      assert.equal(after.record.lifecycle, 'converted');
      assert.ok(after.record.repos.every(repo => repo.lifecycle === 'converted'));
      const decision = JSON.parse(readFileSync(join(after.idea_dir, 'worktree-decision.json'), 'utf8'));
      assert.equal(decision.lifecycle, 'converted');
      assert.ok(decision.repos.every(repo => repo.lifecycle === 'converted'));
    } finally { rmSync(outer, { recursive: true, force: true }); }
  });

  it('reads legacy v1/v2 registry records without changing their shape', () => {
    const outer = mkdtempSync(join(tmpdir(), 'chisel-legacy-'));
    try {
      const control = join(outer, '.chisel'); mkdirSync(control, { recursive: true });
      writeFileSync(join(control, 'registry.json'), JSON.stringify({ schema_version: 2, ideas: { old: { idea_dir: join(control, 'old'), branch: 'feat/old', repos: [] } } }));
      const located = runNode(CONTROL, ['--locate', '--project-root', outer, '--idea', 'old'], outer);
      assert.equal(located.record.branch, 'feat/old');
      assert.equal(located.control_root, control);
      assert.equal(JSON.parse(readFileSync(join(control, 'registry.json'), 'utf8')).schema_version, 2);
    } finally { rmSync(outer, { recursive: true, force: true }); }
  });

  it('adds the runtime control directory to the repository-local Git exclude', () => {
    const outer = mkdtempSync(join(tmpdir(), 'chisel-local-exclude-'));
    try {
      const repo = initRepo(outer, 'service');
      execFileSync(process.execPath, [CONTROL, '--project-root', repo, '--idea', 'new-feature'], { cwd: repo, encoding: 'utf8' });
      mkdirSync(join(repo, '.chisel', 'new-feature'), { recursive: true });
      writeFileSync(join(repo, '.chisel', 'new-feature', 'workflow-state.yaml'), 'current_step: receive-requirement\n');
      assert.equal(runGit(['check-ignore', '.chisel/new-feature/workflow-state.yaml'], repo), '.chisel/new-feature/workflow-state.yaml');
      assert.doesNotMatch(runGit(['status', '--short', '--untracked-files=all'], repo), /\.chisel/);
    } finally { rmSync(outer, { recursive: true, force: true }); }
  });
});
