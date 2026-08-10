#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkGate } from './gate-check.mjs';

const MAX_ATTEMPTS = 5;

export function reviewStatus(ideaDir) {
  const file = join(ideaDir, 'to-be/adversarial-review.json');
  if (!existsSync(file)) {
    return { status: 'pending', attempt: 1, max_attempts: MAX_ATTEMPTS, gate: checkGate(ideaDir, 'to-be-adversarial-approved') };
  }
  let review;
  try { review = JSON.parse(readFileSync(file, 'utf8')); }
  catch (error) { return { status: 'invalid', attempt: 1, max_attempts: MAX_ATTEMPTS, error: error.message, gate: checkGate(ideaDir, 'to-be-adversarial-approved') }; }
  const attempt = Number(review.attempt || 1);
  const gate = checkGate(ideaDir, 'to-be-adversarial-approved');
  const passed = gate.pass;
  const exhausted = !passed && attempt >= MAX_ATTEMPTS;
  return {
    status: passed ? 'pass' : exhausted ? 'blocked' : 'needs_repair',
    attempt,
    next_attempt: passed || exhausted ? null : attempt + 1,
    max_attempts: MAX_ATTEMPTS,
    findings: Array.isArray(review.findings) ? review.findings : [],
    gate,
  };
}

function main(argv) {
  const ideaDir = argv[0];
  if (!ideaDir) {
    process.stderr.write('用法: node adversarial-review.mjs <idea-dir> [--check]\n');
    process.exit(1);
  }
  const status = reviewStatus(ideaDir);
  console.log(JSON.stringify(status, null, 2));
  if (argv.includes('--check') && status.status !== 'pass') process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));

