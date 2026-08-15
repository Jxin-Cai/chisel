#!/usr/bin/env node
// PreToolUse hook: guards Write/Edit to protected .chisel/ paths.
// Fail-open: non-chisel paths are always allowed.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { controlRoot } from '../scripts/control-plane.mjs';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

const PROTECTED_STATE_FILE = String.raw`(?:workflow-state\.yaml|task-workflow-state\.yaml|events\.ndjson)`;

export function mutatesProtectedState(command) {
  const text = String(command || '');
  if (!new RegExp(PROTECTED_STATE_FILE).test(text)) return false;

  // Shell redirection writes to the protected path. Input redirection (`<`) is
  // intentionally absent because reading machine state is safe and useful for
  // diagnostics.
  if (new RegExp(String.raw`(?:^|\s)(?:\d*>>?|&>)\s*[^\s;&|]*${PROTECTED_STATE_FILE}`).test(text)) return true;

  // Commands whose normal purpose is to create, replace, mutate, or remove the
  // named path. Read-only commands such as cat/grep/head/ls must remain allowed.
  const mutatingCommand = String.raw`(?:^|[;&|]\s*)(?:sudo\s+)?(?:rm|unlink|touch|truncate|mv|cp|install|chmod|chown|chgrp|tee)\b[^;&|\n]*${PROTECTED_STATE_FILE}`;
  if (new RegExp(mutatingCommand).test(text)) return true;

  // In-place editors and common programmatic filesystem write primitives.
  if (new RegExp(String.raw`(?:sed\b[^;&|\n]*(?:\s-i(?:\S*)?|--in-place)|perl\b[^;&|\n]*\s-[^\s]*i)[^;&|\n]*${PROTECTED_STATE_FILE}`).test(text)) return true;
  return new RegExp(String.raw`(?:writeFileSync|appendFileSync|truncateSync|renameSync|unlinkSync|rmSync|writeFile|appendFile|truncate|rename|unlink)\s*\([^\n]*${PROTECTED_STATE_FILE}`).test(text);
}

export function unsafePluginCommand(command) {
  const text = String(command || '');
  if (/\.chisel[/\\]tmp-scripts[/\\][^\s;&|"']+\.mjs\b/.test(text)
      || /\b(?:cp|mv|install)\b[^\n;&|]*\.mjs\b[^\n;&|]*(?:\/tmp\/|\.chisel[/\\]tmp-scripts)/.test(text)) {
    return 'Do not copy or execute plugin ESM scripts from /tmp or .chisel/tmp-scripts; run the script from ${CLAUDE_PLUGIN_ROOT}/scripts so relative imports and assets remain intact.';
  }

  const cachedScriptPaths = text.match(/\/[^\s;|"']*\.claude\/plugins\/cache\/chisel\/chisel\/[^\s;|"']+\.mjs/g) || [];
  for (const scriptPath of cachedScriptPaths) {
    if (!existsSync(scriptPath)) {
      const canonical = join(PLUGIN_ROOT, 'scripts', basename(scriptPath));
      return `Plugin script path does not exist: ${scriptPath}. Use the current plugin path: ${canonical}`;
    }
  }

  if (/(?:^|[;&|]\s*)(?:={2,}[A-Za-z0-9_-]*|[A-Za-z0-9_-]*={2,})(?=\s|[;&|]|$)/.test(text)
      || /\becho\s+["']?={2,}["']?(?=\s|[;&|]|$)/.test(text)) {
    return 'Bare ===-style separators are parsed as shell commands. Remove them or quote them as data.';
  }
  return '';
}

function mutatesManagedReceipt(command, receiptPattern) {
  const text = String(command || '');
  if (!receiptPattern.test(text)) return false;
  return /(?:^|[;&|]\s*)(?:python\d*|node|ruby|perl|sed|tee|cp|mv|install|touch|truncate|rm|unlink)\b/.test(text)
    || /(?:^|\s)(?:\d*>>?|&>)\s*/.test(text);
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
    const unsafeReason = unsafePluginCommand(command);
    if (unsafeReason) {
      deny(unsafeReason);
      return;
    }
    if (mutatesProtectedState(command)) {
      deny('Machine state and event history may not be mutated through Bash; use the Chisel state transition scripts.');
      return;
    }
    if (/confirmations[/\\]merge-review\.json/.test(command)) {
      deny('merge-review confirmation must be written through merge-review.mjs --confirm after an explicit user decision.');
      return;
    }
    if (mutatesManagedReceipt(command, /confirmations[/\\]to-be\.json/)) {
      deny('To-Be confirmation must be written through report-confirm.mjs or hotol-approve.mjs; do not hand-build the receipt.');
      return;
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

  if (subPath === 'confirmations/merge-review.json') {
    deny('merge-review confirmation must be written through merge-review.mjs --confirm after an explicit user decision.');
    return;
  }

  if (subPath === 'confirmations/to-be.json') {
    deny('To-Be confirmation must be written through report-confirm.mjs or hotol-approve.mjs; do not hand-build the receipt.');
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
