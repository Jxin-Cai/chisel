#!/usr/bin/env node
import { existsSync, writeFileSync, readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const USAGE = `用法:
  node branch-merge.mjs --convert <branch-name> --repo <repo-path>
  node branch-merge.mjs --merge --source <branch> --target <branch> --repo <repo-path> [--auto-resolve]
  node branch-merge.mjs --analyze --repo <repo-path>
`;

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--convert') args.action = 'convert', args.branch = argv[++i];
    else if (argv[i] === '--merge') args.action = 'merge';
    else if (argv[i] === '--analyze') args.action = 'analyze';
    else if (argv[i] === '--source') args.source = argv[++i];
    else if (argv[i] === '--target') args.target = argv[++i];
    else if (argv[i] === '--repo') args.repo = argv[++i];
    else if (argv[i] === '--auto-resolve') args.autoResolve = true;
  }
  return args;
}

function git(cmd, cwd, opts = {}) {
  try {
    return execSync(`git ${cmd}`, { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], ...opts }).trim();
  } catch (e) {
    if (opts.allowFail) return null;
    throw e;
  }
}

function getDefaultBranch(repoPath) {
  try {
    const ref = git('symbolic-ref refs/remotes/origin/HEAD', repoPath, { allowFail: true });
    if (ref) return ref.replace(/^refs\/(?:remotes\/origin|heads)\//, '');
  } catch { /* ignore */ }
  return 'main';
}

function worktreePath(repoPath, branchName) {
  const safeName = branchName.replace(/\//g, '-');
  return join(repoPath, '.claude', 'worktrees', safeName);
}

// ─── Convert ────────────────────────────────────────────────────────────────

function doConvert(args) {
  const { branch, repo } = args;
  if (!branch || !repo) {
    process.stderr.write('--convert requires <branch-name> and --repo <path>\n');
    process.exit(1);
  }
  const repoPath = resolve(repo);
  const wtPath = worktreePath(repoPath, branch);

  if (!existsSync(wtPath)) {
    console.log(JSON.stringify({ status: 'worktree_not_found', repo: repoPath, branch, expected_path: wtPath }));
    return;
  }

  const dirty = git('status --porcelain', wtPath);
  if (dirty.length > 0) {
    console.log(JSON.stringify({
      status: 'uncommitted_changes',
      repo: repoPath,
      branch,
      worktree_path: wtPath,
      dirty_files: dirty.split('\n').filter(Boolean)
    }));
    return;
  }

  const commitsAhead = git(`rev-list ${getDefaultBranch(repoPath)}..HEAD --count`, wtPath);

  try {
    execSync(`git worktree remove "${wtPath}"`, { cwd: repoPath, stdio: 'pipe' });
  } catch (e) {
    console.log(JSON.stringify({ status: 'remove_failed', repo: repoPath, branch, error: e.message }));
    return;
  }

  let checkedOut = false;
  try {
    git(`checkout ${branch}`, repoPath);
    checkedOut = true;
  } catch (e) {
    // main repo may have uncommitted changes preventing checkout
    checkedOut = false;
  }

  console.log(JSON.stringify({
    status: 'converted',
    repo: repoPath,
    branch,
    worktree_removed: wtPath,
    commits_on_branch: Number(commitsAhead),
    now_checked_out: checkedOut
  }));
}

// ─── Merge ──────────────────────────────────────────────────────────────────

function doMerge(args) {
  const { source, target, repo, autoResolve } = args;
  if (!source || !target || !repo) {
    process.stderr.write('--merge requires --source <branch> --target <branch> --repo <path>\n');
    process.exit(1);
  }
  const repoPath = resolve(repo);

  const currentBranch = git('branch --show-current', repoPath);
  if (currentBranch !== target) {
    try {
      git(`checkout ${target}`, repoPath);
    } catch (e) {
      console.log(JSON.stringify({ status: 'checkout_failed', target, error: e.message }));
      return;
    }
  }

  let mergeExitCode = 0;
  try {
    execSync(`git merge --no-commit --no-ff "${source}"`, { cwd: repoPath, stdio: 'pipe' });
  } catch (e) {
    mergeExitCode = e.status || 1;
  }

  const conflictFiles = git('diff --name-only --diff-filter=U', repoPath);

  if (!conflictFiles) {
    try {
      git('commit --no-edit -m "merge ' + source + ' into ' + target + '"', repoPath);
    } catch {
      git('commit --no-edit --allow-empty -m "merge ' + source + ' into ' + target + '"', repoPath);
    }
    console.log(JSON.stringify({ status: 'merged', source, target, conflicts: [] }));
    return;
  }

  const files = conflictFiles.split('\n').filter(Boolean);
  const analysis = analyzeConflicts(repoPath, files);

  if (autoResolve) {
    const resolved = attemptAutoResolve(repoPath, analysis);
    if (resolved.remaining_true_conflicts === 0) {
      git('add -A', repoPath);
      git(`commit -m "merge ${source} into ${target} (auto-resolved)"`, repoPath);
      console.log(JSON.stringify({
        status: 'auto_resolved',
        source,
        target,
        total_conflicts: analysis.length,
        auto_resolved: analysis.filter(a => a.type === 'auto_resolvable').length,
        details: resolved.details
      }));
    } else {
      git('merge --abort', repoPath);
      console.log(JSON.stringify({
        status: 'partial_conflict',
        source,
        target,
        total_conflicts: analysis.length,
        auto_resolvable: analysis.filter(a => a.type === 'auto_resolvable').length,
        true_conflicts: resolved.remaining_true_conflicts,
        details: analysis,
        message: '存在无法自动解决的冲突，已回滚合并'
      }));
    }
  } else {
    git('merge --abort', repoPath);
    const autoCount = analysis.filter(a => a.type === 'auto_resolvable').length;
    const trueCount = analysis.filter(a => a.type === 'true_conflict').length;
    console.log(JSON.stringify({
      status: 'conflicts_detected',
      source,
      target,
      total_conflicts: analysis.length,
      auto_resolvable: autoCount,
      true_conflicts: trueCount,
      details: analysis,
      message: autoCount > 0 && trueCount === 0
        ? '所有冲突均可自动解决，建议使用 --auto-resolve 重新执行'
        : `${trueCount} 个文件存在真实冲突需要人工介入`
    }));
  }
}

// ─── Analyze ────────────────────────────────────────────────────────────────

function doAnalyze(args) {
  const { repo } = args;
  if (!repo) {
    process.stderr.write('--analyze requires --repo <path>\n');
    process.exit(1);
  }
  const repoPath = resolve(repo);
  const conflictFiles = git('diff --name-only --diff-filter=U', repoPath);
  if (!conflictFiles) {
    console.log(JSON.stringify({ status: 'no_conflicts', repo: repoPath }));
    return;
  }
  const files = conflictFiles.split('\n').filter(Boolean);
  const analysis = analyzeConflicts(repoPath, files);
  console.log(JSON.stringify({
    status: 'analyzed',
    repo: repoPath,
    total_conflicts: analysis.length,
    auto_resolvable: analysis.filter(a => a.type === 'auto_resolvable').length,
    true_conflicts: analysis.filter(a => a.type === 'true_conflict').length,
    details: analysis
  }));
}

// ─── Conflict Analysis Core ─────────────────────────────────────────────────

function analyzeConflicts(repoPath, files) {
  return files.map(file => analyzeSingleFile(repoPath, file));
}

function analyzeSingleFile(repoPath, filePath) {
  let base, ours, theirs;
  try {
    base = git(`show :1:${filePath}`, repoPath, { allowFail: true }) || '';
    ours = git(`show :2:${filePath}`, repoPath, { allowFail: true }) || '';
    theirs = git(`show :3:${filePath}`, repoPath, { allowFail: true }) || '';
  } catch {
    return { file: filePath, type: 'true_conflict', reason: '无法读取三方版本', recommendations: ['手动解决'] };
  }

  if (!base && !ours) {
    return { file: filePath, type: 'true_conflict', reason: '双方均新增同名文件', recommendations: ['选择保留一方或手动合并内容'] };
  }
  if (!base) {
    return { file: filePath, type: 'true_conflict', reason: '文件在 base 中不存在（新文件冲突）', recommendations: ['手动合并两个版本的内容'] };
  }

  const oursRanges = getChangedLineRanges(base, ours);
  const theirsRanges = getChangedLineRanges(base, theirs);

  const overlapping = hasOverlap(oursRanges, theirsRanges);

  if (!overlapping) {
    return {
      file: filePath,
      type: 'auto_resolvable',
      reason: `双方改动在不同区域（ours: ${formatRanges(oursRanges)}, theirs: ${formatRanges(theirsRanges)})`,
      resolution_strategy: 'merge-file'
    };
  }

  const overlapRanges = findOverlapRanges(oursRanges, theirsRanges);
  return {
    file: filePath,
    type: 'true_conflict',
    reason: `双方改动重叠于 ${formatRanges(overlapRanges)}`,
    ours_changes: formatRanges(oursRanges),
    theirs_changes: formatRanges(theirsRanges),
    recommendations: generateRecommendations(filePath, oursRanges, theirsRanges, overlapRanges)
  };
}

function getChangedLineRanges(baseText, changedText) {
  const baseLines = baseText.split('\n');
  const changedLines = changedText.split('\n');
  const ranges = [];

  const tmpDir = mkdtempSync(join(tmpdir(), 'chisel-diff-'));
  const baseFile = join(tmpDir, 'base');
  const changedFile = join(tmpDir, 'changed');

  try {
    writeFileSync(baseFile, baseText);
    writeFileSync(changedFile, changedText);

    let diffOutput;
    try {
      diffOutput = execSync(`git diff --no-index --unified=0 "${baseFile}" "${changedFile}"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (e) {
      diffOutput = e.stdout || '';
    }

    const hunkRegex = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/gm;
    let match;
    while ((match = hunkRegex.exec(diffOutput)) !== null) {
      const startLine = parseInt(match[3], 10);
      const count = parseInt(match[4] || '1', 10);
      if (count > 0) {
        ranges.push({ start: startLine, end: startLine + count - 1 });
      }
    }
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }

  return ranges;
}

function hasOverlap(rangesA, rangesB) {
  for (const a of rangesA) {
    for (const b of rangesB) {
      if (a.start <= b.end && b.start <= a.end) return true;
    }
  }
  return false;
}

function findOverlapRanges(rangesA, rangesB) {
  const overlaps = [];
  for (const a of rangesA) {
    for (const b of rangesB) {
      if (a.start <= b.end && b.start <= a.end) {
        overlaps.push({ start: Math.max(a.start, b.start), end: Math.min(a.end, b.end) });
      }
    }
  }
  return overlaps;
}

function formatRanges(ranges) {
  if (!ranges || ranges.length === 0) return '(none)';
  return ranges.map(r => r.start === r.end ? `L${r.start}` : `L${r.start}-${r.end}`).join(', ');
}

function generateRecommendations(filePath, oursRanges, theirsRanges, overlapRanges) {
  const recs = [];
  if (overlapRanges.length === 1) {
    recs.push('查看冲突区域，判断双方修改意图是否兼容');
    recs.push('若意图兼容，手动合并两边改动');
    recs.push('若不兼容，根据业务优先级选择保留一方');
  } else {
    recs.push(`共 ${overlapRanges.length} 处重叠区域，建议逐一审查`);
    recs.push('对每处重叠判断是保留 source 还是 target 的版本');
  }
  return recs;
}

// ─── Auto-resolve ───────────────────────────────────────────────────────────

function attemptAutoResolve(repoPath, analysis) {
  const details = [];
  let remainingTrue = 0;

  for (const item of analysis) {
    if (item.type === 'auto_resolvable') {
      const resolved = resolveWithMergeFile(repoPath, item.file);
      if (resolved) {
        git(`add "${item.file}"`, repoPath);
        details.push({ file: item.file, resolved: true });
      } else {
        remainingTrue++;
        details.push({ file: item.file, resolved: false, reason: 'merge-file 仍产生冲突' });
      }
    } else {
      remainingTrue++;
      details.push({ file: item.file, resolved: false, reason: item.reason });
    }
  }

  return { remaining_true_conflicts: remainingTrue, details };
}

function resolveWithMergeFile(repoPath, filePath) {
  const tmpDir = mkdtempSync(join(tmpdir(), 'chisel-resolve-'));

  try {
    const base = git(`show :1:${filePath}`, repoPath, { allowFail: true }) || '';
    const ours = git(`show :2:${filePath}`, repoPath, { allowFail: true }) || '';
    const theirs = git(`show :3:${filePath}`, repoPath, { allowFail: true }) || '';

    const baseFile = join(tmpDir, 'base');
    const oursFile = join(tmpDir, 'ours');
    const theirsFile = join(tmpDir, 'theirs');

    writeFileSync(baseFile, base);
    writeFileSync(oursFile, ours);
    writeFileSync(theirsFile, theirs);

    try {
      execSync(`git merge-file "${oursFile}" "${baseFile}" "${theirsFile}"`, { stdio: 'pipe' });
    } catch (e) {
      if (e.status !== 0) return false;
    }

    const resolved = readFileSync(oursFile, 'utf8');
    const targetFile = join(repoPath, filePath);
    writeFileSync(targetFile, resolved);
    return true;
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
}

// ─── Main ───────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.action) {
    process.stderr.write(USAGE);
    process.exit(1);
  }

  switch (args.action) {
    case 'convert': doConvert(args); break;
    case 'merge': doMerge(args); break;
    case 'analyze': doAnalyze(args); break;
    default:
      process.stderr.write(USAGE);
      process.exit(1);
  }
}

main();
