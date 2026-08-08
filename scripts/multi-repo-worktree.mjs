#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { controlRoot, locateIdea, registerIdea, writeControlRegistry } from './control-plane.mjs';

const USAGE = `用法:
  node multi-repo-worktree.mjs --detect <workspace-root>
  node multi-repo-worktree.mjs --create <idea-name> --repos <repo1,repo2,...> [--workspace <outer>] [--branch <branch-name>]
  node multi-repo-worktree.mjs --locate <idea-name> [--project-root <path>]
  node multi-repo-worktree.mjs --resume <idea-name> [--project-root <path>]
  node multi-repo-worktree.mjs --status <idea-name> [--repos <repo1,repo2,...>]
  node multi-repo-worktree.mjs --convert <idea-name> [--repos <repo1,repo2,...>]
  node multi-repo-worktree.mjs --cleanup <idea-name> [--repos <repo1,repo2,...>] [--delete-branch]
`;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--detect') args.action = 'detect', args.workspace = argv[++i];
    else if (value === '--create') args.action = 'create', args.ideaName = argv[++i];
    else if (value === '--locate') args.action = 'locate', args.ideaName = argv[++i];
    else if (value === '--resume') args.action = 'resume', args.ideaName = argv[++i];
    else if (value === '--status') args.action = 'status', args.ideaName = argv[++i];
    else if (value === '--convert') args.action = 'convert', args.ideaName = argv[++i];
    else if (value === '--cleanup') args.action = 'cleanup', args.ideaName = argv[++i];
    else if (value === '--repos') args.repos = argv[++i]?.split(',').map(item => item.trim()).filter(Boolean);
    else if (value === '--branch') args.branch = argv[++i];
    else if (value === '--workspace' || value === '--workspace-root' || value === '--project-root') args.workspace = argv[++i];
    else if (value === '--delete-branch') args.deleteBranch = true;
  }
  return args;
}

function git(args, cwd, { allowFail = false } = {}) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
  catch (error) { if (allowFail) return ''; throw error; }
}

function isGitRepo(dir) {
  return existsSync(join(dir, '.git')) || git(['rev-parse', '--show-toplevel'], dir, { allowFail: true }) !== '';
}

export function detectGitRepos(workspaceRoot, maxDepth = 3) {
  const repos = [];
  function scan(dir, depth) {
    if (depth > maxDepth) return;
    if (isGitRepo(dir)) { repos.push(resolve(dir)); return; }
    try {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        if (entry.isDirectory()) scan(join(dir, entry.name), depth + 1);
      }
    } catch { /* permission denied */ }
  }
  scan(resolve(workspaceRoot), 0);
  return repos;
}

export function getDefaultBranch(repoPath) {
  const remote = git(['symbolic-ref', 'refs/remotes/origin/HEAD'], repoPath, { allowFail: true });
  if (remote) return remote.replace(/^refs\/remotes\/origin\//, '');
  const current = git(['branch', '--show-current'], repoPath, { allowFail: true });
  return current || 'main';
}

function baseCommit(repoPath, ref) { return git(['rev-parse', ref], repoPath, { allowFail: true }) || null; }

function worktreeEntries(repoPath) {
  const output = git(['worktree', 'list', '--porcelain'], repoPath, { allowFail: true });
  const entries = [];
  let current = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) { if (current) entries.push(current); current = { path: line.slice(9) }; }
    else if (current && line.startsWith('HEAD ')) current.head = line.slice(5);
    else if (current && line.startsWith('branch ')) current.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (current && line === 'bare') current.bare = true;
  }
  if (current) entries.push(current);
  return entries;
}

export function resolveRecordedWorktree(repoPath, recorded = {}) {
  const entries = worktreeEntries(repoPath);
  const expected = recorded.worktree_path ? resolve(recorded.worktree_path) : '';
  return entries.find(entry => entry.path === expected)
    || entries.find(entry => recorded.branch && entry.branch === recorded.branch)
    || null;
}

function chooseWorktreePath(workspaceRoot, ideaName, repoPath, branch) {
  const safeRepo = basename(resolve(repoPath)).replace(/[^A-Za-z0-9._-]/g, '-');
  const safeIdea = ideaName.replace(/[^A-Za-z0-9._-]/g, '-');
  return join(resolve(workspaceRoot), '.chisel', 'worktrees', safeIdea, safeRepo || branch.replaceAll('/', '-'));
}

