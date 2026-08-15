#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertHotolCapability, HOTOL_CONFIRMATION_ACTOR } from './execution-mode.mjs';
import { checkGate } from './gate-check.mjs';
import { recordMergeReviewDecision } from './merge-review.mjs';
import { recordReportConfirmation } from './report-confirm.mjs';
import { confirmRequirement } from './requirement-context.mjs';
import { atomicWriteFile, ensureDir } from './workflow-lib.mjs';
import { toBeDecisionConfirmation } from './to-be-confirmation.mjs';
import { resolveExistingIdeaDirectory } from './control-plane.mjs';

function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return fallback; }
}

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function approveRequirement(ideaDir) {
  assertHotolCapability(ideaDir, 'resolve-requirement-defaults');
  const requirement = join(ideaDir, 'requirement.md');
  if (!existsSync(requirement)) throw new Error('requirement.md missing');
  return confirmRequirement(ideaDir, sha256(requirement), HOTOL_CONFIRMATION_ACTOR);
}

export function approveToBe(ideaDir, expectedReportSha) {
  assertHotolCapability(ideaDir, 'approve-plan');
  const adversarial = checkGate(ideaDir, 'to-be-adversarial-approved');
  if (!adversarial.pass) throw new Error(`cannot auto-approve an incomplete plan: ${adversarial.reason}`);
  const confirmation = {
    ...toBeDecisionConfirmation(ideaDir),
    schema_version: 1,
    phase: 'to-be',
    status: 'confirmed',
    confirmed_at: new Date().toISOString(),
    confirmed_by: HOTOL_CONFIRMATION_ACTOR,
    automation_basis: 'explicit HOTOL mode authorization',
  };
  ensureDir(join(ideaDir, 'confirmations'));
  atomicWriteFile(join(ideaDir, 'confirmations/to-be.json'), `${JSON.stringify(confirmation, null, 2)}\n`);
  return recordReportConfirmation(ideaDir, 'to-be', expectedReportSha, 'Automatically approved by explicit HOTOL mode.', HOTOL_CONFIRMATION_ACTOR);
}

export function approveMerge(ideaDir) {
  assertHotolCapability(ideaDir, 'approve-merge-snapshot');
  return recordMergeReviewDecision(ideaDir, 'approve', 'Automatically approved after all machine gates passed in explicit HOTOL mode.', HOTOL_CONFIRMATION_ACTOR);
}

export function completeHotolDelivery(ideaDir) {
  assertHotolCapability(ideaDir, 'merge-to-default-branch');
  const decision = readJson(join(ideaDir, 'worktree-decision.json'));
  const repos = Array.isArray(decision?.repos) ? decision.repos : [];
  if (repos.length === 0) throw new Error('worktree-decision.json must contain at least one repository');
  const receipts = repos.map(repo => {
    const repoPath = repo.repo_path || repo.path;
    if (!repoPath) throw new Error('worktree decision repository is missing repo_path');
    const file = join(ideaDir, 'delivery', `${basename(resolve(repoPath))}.json`);
    const receipt = readJson(file);
    if (!receipt) throw new Error(`delivery receipt missing: ${file}`);
    if (receipt.status !== 'merged' || receipt.local_target?.status !== 'updated') {
      throw new Error(`delivery is incomplete for ${repoPath}: ${receipt.status || 'unknown'} / ${receipt.local_target?.status || 'local-target-missing'}`);
    }
    return { repo_path: resolve(repoPath), receipt_file: file, merge_commit: receipt.merge_commit, target: receipt.target };
  });
  const completed = { schema_version: 1, mode: 'hotol', completed_at: new Date().toISOString(), repositories: receipts };
  atomicWriteFile(join(ideaDir, '.done'), `${JSON.stringify(completed, null, 2)}\n`);
  return completed;
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function main(args) {
  const ideaDir = args[0] ? resolveExistingIdeaDirectory(args[0], process.cwd()) : '';
  if (!ideaDir) throw new Error('Usage: hotol-approve.mjs <idea-dir> <--requirement|--to-be|--merge|--complete-delivery> [--expected-sha <sha256>]');
  if (args.includes('--requirement')) return approveRequirement(ideaDir);
  if (args.includes('--to-be')) return approveToBe(ideaDir, option(args, '--expected-sha'));
  if (args.includes('--merge')) return approveMerge(ideaDir);
  if (args.includes('--complete-delivery')) return completeHotolDelivery(ideaDir);
  throw new Error('expected --requirement, --to-be, --merge, or --complete-delivery');
}

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  try { console.log(JSON.stringify(main(process.argv.slice(2)), null, 2)); }
  catch (error) { process.stderr.write(`${JSON.stringify({ error: error.message })}\n`); process.exit(2); }
}
