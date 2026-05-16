#!/usr/bin/env node
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readFrontmatter, readTaskState, taskStateFile } from './workflow-lib.mjs';

function parseListSection(text, heading) {
  const regex = new RegExp(`^###?\\s+${heading}[\\s\\S]*?\\n([\\s\\S]*?)(?=\\n###?\\s|$)`, 'm');
  const match = text.match(regex);
  if (!match) return [];
  return match[1].split('\n')
    .map(line => line.replace(/^[-*]\s*/, '').trim())
    .filter(line => line && !line.startsWith('#'));
}

function getTaskScope(ideaDir, taskId) {
  const state = readTaskState(taskStateFile(ideaDir));
  const task = state.tasks[taskId];
  if (!task) return { expected: [], forbidden: [] };

  const expectedFromState = task.expected_files || [];

  const taskFilePath = join(ideaDir, task.file);
  let expectedFromFile = [];
  let forbidden = [];

  if (existsSync(taskFilePath)) {
    const content = readFileSync(taskFilePath, 'utf8');
    const fm = readFrontmatter(content);
    if (Array.isArray(fm.expected_files) && fm.expected_files.length > 0) {
      expectedFromFile = fm.expected_files;
    }
    forbidden = parseListSection(content, 'Forbidden Files / Areas');
  }

  const expected = expectedFromFile.length > 0 ? expectedFromFile : expectedFromState;
  return { expected, forbidden };
}

function getWikiForbiddenZones(projectRoot) {
  const fzPath = join(projectRoot, '.chisel', 'wiki', 'forbidden-zones.md');
  if (!existsSync(fzPath)) return [];

  const content = readFileSync(fzPath, 'utf8');
  const zones = [];
  const regex = /\*\*范围[：:]\*\*\s*(.+)/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    zones.push(match[1].trim());
  }
  return zones;
}

function getChangedFiles() {
  try {
    const output = execFileSync('git', ['diff', '--name-only'], { encoding: 'utf8' });
    return output.split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function matchesScope(file, patterns) {
  return patterns.some(pattern => {
    if (file === pattern) return true;
    if (pattern.endsWith('/') && file.startsWith(pattern)) return true;
    if (pattern.endsWith('/*') && file.startsWith(pattern.slice(0, -1))) return true;
    if (pattern.endsWith('/**') && file.startsWith(pattern.slice(0, -2))) return true;
    return false;
  });
}

function check(ideaDir, taskId, projectRoot) {
  const { expected, forbidden } = getTaskScope(ideaDir, taskId);
  const wikiForbidden = getWikiForbiddenZones(projectRoot);
  const allForbidden = [...new Set([...forbidden, ...wikiForbidden])];
  const changedFiles = getChangedFiles();

  const violations = [];

  for (const file of changedFiles) {
    if (matchesScope(file, allForbidden)) {
      violations.push({ file, type: 'forbidden', reason: 'file is in forbidden scope' });
    }
    if (expected.length > 0 && !matchesScope(file, expected)) {
      violations.push({ file, type: 'unexpected', reason: 'file is outside expected scope' });
    }
  }

  return {
    task_id: taskId,
    changed_files: changedFiles,
    expected_scope: expected,
    forbidden_scope: allForbidden,
    violations,
    pass: violations.length === 0
  };
}

function main() {
  const ideaDir = process.argv[2];
  const taskId = process.argv[3];
  const projectRoot = process.argv[4] || '.';

  if (!ideaDir || !taskId) {
    process.stderr.write('用法: scope-check.mjs <idea-dir> <task-id> [project-root]\n');
    process.exit(1);
  }

  const result = check(ideaDir, taskId, projectRoot);
  console.log(JSON.stringify(result, null, 2));

  if (!result.pass) {
    process.stderr.write(`scope violations found: ${result.violations.length}\n`);
    for (const v of result.violations) {
      process.stderr.write(`  [${v.type}] ${v.file}: ${v.reason}\n`);
    }
    process.exit(1);
  }
}

export { check as checkScope };

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
