#!/usr/bin/env node
/**
 * Delivery operations.  All mutating git calls use execFileSync argument
 * arrays.  A merge is performed in a disposable integration worktree, never
 * by checking the target branch out in the developer's checkout.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { locateIdea } from './control-plane.mjs';

const USAGE = `用法:
  node branch-merge.mjs --convert <branch-name> --repo <repo-path>
  node branch-merge.mjs --merge --source <branch> --target <branch> --repo <repo-path> [--confirm] [--push]
  node branch-merge.mjs --continue --repo <repo-path> --integration-worktree <path> [--confirm] [--push]
  node branch-merge.mjs --abort --repo <repo-path> --integration-worktree <path> [--cleanup]
  node branch-merge.mjs --analyze --repo <repo-path> [--integration-worktree <path>]
`;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === '--convert') args.action = 'convert', args.branch = argv[++i];
    else if (value === '--merge') args.action = 'merge';
    else if (value === '--continue') args.action = 'continue';
    else if (value === '--abort') args.action = 'abort';
    else if (value === '--analyze') args.action = 'analyze';
    else if (value === '--source') args.source = argv[++i];
    else if (value === '--target') args.target = argv[++i];
    else if (value === '--repo') args.repo = argv[++i];
    else if (value === '--integration-worktree') args.integrationWorktree = argv[++i];
    else if (value === '--remote') args.remote = argv[++i];
    else if (value === '--idea') args.ideaName = argv[++i];
    else if (value === '--confirm') args.confirm = true;
    else if (value === '--push') args.push = true;
    else if (value === '--cleanup') args.cleanup = true;
    else if (value === '--verify-command-json') {
      try {
        const parsed = JSON.parse(argv[++i]);
        if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some(item => typeof item !== 'string' || item.length === 0)) throw new Error('must be a non-empty string argv array');
        args.verifyCommand = parsed;
      } catch (error) { throw new Error(`--verify-command-json ${error.message}`); }
    }
  }
  return args;
}

function git(args, cwd, { allowFail = false } = {}) {
  try { return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
  catch (error) { if (allowFail) return ''; throw error; }
}

function worktreeEntries(repoPath) {
  const output = git(['worktree', 'list', '--porcelain'], repoPath, { allowFail: true });
  const entries = [];
  let current = null;
  for (const line of output.split('\n')) {
    if (line.startsWith('worktree ')) { if (current) entries.push(current); current = { path: line.slice(9) }; }
    else if (current && line.startsWith('HEAD ')) current.head = line.slice(5);
    else if (current && line.startsWith('branch ')) current.branch = line.slice(7).replace(/^refs\/heads\//, '');
  }
  if (current) entries.push(current);
  return entries;
}

function worktreeForBranch(repoPath, branch) {
  return worktreeEntries(repoPath).find(entry => entry.branch === branch)?.path || null;
}

function defaultIntegrationPath(repoPath, source, target) {
  const safe = `${source}--${target}`.replace(/[^A-Za-z0-9._-]+/g, '-');
  const repoKey = basename(resolve(repoPath)).replace(/[^A-Za-z0-9._-]+/g, '-');
  return join(dirname(resolve(repoPath)), '.chisel', 'integration', `${repoKey}-${safe}`);
}

function ensureIntegrationWorktree(repoPath, target, source, requested) {
  const path = resolve(requested || defaultIntegrationPath(repoPath, source, target));
  const existing = worktreeEntries(repoPath).find(entry => entry.path === path);
  if (existing) return path;
  mkdirSync(dirname(path), { recursive: true });
  git(['worktree', 'add', '--detach', path, target], repoPath);
  return path;
}

function branchCommit(repoPath, ref) {
  const value = git(['rev-parse', ref], repoPath, { allowFail: true });
  return value || null;
}

function conflictFiles(worktree) {
  return git(['diff', '--name-only', '--diff-filter=U'], worktree, { allowFail: true }).split('\n').filter(Boolean);
}

function conflictDetails(worktree, files, source, target) {
  const base = git(['merge-base', source, target], worktree, { allowFail: true });
  return files.map(file => ({
    file,
    type: 'true_conflict',
    base,
    ours: git(['rev-parse', 'HEAD'], worktree, { allowFail: true }),
    theirs: branchCommit(worktree, source),
    stages: {
      base: git(['show', `:1:${file}`], worktree, { allowFail: true }),
      ours: git(['show', `:2:${file}`], worktree, { allowFail: true }),
      theirs: git(['show', `:3:${file}`], worktree, { allowFail: true }),
    },
    recommendation: 'inspect base/ours/theirs, resolve, run verification, then continue',
  }));
}

function conflictReportPath(worktree) {
  // Keep diagnostics outside the integration worktree so git add -A cannot
  // accidentally deliver the report to the target branch.
  return join(dirname(worktree), '.chisel-merge-receipts', `${basename(worktree)}-conflict.json`);
}

function conflictReport({ repoPath, worktree, source, target, targetHead, sourceHead, files }) {
  const report = {
    schema_version: 1,
    status: 'conflicts_detected',
    repo: resolve(repoPath),
    integration_worktree: resolve(worktree),
    source,
    target,
    base: git(['merge-base', source, target], worktree, { allowFail: true }),
    ours: git(['rev-parse', 'HEAD'], worktree, { allowFail: true }),
    theirs: sourceHead,
    target_head_before_merge: targetHead,
    conflicts: conflictDetails(worktree, files, source, target),
    next: { resolve: 'chisel-branch conflict-resolve', continue: `branch-merge.mjs --continue --repo ${resolve(repoPath)} --integration-worktree ${resolve(worktree)}`, abort: `branch-merge.mjs --abort --repo ${resolve(repoPath)} --integration-worktree ${resolve(worktree)}` },
    created_at: new Date().toISOString(),
  };
  const reportFile = conflictReportPath(worktree);
  mkdirSync(dirname(reportFile), { recursive: true });
  report.report_file = reportFile;
  writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
  return report;
}

function pushSafely(worktree, remote, target, expectedRemoteHead) {
  const remoteRef = `${remote}/${target}`;
  git(['fetch', remote, target], worktree);
  const actualRemoteHead = branchCommit(worktree, `refs/remotes/${remote}/${target}`);
  if (expectedRemoteHead && actualRemoteHead !== expectedRemoteHead) return { status: 'remote_target_drift', remote, target, expected: expectedRemoteHead, actual: actualRemoteHead };
  git(['push', remote, `HEAD:refs/heads/${target}`], worktree);
  return { status: 'pushed', remote, target, remote_ref: remoteRef, head: branchCommit(worktree, 'HEAD') };
}

function verifyIntegration(worktree, verifyCommand = null) {
  const unmerged = conflictFiles(worktree);
  if (unmerged.length) return { status: 'fail', reason: 'unmerged files remain', files: unmerged };
  const checks = [];
  try { git(['diff', '--check'], worktree); checks.push({ command: ['git', 'diff', '--check'], status: 'pass' }); }
  catch (error) { return { status: 'fail', checks: [{ command: ['git', 'diff', '--check'], status: 'fail', reason: error.message }] }; }
  if (verifyCommand) {
    try { execFileSync(verifyCommand[0], verifyCommand.slice(1), { cwd: worktree, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }); checks.push({ command: verifyCommand, status: 'pass' }); }
    catch (error) { checks.push({ command: verifyCommand, status: 'fail', reason: error.message }); return { status: 'fail', checks }; }
  }
  return { status: 'pass', checks };
}

function persistReceipt(args, receipt) {
  if (!args.ideaName || !args.repo) return receipt;
  try {
    const located = locateIdea(args.repo, args.ideaName);
    const deliveryDir = join(located.idea_dir, 'delivery');
    mkdirSync(deliveryDir, { recursive: true });
    const file = join(deliveryDir, `${basename(resolve(args.repo))}.json`);
    writeFileSync(file, `${JSON.stringify({ schema_version: 1, ...receipt, updated_at: new Date().toISOString() }, null, 2)}\n`);
    return { ...receipt, delivery_receipt: file };
  } catch (error) {
    return { ...receipt, delivery_receipt_error: error.message };
  }
}

function merge(args) {
  if (!args.source || !args.target || !args.repo) throw new Error('--merge requires --source --target --repo');
  if (args.push && !args.confirm) return persistReceipt(args, { status: 'confirmation_required', source: args.source, target: args.target, message: 'external push requires explicit --confirm from chisel-branch' });
  const repoPath = resolve(args.repo);
  const targetHead = branchCommit(repoPath, args.target);
  const sourceHead = branchCommit(repoPath, args.source);
  if (!targetHead || !sourceHead) return persistReceipt(args, { status: 'ref_not_found', source: args.source, target: args.target });
  const integration = ensureIntegrationWorktree(repoPath, args.target, args.source, args.integrationWorktree);
  const existingConflicts = conflictFiles(integration);
  if (existingConflicts.length) return persistReceipt(args, conflictReport({ repoPath, worktree: integration, source: args.source, target: args.target, targetHead, sourceHead, files: existingConflicts }));
  try { git(['merge', '--no-commit', '--no-ff', args.source], integration); }
  catch { /* inspect the index below */ }
  const files = conflictFiles(integration);
  if (files.length) return persistReceipt(args, conflictReport({ repoPath, worktree: integration, source: args.source, target: args.target, targetHead, sourceHead, files }));
  const verification = verifyIntegration(integration, args.verifyCommand);
  if (verification.status !== 'pass') return persistReceipt(args, { status: 'verification_failed', integration_worktree: integration, verification });
  if (!args.confirm) return persistReceipt(args, { status: 'confirmation_required', source: args.source, target: args.target, integration_worktree: integration, verification, message: 'review the integration worktree and rerun with --confirm' });
  git(['commit', '--no-edit', '-m', `merge ${args.source} into ${args.target}`], integration);
  const receipt = { status: 'merged', source: args.source, target: args.target, repo: repoPath, integration_worktree: integration, target_head_before_merge: targetHead, merge_commit: branchCommit(integration, 'HEAD'), verification };
  if (args.push) {
    receipt.push = pushSafely(integration, args.remote || 'origin', args.target, targetHead);
    if (receipt.push.status !== 'pushed') { receipt.status = 'push_failed'; receipt.delivery_status = 'push_failed'; }
  }
  return persistReceipt(args, receipt);
}

