#!/usr/bin/env node
import { existsSync, readdirSync, statSync, readFileSync } from 'node:fs';
import { join, resolve, basename, relative } from 'node:path';
import { execSync } from 'node:child_process';
import { atomicWriteFile } from './workflow-lib.mjs';

const USAGE = `用法:
  node multi-repo-worktree.mjs --detect <workspace-root>
  node multi-repo-worktree.mjs --create <idea-name> --repos <repo1,repo2,...> [--branch <branch-name>]
  node multi-repo-worktree.mjs --status <idea-name> --repos <repo1,repo2,...>
  node multi-repo-worktree.mjs --cleanup <idea-name> --repos <repo1,repo2,...>
`;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--detect') args.action = 'detect', args.workspace = argv[++i];
    else if (argv[i] === '--create') args.action = 'create', args.ideaName = argv[++i];
    else if (argv[i] === '--status') args.action = 'status', args.ideaName = argv[++i];
    else if (argv[i] === '--cleanup') args.action = 'cleanup', args.ideaName = argv[++i];
    else if (argv[i] === '--repos') args.repos = argv[++i]?.split(',').map(r => r.trim());
    else if (argv[i] === '--branch') args.branch = argv[++i];
  }
  return args;
}

function isGitRepo(dir) {
  return existsSync(join(dir, '.git'));
}

function detectGitRepos(workspaceRoot, maxDepth = 2) {
  const repos = [];
  function scan(dir, depth) {
    if (depth > maxDepth) return;
    if (isGitRepo(dir)) {
      repos.push(dir);
      return;
    }
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (entry.startsWith('.') || entry === 'node_modules') continue;
        const full = join(dir, entry);
        try {
          if (statSync(full).isDirectory()) scan(full, depth + 1);
        } catch { /* permission denied */ }
      }
    } catch { /* permission denied */ }
  }
  scan(resolve(workspaceRoot), 0);
  return repos;
}

function getBaseCommit(repoPath) {
  try {
    return execSync('git rev-parse HEAD', { cwd: repoPath, encoding: 'utf8' }).trim();
  } catch { return null; }
}

function getDefaultBranch(repoPath) {
  try {
    const ref = execSync('git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || echo refs/heads/main', { cwd: repoPath, encoding: 'utf8' }).trim();
    return ref.replace(/^refs\/(?:remotes\/origin|heads)\//, '');
  } catch { return 'main'; }
}

function worktreePath(repoPath, branchName) {
  const safeName = branchName.replace(/\//g, '-');
  return join(repoPath, '.claude', 'worktrees', safeName);
}

function createWorktree(repoPath, branchName) {
  const wtPath = worktreePath(repoPath, branchName);
  if (existsSync(wtPath)) {
    return { repo: repoPath, worktree_path: wtPath, status: 'already_exists' };
  }
  const baseBranch = getDefaultBranch(repoPath);
  try {
    execSync(`git worktree add -b "${branchName}" "${wtPath}" "${baseBranch}"`, { cwd: repoPath, stdio: 'pipe' });
    const baseCommit = getBaseCommit(wtPath);
    return { repo: repoPath, worktree_path: wtPath, branch: branchName, base_commit: baseCommit, status: 'created' };
  } catch (e) {
    try {
      execSync(`git worktree add "${wtPath}" "${branchName}"`, { cwd: repoPath, stdio: 'pipe' });
      const baseCommit = getBaseCommit(wtPath);
      return { repo: repoPath, worktree_path: wtPath, branch: branchName, base_commit: baseCommit, status: 'attached_existing_branch' };
    } catch (e2) {
      return { repo: repoPath, status: 'error', error: e2.message };
    }
  }
}

function getWorktreeStatus(repoPath, branchName) {
  const wtPath = worktreePath(repoPath, branchName);
  if (!existsSync(wtPath)) {
    return { repo: repoPath, worktree_path: wtPath, status: 'not_found' };
  }
  try {
    const status = execSync('git status --porcelain', { cwd: wtPath, encoding: 'utf8' }).trim();
    const head = execSync('git rev-parse HEAD', { cwd: wtPath, encoding: 'utf8' }).trim();
    const ahead = execSync(`git rev-list ${getDefaultBranch(repoPath)}..HEAD --count`, { cwd: wtPath, encoding: 'utf8' }).trim();
    return {
      repo: repoPath,
      worktree_path: wtPath,
      status: 'active',
      head_commit: head,
      commits_ahead: Number(ahead),
      has_uncommitted: status.length > 0
    };
  } catch (e) {
    return { repo: repoPath, worktree_path: wtPath, status: 'error', error: e.message };
  }
}

function cleanupWorktree(repoPath, branchName) {
  const wtPath = worktreePath(repoPath, branchName);
  if (!existsSync(wtPath)) {
    return { repo: repoPath, status: 'not_found' };
  }
  try {
    execSync(`git worktree remove "${wtPath}" --force`, { cwd: repoPath, stdio: 'pipe' });
    try {
      execSync(`git branch -D "${branchName}"`, { cwd: repoPath, stdio: 'pipe' });
    } catch { /* branch may not exist or may be checked out elsewhere */ }
    return { repo: repoPath, worktree_path: wtPath, status: 'removed' };
  } catch (e) {
    return { repo: repoPath, worktree_path: wtPath, status: 'error', error: e.message };
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.action) {
    process.stderr.write(USAGE);
    process.exit(1);
  }

  switch (args.action) {
    case 'detect': {
      if (!args.workspace) {
        process.stderr.write('--detect requires workspace root path\n');
        process.exit(1);
      }
      const repos = detectGitRepos(args.workspace);
      console.log(JSON.stringify({
        workspace: resolve(args.workspace),
        repos: repos.map(r => ({
          path: r,
          relative: relative(resolve(args.workspace), r),
          name: basename(r),
          default_branch: getDefaultBranch(r),
          head_commit: getBaseCommit(r)
        }))
      }, null, 2));
      break;
    }

    case 'create': {
      if (!args.ideaName || !args.repos?.length) {
        process.stderr.write('--create requires idea-name and --repos\n');
        process.exit(1);
      }
      const branchName = args.branch || `feat/${args.ideaName}`;
      const results = args.repos.map(repo => createWorktree(resolve(repo), branchName));
      console.log(JSON.stringify({
        idea_name: args.ideaName,
        branch_name: branchName,
        repos: results
      }, null, 2));
      break;
    }

    case 'status': {
      if (!args.ideaName || !args.repos?.length) {
        process.stderr.write('--status requires idea-name and --repos\n');
        process.exit(1);
      }
      const branchName = args.branch || `feat/${args.ideaName}`;
      const results = args.repos.map(repo => getWorktreeStatus(resolve(repo), branchName));
      console.log(JSON.stringify({ idea_name: args.ideaName, branch_name: branchName, repos: results }, null, 2));
      break;
    }

    case 'cleanup': {
      if (!args.ideaName || !args.repos?.length) {
        process.stderr.write('--cleanup requires idea-name and --repos\n');
        process.exit(1);
      }
      const branchName = args.branch || `feat/${args.ideaName}`;
      const results = args.repos.map(repo => cleanupWorktree(resolve(repo), branchName));
      console.log(JSON.stringify({ idea_name: args.ideaName, branch_name: branchName, repos: results }, null, 2));
      break;
    }

    default:
      process.stderr.write(USAGE);
      process.exit(1);
  }
}

main();
