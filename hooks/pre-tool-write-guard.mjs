#!/usr/bin/env node
// PreToolUse hook: guards Write/Edit to protected .chisel/ paths.
// Fail-open: non-chisel paths are always allowed.
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

  const cwd = input.cwd || process.cwd();
  const chiselDir = controlRoot(cwd);
  const toolName = input.tool_name || '';

  if (toolName === 'Bash') {
    const command = String(input.tool_input?.command || '');
    const protectedState = /(workflow-state\.yaml|task-workflow-state\.yaml|events\.ndjson)/.test(command);
    if (protectedState) {
      deny('Machine state and event history may not be mutated through Bash; use the Chisel state transition scripts.');
    }
    return;
  }

  const filePath = input.tool_input?.file_path;
  if (!filePath) return;
  const absPath = resolve(cwd, filePath);
  const relPath = relative(chiselDir, absPath);
  const localRelPath = relative(cwd, absPath);

  if ((localRelPath.startsWith('.chisel/') || localRelPath.startsWith('.chisel\\'))
      && (relPath === '..' || relPath.startsWith('../') || relPath.startsWith('..\\'))) {
    deny('Do not create a worktree-local shadow .chisel state; use the Git-common Chisel control plane.');
    return;
  }

  // Only guard paths inside the shared Chisel control plane.
  if (relPath === '..' || relPath.startsWith('../') || relPath.startsWith('..\\')) return;

  // Extract idea directory name from path like <control-root>/<idea-name>/...
  const parts = relPath.split(/[/\\]/);
  if (parts.length < 2) return;
  const ideaName = parts[0];
  // Skip wiki directories
  if (ideaName === 'wiki' || ideaName === 'wiki-candidates') return;

  const ideaDir = join(chiselDir, ideaName);
  const subPath = parts.slice(1).join('/');

  // Rule 1: machine state and event history must not be written directly.
  if (subPath === 'task-workflow-state.yaml') {
    deny('task-workflow-state.yaml must be modified through workflow-status.mjs, not written directly.');
    return;
  }
  if (subPath === 'workflow-state.yaml') {
    deny('workflow-state.yaml must be modified through orchestration-transition.mjs (or controlled rollback), not written directly.');
    return;
  }
  if (subPath === 'events.ndjson') {
    deny('events.ndjson is append-only and must be written through orchestration-transition.mjs.');
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