export function createWorktree({ repoPath, branch, workspaceRoot, ideaName }) {
  const repo = resolve(repoPath);
  const defaultBranch = getDefaultBranch(repo);
  const baseRef = defaultBranch;
  const existing = resolveRecordedWorktree(repo, { branch });
  if (existing) return { repo_path: repo, worktree_path: existing.path, branch, default_branch: defaultBranch, base_ref: baseRef, base_commit: baseCommit(repo, baseRef), lifecycle: 'active', status: 'already_exists' };
  const path = chooseWorktreePath(workspaceRoot, ideaName, repo, branch);
  const branchExists = Boolean(git(['show-ref', '--verify', `refs/heads/${branch}`], repo, { allowFail: true }));
  try {
    const command = branchExists ? ['worktree', 'add', path, branch] : ['worktree', 'add', '-b', branch, path, baseRef];
    git(command, repo);
    const verified = resolveRecordedWorktree(repo, { worktree_path: path, branch });
    if (!verified) throw new Error(`git worktree list did not register ${path}`);
    return { repo_path: repo, worktree_path: path, branch, default_branch: defaultBranch, base_ref: baseRef, base_commit: baseCommit(repo, baseRef), lifecycle: 'active', status: branchExists ? 'attached_existing_branch' : 'created' };
  } catch (error) {
    return { repo_path: repo, worktree_path: path, branch, default_branch: defaultBranch, base_ref: baseRef, base_commit: baseCommit(repo, baseRef), lifecycle: 'error', status: 'error', error: error.message };
  }
}

export function statusWorktree(repoPath, recorded = {}) {
  const repo = resolve(repoPath);
  const live = resolveRecordedWorktree(repo, recorded);
  if (!live) return { repo_path: repo, worktree_path: recorded.worktree_path || null, branch: recorded.branch, status: 'not_found', lifecycle: 'missing' };
  const dirty = git(['status', '--porcelain'], live.path, { allowFail: true });
  return { ...recorded, repo_path: repo, worktree_path: live.path, branch: live.branch || recorded.branch, head_commit: live.head, has_uncommitted: Boolean(dirty), status: 'active', lifecycle: 'active' };
}

function repoRecordsFromIdea(idea) {
  return Array.isArray(idea?.record?.repos) ? idea.record.repos : [];
}

function locate(args) {
  const projectRoot = args.workspace || '.';
  const located = locateIdea(projectRoot, args.ideaName);
  return { action: args.action, ...located, repos: repoRecordsFromIdea(located) };
}

function create(args) {
  if (!args.ideaName || !args.repos?.length) throw new Error('--create requires idea-name and --repos');
  const workspaceRoot = resolve(args.workspace || process.cwd());
  const branch = args.branch || `feat/${args.ideaName}`;
  const results = args.repos.map(repo => createWorktree({ repoPath: repo, branch, workspaceRoot, ideaName: args.ideaName }));
  const projectRoot = workspaceRoot;
  const ideaDir = join(controlRoot(projectRoot), args.ideaName);
  const record = { schema_version: 3, workspace_root: workspaceRoot, branch, base_branch: results[0]?.default_branch || 'main', lifecycle: results.some(result => result.status === 'error') ? 'error' : 'active', repos: results };
  registerIdea(projectRoot, args.ideaName, { ...record, idea_dir: ideaDir });
  const decision = { schema_version: 3, decision: 'worktree', decided_at: new Date().toISOString(), idea_name: args.ideaName, workspace_root: workspaceRoot, branch_name: branch, base_branch: record.base_branch, repos: results };
  const decisionFile = join(ideaDir, 'worktree-decision.json');
  mkdirSync(join(ideaDir), { recursive: true });
  writeFileSync(decisionFile, `${JSON.stringify(decision, null, 2)}\n`);
  return { action: 'create', idea_name: args.ideaName, branch_name: branch, workspace_root: workspaceRoot, idea_dir: ideaDir, schema_version: 3, repos: results };
}

