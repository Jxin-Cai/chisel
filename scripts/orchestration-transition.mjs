#!/usr/bin/env node
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSnapshot } from './checkpoint.mjs';
import { commitFileTransaction, recoverFileTransactions } from './file-transaction.mjs';
import { initWorkflowState, readWorkflowRevision, renderWorkflowPhaseUpdate } from './workflow-lib.mjs';
import { recordStepTransition } from './session-metrics.mjs';
import { WORKFLOW_STEPS } from './workflow-definition.mjs';
import { computeStatus } from './orchestration-status.mjs';

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function readEvents(ideaDir) {
  const path = join(ideaDir, 'events.ndjson');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function forkRecommendedStep(ideaDir) {
  const step = computeStatus(ideaDir).resume_step;
  if (!step) throw new Error('orchestration-status did not return resume_step');
  return step;
}

export function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

export function acquireTransitionLock(lockPath) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = openSync(lockPath, 'wx');
      writeFileSync(fd, JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() }));
      return fd;
    } catch {
      if (attempt > 0) break;
      let stale = false;
      try {
        const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
        const ageMs = Date.now() - new Date(lock.created_at).getTime();
        stale = !processIsAlive(Number(lock.pid)) || !Number.isFinite(ageMs) || ageMs > 10 * 60 * 1000;
      } catch {
        stale = true;
      }
      if (!stale) break;
      try { unlinkSync(lockPath); } catch { break; }
    }
  }
  return null;
}

export function performTransition(ideaDir, step, {
  expectedRevision,
  eventId,
  statusFn,
} = {}) {
  const transitionStartedAt = Date.now();
  if (!existsSync(ideaDir)) throw new Error(`idea-dir not found: ${ideaDir}`);
  if (!WORKFLOW_STEPS.includes(step)) throw new Error(`unknown workflow step: ${step}`);
  if (expectedRevision === undefined || !Number.isInteger(expectedRevision) || expectedRevision < 0) {
    throw new Error('expectedRevision must be a non-negative integer');
  }
  const resolvedEventId = eventId || `transition:${expectedRevision}:${step}`;
  const resolveStep = statusFn || forkRecommendedStep;

  const lockPath = join(ideaDir, '.transition.lock');
  const lockFd = acquireTransitionLock(lockPath);
  if (lockFd === null) throw new Error('another workflow transition is in progress');

  try {
    const recoveredTransactions = recoverFileTransactions(ideaDir);
    const replay = readEvents(ideaDir).find(event => event.event_id === resolvedEventId);
    if (replay) {
      if (replay.to !== step) throw new Error(`event_id already used for a different step: ${resolvedEventId}`);
      return { transitioned: false, idempotent_replay: true, recovered_transactions: recoveredTransactions, ...replay };
    }

    const actualRevision = readWorkflowRevision(ideaDir);
    if (actualRevision !== expectedRevision) throw new Error(`workflow revision conflict: expected ${expectedRevision}, actual ${actualRevision}`);
    const recommended = resolveStep(ideaDir);
    if (recommended !== step) throw new Error(`transition rejected: authoritative resume_step is ${recommended}, requested ${step}`);

    const statePath = join(ideaDir, 'workflow-state.yaml');
    if (!existsSync(statePath)) initWorkflowState(ideaDir, basename(ideaDir));
    const stateText = readFileSync(statePath, 'utf8');
    const previousStep = stateText.match(/^current_step:\s*(.+)$/m)?.[1]?.trim() || 'receive-requirement';
    if (previousStep === step) {
      return { transitioned: false, current_step: step, revision: readWorkflowRevision(ideaDir), reason: 'already current' };
    }

    try { createSnapshot(ideaDir); } catch { /* snapshots are non-critical */ }
    const at = new Date().toISOString();
    const rendered = renderWorkflowPhaseUpdate(stateText, step, { expectedRevision, incrementRevision: true, now: at });
    const transition = rendered.transition;
    const event = {
      event_id: resolvedEventId,
      type: 'workflow.transition',
      at,
      from: previousStep,
      to: step,
      previous_revision: transition.previous_revision,
      revision: transition.revision,
    };
    const eventsPath = join(ideaDir, 'events.ndjson');
    const eventsText = existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8') : '';
    const failAfterWrites = Number(process.env.CHISEL_TX_FAIL_AFTER_WRITES || 0);
    const transaction = commitFileTransaction(ideaDir, [
      { path: 'events.ndjson', content: `${eventsText}${JSON.stringify(event)}\n` },
      { path: 'workflow-state.yaml', content: rendered.content },
    ], { id: `workflow-${resolvedEventId}`, failAfterWrites });
    try { recordStepTransition(ideaDir, previousStep, step, Date.now() - transitionStartedAt); } catch { /* metrics are non-critical */ }

    const result = { transitioned: true, ...event, transaction_id: transaction.transaction_id, recovered_transactions: transaction.recovered };
    return result;
  } finally {
    closeSync(lockFd);
    try { unlinkSync(lockPath); } catch { /* already removed */ }
  }
}

function main() {
  const args = process.argv.slice(2);
  const ideaDir = args[0];
  const step = args[1];
  const expectedRevisionRaw = option(args, '--expected-revision');
  if (!ideaDir || !step || expectedRevisionRaw === undefined) {
    process.stderr.write('用法: orchestration-transition.mjs <idea-dir> <step> --expected-revision <n> [--event-id <id>]\n');
    process.exit(1);
  }
  const expectedRevision = Number(expectedRevisionRaw);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) {
    process.stderr.write(`${JSON.stringify({ error: '--expected-revision must be a non-negative integer' })}\n`);
    process.exit(1);
  }
  const eventId = option(args, '--event-id') || undefined;

  try {
    const result = performTransition(ideaDir, step, { expectedRevision, eventId });
    console.log(JSON.stringify(result));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = 2;
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) main();
