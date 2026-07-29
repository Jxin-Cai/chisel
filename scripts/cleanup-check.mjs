#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

function getBaseRef(ideaDir) {
  const wdPath = join(ideaDir, 'worktree-decision.json');
  if (!existsSync(wdPath)) return null;
  try {
    const wd = JSON.parse(readFileSync(wdPath, 'utf8'));
    return wd.base_ref || wd.base_branch || null;
  } catch { return null; }
}

function getChangedFiles(baseRef) {
  try {
    const cmd = baseRef ? `git diff --name-only ${baseRef}...HEAD` : 'git diff --name-only HEAD~1';
    return execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim().split('\n').filter(Boolean);
  } catch { return []; }
}

function scanFile(filePath) {
  if (!existsSync(filePath)) return [];
  const content = readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  const issues = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    if (/\bconsole\.(log|debug|info)\s*\(/.test(line) && !/\/\/.*console/.test(line) && !/\/\*.*console/.test(line) && !/['"`].*console\.(log|debug|info)/.test(line)) {
      const isStandalone = /^\s*console\.(log|debug|info)\s*\(/.test(line);
      issues.push({ file: filePath, line: lineNum, type: 'console_log', auto_fixable: isStandalone, text: line.trim() });
    }
    if (/^\s*debugger\s*;?\s*$/.test(line)) {
      issues.push({ file: filePath, line: lineNum, type: 'debugger', auto_fixable: true, text: line.trim() });
    }
    if (/\b(TODO|FIXME|HACK|XXX)\b/.test(line)) {
      issues.push({ file: filePath, line: lineNum, type: 'todo_marker', auto_fixable: false, text: line.trim() });
    }
    if (/\s+$/.test(line) && line.length > 0) {
      issues.push({ file: filePath, line: lineNum, type: 'trailing_whitespace', auto_fixable: true });
    }
  }
  return issues;
}

function autoFix(filePath, issues) {
  if (!existsSync(filePath)) return 0;
  let content = readFileSync(filePath, 'utf8');
  let fixed = 0;

  const fixableLines = new Set(
    issues.filter(i => i.file === filePath && i.auto_fixable && i.type !== 'trailing_whitespace').map(i => i.line)
  );
  const hasTrailingWs = issues.some(i => i.file === filePath && i.type === 'trailing_whitespace');

  if (fixableLines.size > 0) {
    const lines = content.split('\n');
    for (const lineNum of [...fixableLines].sort((a, b) => b - a)) {
      const line = lines[lineNum - 1];
      if (/^\s*(console\.(log|debug|info)\(.*\);?\s*)$/.test(line)) {
        lines.splice(lineNum - 1, 1);
        fixed++;
      } else if (/^\s*debugger;?\s*$/.test(line)) {
        lines.splice(lineNum - 1, 1);
        fixed++;
      }
    }
    content = lines.join('\n');
  }

  if (hasTrailingWs) {
    const before = content;
    content = content.split('\n').map(l => l.trimEnd()).join('\n');
    if (content !== before) fixed++;
  }

  if (fixed > 0) writeFileSync(filePath, content);
  return fixed;
}

export function cleanupCheck(ideaDir, { autoFixMode = false, baseRef = null } = {}) {
  const ref = baseRef || getBaseRef(ideaDir);
  const changedFiles = getChangedFiles(ref).filter(f => !f.startsWith('.chisel/'));
  const codeExtensions = ['.js', '.mjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte', '.java', '.kt', '.py', '.go', '.rs'];

  const allIssues = [];
  for (const file of changedFiles) {
    if (!codeExtensions.some(ext => file.endsWith(ext))) continue;
    if (!existsSync(file)) continue;
    allIssues.push(...scanFile(file));
  }

  let fixedCount = 0;
  if (autoFixMode) {
    const fileSet = new Set(allIssues.filter(i => i.auto_fixable).map(i => i.file));
    for (const file of fileSet) {
      fixedCount += autoFix(file, allIssues.filter(i => i.file === file));
    }
  }

  // Re-scan after fix to get accurate remaining (avoids false "fixed" for inline console.log)
  const remaining = autoFixMode
    ? (() => {
        const postFixIssues = [];
        for (const file of changedFiles) {
          if (!codeExtensions.some(ext => file.endsWith(ext))) continue;
          if (!existsSync(file)) continue;
          postFixIssues.push(...scanFile(file));
        }
        return postFixIssues;
      })()
    : allIssues;

  return {
    items: remaining,
    fixed_count: fixedCount,
    remaining_count: remaining.length,
    scanned_files: changedFiles.length,
  };
}

function main() {
  const args = process.argv.slice(2);
  const ideaDir = args.find(a => !a.startsWith('--'));
  const autoFixMode = args.includes('--auto-fix');
  const baseRefIdx = args.indexOf('--base-ref');
  const baseRef = baseRefIdx !== -1 ? args[baseRefIdx + 1] : null;

  if (!ideaDir || args.includes('--help')) {
    console.log('用法: node cleanup-check.mjs <idea-dir> [--auto-fix] [--base-ref <ref>]');
    process.exit(0);
  }

  if (!existsSync(ideaDir)) {
    process.stderr.write(`idea-dir not found: ${ideaDir}\n`);
    process.exit(1);
  }

  const result = cleanupCheck(ideaDir, { autoFixMode, baseRef });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