function continueMerge(args) {
  if (!args.repo || !args.integrationWorktree) throw new Error('--continue requires --repo and --integration-worktree');
  if (!args.confirm) return persistReceipt(args, { status: 'confirmation_required', integration_worktree: resolve(args.integrationWorktree), message: 'continue/push requires explicit --confirm from chisel-branch' });
  const repoPath = resolve(args.repo);
  const worktree = resolve(args.integrationWorktree);
  const reportFile = conflictReportPath(worktree);
  const legacyReportFile = join(worktree, '.chisel-merge-conflict.json');
  const prior = existsSync(reportFile)
    ? JSON.parse(readFileSync(reportFile, 'utf8'))
    : existsSync(legacyReportFile) ? JSON.parse(readFileSync(legacyReportFile, 'utf8')) : {};
  const verification = verifyIntegration(worktree, args.verifyCommand);
  if (verification.status !== 'pass') return persistReceipt(args, { status: 'conflicts_remaining', integration_worktree: worktree, verification });
  git(['add', '-A'], worktree);
  git(['commit', '--no-edit', '-m', prior.source && prior.target ? `merge ${prior.source} into ${prior.target}` : 'merge integration'], worktree);
  const result = { status: 'merged', repo: repoPath, integration_worktree: worktree, source: prior.source, target: prior.target, merge_commit: branchCommit(worktree, 'HEAD'), verification };
  if (args.push && prior.target) {
    result.push = pushSafely(worktree, args.remote || 'origin', prior.target, prior.target_head_before_merge);
    if (result.push.status !== 'pushed') { result.status = 'push_failed'; result.delivery_status = 'push_failed'; }
  }
  return persistReceipt(args, result);
}

