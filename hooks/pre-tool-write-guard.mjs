#!/usr/bin/env node
// PreToolUse hook: guards Write/Edit to protected .chisel/ paths.
// Fail-open: non-chisel paths are always allowed.
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';

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

function deny(reason) {
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  };
  console.log(JSON.stringify(output));
}

function allowWithContext(context) {
  if (!context) return;
  const output = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
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
  const absPath = resolve(cwd, filePath);
  const relPath = relative(cwd, absPath);

  // Only guard .chisel/ paths
  if (!relPath.startsWith('.chisel/') && !relPath.startsWith('.chisel\\')) return;

  // Extract idea directory name from path like .chisel/<idea-name>/...
  const parts = relPath.split(/[/\\]/);
  if (parts.length < 3) return;
  const ideaName = parts[1];
  // Skip wiki directories
  if (ideaName === 'wiki' || ideaName === 'wiki-candidates') return;

  const ideaDir = join(cwd, '.chisel', ideaName);
  const subPath = parts.slice(2).join('/');

  // Rule 1: task-workflow-state.yaml must not be written directly
  if (subPath === 'task-workflow-state.yaml') {
    deny('task-workflow-state.yaml must be modified through workflow-status.mjs, not written directly.');
    return;
  }

  // Rule 2: confirmations/ can only be written during *:confirm steps
  if (subPath.startsWith('confirmations/')) {
    const step = getCurrentStep(ideaDir);
    if (step && !step.includes(':confirm') && step !== 'receive-requirement') {
      deny(`Confirmation files can only be written during confirm steps. Current step: ${step}`);
      return;
    }
  }

  // For all other .chisel/ paths, allow with context reminder
  const step = getCurrentStep(ideaDir);
  if (step) {
    allowWithContext(`当前步骤: ${step}. 写入 .chisel/ 产物后记得运行 gate-check.mjs 验证 postcondition.`);
  }
}

main();
