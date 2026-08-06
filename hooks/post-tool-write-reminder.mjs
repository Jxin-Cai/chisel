#!/usr/bin/env node
// PostToolUse hook: injects workflow reminders after Write to chisel control plane paths.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { controlRoot } from '../scripts/control-plane.mjs';

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function getCurrentStep(ideaDir) {
  const wsFile = join(ideaDir, 'workflow-state.yaml');
  if (!existsSync(wsFile)) return null;
  const text = readFileSync(wsFile, 'utf8');
  return text.match(/^current_step:\s*(.+)$/m)?.[1]?.trim() || null;
}

function injectContext(context) {
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: context
    }
  };
  console.log(JSON.stringify(output));
}

function main() {
  const raw = readStdin();
  if (!raw) return;

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }

  const filePath = input.tool_input?.file_path;
  if (!filePath) return;

  const cwd = input.cwd || process.cwd();
  const chiselDir = controlRoot(cwd);
  const absPath = resolve(cwd, filePath);
  const relPath = relative(chiselDir, absPath);

  if (relPath === '..' || relPath.startsWith('../') || relPath.startsWith('..\\')) return;

  const parts = relPath.split(/[/\\]/);
  if (parts.length < 2) return;
  const ideaName = parts[0];
  if (ideaName === 'wiki' || ideaName === 'wiki-candidates') return;

  const ideaDir = join(chiselDir, ideaName);
  const subPath = parts.slice(1).join('/');
  const step = getCurrentStep(ideaDir);

  const deliverableDirs = ['as-is/', 'to-be/', 'tasks/', 'task-reports/', 'cr/'];
  if (deliverableDirs.some(d => subPath.startsWith(d))) {
    const reminder = step
      ? `产物已写入: ${relPath}. 当前步骤: ${step}. 完成当前阶段全部产物后，运行 gate-check.mjs 验证 postcondition 再继续下一步。`
      : `产物已写入: ${relPath}. 完成当前阶段全部产物后，运行 gate-check.mjs 验证 postcondition 再继续下一步。`;
    injectContext(reminder);
    return;
  }

  if (subPath.startsWith('confirmations/')) {
    injectContext('确认文件已写入。验证用户是否已明确批准后再继续下一步。不要在用户未确认的情况下创建确认文件。');
    return;
  }
}

main();
