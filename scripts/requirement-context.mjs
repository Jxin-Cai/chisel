#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { atomicWriteFile, ensureDir } from './workflow-lib.mjs';
import { HOTOL_CONFIRMATION_ACTOR, isValidConfirmationActor } from './execution-mode.mjs';
import { resolveExistingIdeaDirectory } from './control-plane.mjs';

const ORIGINAL = 'requirement-original.md';
const CANONICAL = 'requirement.md';
const INPUTS = 'requirement-inputs.json';
const CLARIFICATION = 'requirement-clarification.json';
const CONFIRMATION = 'confirmations/requirement.json';

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function read(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : null;
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

export function initializeRequirementContext(ideaDir) {
  const canonicalPath = join(ideaDir, CANONICAL);
  const originalPath = join(ideaDir, ORIGINAL);
  const inputsPath = join(ideaDir, INPUTS);
  const current = read(canonicalPath);
  if (current === null) throw new Error(`${CANONICAL} missing`);
  if (!existsSync(originalPath)) atomicWriteFile(originalPath, current);
  if (!existsSync(inputsPath)) {
    const original = read(originalPath) || current;
    atomicWriteFile(inputsPath, `${JSON.stringify({
      schema_version: 1,
      source_step: 'clarify:requirement',
      events: [{
        id: 'input-001',
        kind: 'initial_requirement',
        source_step: 'receive-requirement',
        recorded_at: new Date().toISOString(),
        content: original,
      }],
    }, null, 2)}\n`);
  }
  return { original_path: originalPath, inputs_path: inputsPath };
}

export function appendRequirementInput(ideaDir, event) {
  initializeRequirementContext(ideaDir);
  const inputsPath = join(ideaDir, INPUTS);
  const ledger = readJson(inputsPath);
  if (ledger?.schema_version !== 1 || !Array.isArray(ledger.events)) throw new Error(`${INPUTS} invalid`);
  const content = String(event?.content || '').trim();
  if (!content) throw new Error('requirement input content must not be empty');
  const next = {
    id: `input-${String(ledger.events.length + 1).padStart(3, '0')}`,
    kind: String(event.kind || 'user_addition'),
    source_step: String(event.source_step || 'clarify:requirement'),
    recorded_at: event.recorded_at || new Date().toISOString(),
    content,
    ...(event.task_id ? { task_id: String(event.task_id) } : {}),
  };
  ledger.events.push(next);
  atomicWriteFile(inputsPath, `${JSON.stringify(ledger, null, 2)}\n`);
  return next;
}

export function requirementSourceFingerprint(ideaDir) {
  const hash = createHash('sha256');
  for (const rel of [ORIGINAL, INPUTS, CLARIFICATION, CANONICAL]) {
    const content = read(join(ideaDir, rel));
    if (content === null) return null;
    hash.update(rel).update('\0').update(content).update('\0');
  }
  return hash.digest('hex');
}

export function validateCanonicalRequirement(content) {
  const text = String(content || '');
  const required = [
    ['目标与业务结果', /^##\s+(?:目标与业务结果|Goal(?:s)?(?: and Business Outcome)?)\s*$/im],
    ['范围', /^##\s+(?:范围|Scope)\s*$/im],
    ['验收标准', /^##\s+(?:验收标准|Acceptance Criteria)\s*$/im],
    ['未决问题', /^##\s+(?:未决问题|Open Questions)\s*$/im],
  ];
  const missing = required.filter(([, pattern]) => !pattern.test(text)).map(([name]) => name);
  if (missing.length > 0) return { valid: false, reason: `canonical requirement missing sections: ${missing.join(', ')}` };
  if (/<[^>\n]+>|\b(?:TBD|TODO)\b|待确认(?!问题.*无)/i.test(text)) {
    return { valid: false, reason: 'canonical requirement contains placeholders or unresolved text' };
  }
  const openSection = text.match(/^##\s+(?:未决问题|Open Questions)\s*$([\s\S]*?)(?=^##\s+|(?![\s\S]))/im)?.[1] || '';
  if (!/(?:^|\n)\s*[-*]?\s*(?:无|none|no open questions)\s*[。.]?\s*(?:\n|$)/i.test(openSection)) {
    return { valid: false, reason: 'canonical requirement must explicitly state that open questions are empty' };
  }
  return { valid: true };
}

export function requirementConfirmationStatus(ideaDir) {
  const confirmation = readJson(join(ideaDir, CONFIRMATION));
  const canonical = read(join(ideaDir, CANONICAL));
  const fingerprint = requirementSourceFingerprint(ideaDir);
  const canonicalValidation = validateCanonicalRequirement(canonical);
  if (!canonicalValidation.valid) return canonicalValidation;
  if (!confirmation) return { valid: false, reason: `${CONFIRMATION} missing or invalid` };
  if (confirmation.schema_version !== 1 || confirmation.phase !== 'requirement' || confirmation.status !== 'confirmed') {
    return { valid: false, reason: `${CONFIRMATION} invalid schema` };
  }
  if (!isValidConfirmationActor(ideaDir, confirmation.confirmed_by)) return { valid: false, reason: `${CONFIRMATION} confirmed_by is not authorized` };
  if (!Number.isFinite(Date.parse(confirmation.confirmed_at))) return { valid: false, reason: `${CONFIRMATION} confirmed_at must be ISO-8601` };
  if (!canonical || confirmation.requirement_sha256 !== sha256(canonical)) return { valid: false, reason: 'canonical requirement changed after confirmation' };
  if (!fingerprint || confirmation.source_fingerprint !== fingerprint) return { valid: false, reason: 'requirement inputs changed after confirmation' };
  return { valid: true, confirmation_file: CONFIRMATION, requirement_sha256: confirmation.requirement_sha256, source_fingerprint: fingerprint };
}

export function confirmRequirement(ideaDir, expectedSha256, actor = 'user') {
  initializeRequirementContext(ideaDir);
  const canonical = read(join(ideaDir, CANONICAL));
  const clarification = readJson(join(ideaDir, CLARIFICATION));
  if (!canonical) throw new Error(`${CANONICAL} missing`);
  const canonicalValidation = validateCanonicalRequirement(canonical);
  if (!canonicalValidation.valid) throw new Error(canonicalValidation.reason);
  if (clarification?.schema_version !== 2) throw new Error(`${CLARIFICATION} schema_version 2 required`);
  const actualSha256 = sha256(canonical);
  if (!expectedSha256) throw new Error('--expected-sha is required');
  if (expectedSha256 !== actualSha256) throw new Error(`requirement changed before confirmation: expected ${expectedSha256}, actual ${actualSha256}`);
  const sourceFingerprint = requirementSourceFingerprint(ideaDir);
  if (!sourceFingerprint) throw new Error('requirement source set is incomplete');
  const confirmationPath = join(ideaDir, CONFIRMATION);
  ensureDir(join(ideaDir, 'confirmations'));
  if (!isValidConfirmationActor(ideaDir, actor)) throw new Error(`confirmation actor is not authorized: ${actor}`);
  const confirmation = {
    schema_version: 1,
    phase: 'requirement',
    status: 'confirmed',
    confirmed_by: actor,
    confirmed_at: new Date().toISOString(),
    requirement_file: CANONICAL,
    requirement_sha256: actualSha256,
    source_fingerprint: sourceFingerprint,
  };
  atomicWriteFile(confirmationPath, `${JSON.stringify(confirmation, null, 2)}\n`);
  return { ...confirmation, confirmation_file: resolve(confirmationPath) };
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function main(args) {
  const ideaDir = args[0] ? resolveExistingIdeaDirectory(args[0], process.cwd()) : '';
  if (!ideaDir) throw new Error('用法: requirement-context.mjs <idea-dir> <--init|--status|--confirm|--append-file>');
  if (args.includes('--init')) return initializeRequirementContext(ideaDir);
  if (args.includes('--status')) return requirementConfirmationStatus(ideaDir);
  if (args.includes('--confirm')) return confirmRequirement(
    ideaDir,
    option(args, '--expected-sha'),
    args.includes('--hotol') ? HOTOL_CONFIRMATION_ACTOR : 'user',
  );
  if (args.includes('--append-file')) {
    const inputFile = option(args, '--append-file');
    if (!inputFile || !existsSync(inputFile)) throw new Error('--append-file must reference an existing file');
    return appendRequirementInput(ideaDir, {
      kind: option(args, '--kind') || 'user_addition',
      source_step: option(args, '--source-step') || 'clarify:requirement',
      task_id: option(args, '--task-id'),
      content: readFileSync(inputFile, 'utf8'),
    });
  }
  throw new Error('expected --init, --status, --confirm, or --append-file');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const result = main(process.argv.slice(2));
    console.log(JSON.stringify(result, null, 2));
    if (process.argv.includes('--status') && !result.valid) process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exit(2);
  }
}
