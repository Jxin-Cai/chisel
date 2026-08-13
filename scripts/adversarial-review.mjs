#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { adversarialReviewRequirements, checkGate } from './gate-check.mjs';

const MAX_ATTEMPTS = 5;

function parseAttempt(argv) {
  const index = argv.indexOf('--attempt');
  if (index < 0) return 1;
  const attempt = Number(argv[index + 1]);
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_ATTEMPTS) {
    throw new Error(`--attempt must be an integer between 1 and ${MAX_ATTEMPTS}`);
  }
  return attempt;
}

export function initializeReview(ideaDir, { attempt = 1, force = false } = {}) {
  if (!Number.isInteger(attempt) || attempt < 1 || attempt > MAX_ATTEMPTS) {
    throw new Error(`attempt must be an integer between 1 and ${MAX_ATTEMPTS}`);
  }
  const jsonPath = join(ideaDir, 'to-be/adversarial-review.json');
  const markdownPath = join(ideaDir, 'to-be/adversarial-review.md');
  const existing = [jsonPath, markdownPath].filter(existsSync);
  if (existing.length > 0 && !force) {
    throw new Error(`review artifact already exists; pass --force only before starting a new fresh review: ${existing.join(', ')}`);
  }
  const requirements = adversarialReviewRequirements(ideaDir);
  if (requirements.missing_sources.length > 0) {
    throw new Error(`cannot initialize review; mandatory sources are missing: ${requirements.missing_sources.join(', ')}`);
  }
  const review = {
    schema_version: 2,
    source_step: 'plan:adversarial-review',
    status: 'fail',
    attempt,
    max_attempts: MAX_ATTEMPTS,
    findings: [],
    unresolved_findings: [],
    reviewed_files: requirements.reviewed_files,
    requirement_coverage: requirements.requirement_refs.map(source_ref => ({
      source_ref,
      status: 'fail',
      task_refs: [],
      change_point_refs: [],
      file_refs: [],
      verification_refs: [],
      evidence: '',
    })),
    evidence: [],
  };
  const markdown = [
    '# 对抗完整性审查',
    '',
    '## 审查范围',
    '',
    '<!-- fresh reviewer: describe the exact requirement/as-is/to-be sources reviewed -->',
    '',
    '## Findings',
    '',
    '<!-- fresh reviewer: record findings and their resolution status; use “无” only after an actual review -->',
    '',
    '## 结论',
    '',
    'status: fail',
    '',
    '<!-- fresh reviewer: replace with pass/fail/blocked and explain the evidence -->',
    '',
  ].join('\n');
  writeFileSync(jsonPath, `${JSON.stringify(review, null, 2)}\n`);
  writeFileSync(markdownPath, markdown);
  return {
    json_path: jsonPath,
    markdown_path: markdownPath,
    reviewed_file_count: requirements.reviewed_files.length,
    requirement_ref_count: requirements.requirement_refs.length,
    attempt,
  };
}

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
    process.stderr.write('用法: node adversarial-review.mjs <idea-dir> [--init [--attempt N] [--force] | --check]\n');
    process.exit(1);
  }
  if (argv.includes('--init')) {
    try {
      const result = initializeReview(ideaDir, { attempt: parseAttempt(argv), force: argv.includes('--force') });
      console.log(JSON.stringify({ status: 'initialized', ...result }, null, 2));
    } catch (error) {
      process.stderr.write(`${error.message}\n`);
      process.exit(1);
    }
    return;
  }
  const status = reviewStatus(ideaDir);
  console.log(JSON.stringify(status, null, 2));
  if (argv.includes('--check') && status.status !== 'pass') process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2));
