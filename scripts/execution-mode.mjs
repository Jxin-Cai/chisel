#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWriteFile } from './workflow-lib.mjs';

export const EXECUTION_MODE_FILE = 'execution-mode.json';
export const EXECUTION_MODES = Object.freeze(['interactive', 'hotol']);
export const HOTOL_CONFIRMATION_ACTOR = 'hotol';

const HOTOL_CAPABILITIES = Object.freeze([
  'resolve-requirement-defaults',
  'approve-plan',
  'select-worktree-isolation',
  'approve-merge-snapshot',
  'merge-to-default-branch',
]);

function readJson(path) {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export function readExecutionMode(ideaDir) {
  const file = join(resolve(ideaDir), EXECUTION_MODE_FILE);
  const value = readJson(file);
  if (!value) return { schema_version: 1, mode: 'interactive', active: false, file };
  const valid = value.schema_version === 1
    && EXECUTION_MODES.includes(value.mode)
    && value.initiated_by === 'user'
    && Number.isFinite(Date.parse(value.initiated_at));
  return { ...value, active: valid && value.mode === 'hotol', valid, file };
}

export function enableHotolMode(ideaDir, { targetBranch = 'default', push = false } = {}) {
  const root = resolve(ideaDir);
  const existing = readExecutionMode(root);
  if (existing.mode === 'interactive' && existsSync(existing.file)) {
    throw new Error('execution-mode.json already declares interactive mode; do not silently escalate it to HOTOL');
  }
  const config = {
    schema_version: 1,
    mode: 'hotol',
    initiated_by: 'user',
    initiated_at: existing.active ? existing.initiated_at : new Date().toISOString(),
    authorization: {
      capabilities: [...HOTOL_CAPABILITIES],
      merge_target: String(targetBranch || 'default'),
      push: push === true,
      force_push: false,
      destructive_cleanup: false,
    },
    decision_policy: {
      ask_user_questions: false,
      ambiguity: 'conservative-reversible-default',
      worktree: 'isolated',
      conflict: 'resolve-only-when-machine-verifiable',
      terminal_on_unsafe_unknown: 'blocked',
    },
  };
  atomicWriteFile(join(root, EXECUTION_MODE_FILE), `${JSON.stringify(config, null, 2)}\n`);
  return { ...config, active: true, file: join(root, EXECUTION_MODE_FILE) };
}

export function isHotolMode(ideaDir) {
  return readExecutionMode(ideaDir).active === true;
}

export function assertHotolCapability(ideaDir, capability) {
  const mode = readExecutionMode(ideaDir);
  if (!mode.active) throw new Error('HOTOL authorization is missing or invalid');
  if (!mode.authorization?.capabilities?.includes(capability)) {
    throw new Error(`HOTOL capability is not authorized: ${capability}`);
  }
  return mode;
}

export function isValidConfirmationActor(ideaDir, actor) {
  return actor === 'user' || (actor === HOTOL_CONFIRMATION_ACTOR && isHotolMode(ideaDir));
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function main(args) {
  const ideaDir = args[0] && resolve(args[0]);
  if (!ideaDir) throw new Error('Usage: execution-mode.mjs <idea-dir> <--enable-hotol|--status> [--target <default|branch>] [--push]');
  if (args.includes('--enable-hotol')) {
    return enableHotolMode(ideaDir, { targetBranch: option(args, '--target') || 'default', push: args.includes('--push') });
  }
  if (args.includes('--status')) return readExecutionMode(ideaDir);
  throw new Error('expected --enable-hotol or --status');
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); }
  catch (error) { process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exit(2); }
}