function mutate(args, action) {
  const located = locateIdea(args.workspace || '.', args.ideaName);
  const records = repoRecordsFromIdea(located);
  const repos = args.repos?.length ? args.repos.map(resolve) : records.map(record => record.repo_path || record.repo);
  if (!repos.length) throw new Error(`${action} requires --repos when no registry record exists`);
  const results = repos.map(repo => {
    const recorded = records.find(item => resolve(item.repo_path || item.repo) === resolve(repo)) || { branch: args.branch || located.record?.branch };
    if (action === 'status') return statusWorktree(repo, recorded);
    const live = resolveRecordedWorktree(repo, recorded);
    if (!live) return { repo_path: resolve(repo), worktree_path: recorded.worktree_path || null, branch: recorded.branch, status: 'not_found' };
    try {
      git(['worktree', 'remove', ...(action === 'cleanup' ? ['--force'] : []), live.path], repo);
      if (action === 'cleanup' && args.deleteBranch && recorded.branch) git(['branch', '-D', recorded.branch], repo, { allowFail: true });
      return { repo_path: resolve(repo), worktree_path: live.path, branch: recorded.branch || live.branch, status: action === 'convert' ? 'converted' : 'removed', lifecycle: action === 'convert' ? 'converted' : 'cleaned' };
    } catch (error) { return { repo_path: resolve(repo), worktree_path: live.path, branch: recorded.branch || live.branch, status: 'error', error: error.message }; }
  });
  if (located.record) {
    const byRepo = new Map(results.map(result => [resolve(result.repo_path), result]));
    const updatedRepos = (records.length ? records : results).map(record => {
      const repoPath = resolve(record.repo_path || record.path || record.repo);
      const result = byRepo.get(repoPath) || record;
      const updated = { ...record, ...result, repo_path: repoPath, path: record.path || repoPath };
      if (action === 'convert' && result.status === 'converted') updated.converted_at = new Date().toISOString();
      if (action === 'cleanup' && result.status === 'removed') updated.cleaned_at = new Date().toISOString();
      return updated;
    });
    const lifecycle = action === 'status'
      ? (updatedRepos.some(repo => repo.status === 'active') ? 'active' : located.record.lifecycle)
      : action === 'convert' ? 'converted' : action === 'cleanup' ? 'cleaned' : located.record.lifecycle;
    const nextRecord = { ...located.record, schema_version: 3, lifecycle, repos: updatedRepos, updated_at: new Date().toISOString() };
    const registry = located.registry || { schema_version: 3, ideas: {} };
    writeControlRegistry(located.control_root, { ...registry, ideas: { ...(registry.ideas || {}), [args.ideaName]: nextRecord } });
    if (located.idea_dir) {
      const decisionFile = join(located.idea_dir, 'worktree-decision.json');
      if (existsSync(decisionFile)) {
        try {
          const decision = JSON.parse(readFileSync(decisionFile, 'utf8'));
          decision.repos = updatedRepos.map(repo => ({ ...repo, path: repo.path || repo.repo_path }));
          decision.lifecycle = lifecycle;
          decision.updated_at = new Date().toISOString();
          if (action === 'convert') decision.converted_at = new Date().toISOString();
          writeFileSync(decisionFile, `${JSON.stringify(decision, null, 2)}\n`);
        } catch { /* preserve legacy malformed decision for gate to report */ }
      }
    }
  }
  return { action, idea_name: args.ideaName, branch_name: args.branch || located.record?.branch, idea_dir: located.idea_dir, schema_version: 3, repos: results };
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.action) { process.stderr.write(USAGE); process.exitCode = 1; return; }
  if (args.action === 'detect') {
    const workspace = resolve(args.workspace || '.');
    console.log(JSON.stringify({ workspace, repos: detectGitRepos(workspace).map(repo => ({ path: repo, relative: relative(workspace, repo), name: basename(repo), default_branch: getDefaultBranch(repo), head_commit: baseCommit(repo, 'HEAD') })) }, null, 2));
    return;
  }
  if (!args.ideaName) { process.stderr.write(`${USAGE}\n`); process.exitCode = 1; return; }
  try {
    const result = args.action === 'create' ? create(args) : ['locate', 'resume'].includes(args.action) ? locate(args) : mutate(args, args.action);
    console.log(JSON.stringify(result, null, 2));
  } catch (error) { process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exitCode = 1; }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