function abortMerge(args) {
  if (!args.repo || !args.integrationWorktree) throw new Error('--abort requires --repo and --integration-worktree');
  const repoPath = resolve(args.repo);
  const worktree = resolve(args.integrationWorktree);
  git(['merge', '--abort'], worktree, { allowFail: true });
  let removed = false;
  if (args.cleanup) { git(['worktree', 'remove', '--force', worktree], repoPath); removed = true; }
  return persistReceipt(args, { status: 'aborted', repo: repoPath, integration_worktree: worktree, cleaned: removed, development_branch_preserved: true });
}

function convert(args) {
  if (!args.branch || !args.repo) throw new Error('--convert requires branch and --repo');
  const repoPath = resolve(args.repo);
  const worktree = worktreeForBranch(repoPath, args.branch);
  if (!worktree) return { status: 'worktree_not_found', repo: repoPath, branch: args.branch };
  const dirty = git(['status', '--porcelain'], worktree, { allowFail: true });
  if (dirty) return { status: 'uncommitted_changes', repo: repoPath, branch: args.branch, worktree_path: worktree, dirty_files: dirty.split('\n').filter(Boolean) };
  git(['worktree', 'remove', worktree], repoPath);
  return { status: 'converted', repo: repoPath, branch: args.branch, worktree_removed: worktree, development_branch_preserved: true };
}

function analyze(args) {
  const worktree = resolve(args.integrationWorktree || args.repo || '.');
  const files = conflictFiles(worktree);
  return files.length ? conflictReport({ repoPath: args.repo || worktree, worktree, source: args.source || 'unknown', target: args.target || 'unknown', targetHead: branchCommit(worktree, 'HEAD'), sourceHead: branchCommit(worktree, args.source || 'HEAD'), files }) : { status: 'no_conflicts', repo: resolve(args.repo || worktree), integration_worktree: worktree };
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (!args.action) { process.stderr.write(USAGE); process.exitCode = 1; return; }
  try {
    const result = args.action === 'merge' ? merge(args) : args.action === 'continue' ? continueMerge(args) : args.action === 'abort' ? abortMerge(args) : args.action === 'convert' ? convert(args) : analyze(args);
    console.log(JSON.stringify(result, null, 2));
    if (['verification_failed', 'conflicts_remaining', 'remote_target_drift', 'push_failed'].includes(result.status)) process.exitCode = 1;
  } catch (error) { process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exitCode = 1; }
}

if (import.meta.url === `file://${process.argv[1]}`) main();
