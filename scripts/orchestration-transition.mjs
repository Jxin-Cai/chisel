#!/usr/bin/env node
import { closeSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSnapshot } from './checkpoint.mjs';
import { commitFileTransaction, recoverFileTransactions } from './file-transaction.mjs';
import { initWorkflowState, readWorkflowRevision, renderWorkflowPhaseUpdate } from './workflow-lib.mjs';
import { recordStepFinish, recordStepStart } from './session-metrics.mjs';
import { WORKFLOW_STEPS } from './workflow-definition.mjs';

function fail(message, code = 1) {
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(code);
}

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

function recommendedStep(ideaDir) {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const output = execFileSync('node', [join(scriptDir, 'orchestration-status.mjs'), ideaDir, '--compact'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
  const step = output.match(/^resume_step:\s*(.+)$/m)?.[1]?.trim();
  if (!step) throw new Error('orchestration-status did not return resume_step');
  return step;
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function acquireTransitionLock(lockPath) {
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

function main() {
  const args = process.argv.slice(2);
  const ideaDir = args[0];
  const step = args[1];
  const expectedRevisionRaw = option(args, '--expected-revision');
  const openDashboard = args.includes('--open-dashboard');
  if (!ideaDir || !step || expectedRevisionRaw === undefined) {
    fail('用法: orchestration-transition.mjs <idea-dir> <step> --expected-revision <n> [--event-id <id>] [--open-dashboard]');
  }
  if (!existsSync(ideaDir)) fail(`idea-dir not found: ${ideaDir}`);
  if (!WORKFLOW_STEPS.includes(step)) fail(`unknown workflow step: ${step}`);
  const expectedRevision = Number(expectedRevisionRaw);
  if (!Number.isInteger(expectedRevision) || expectedRevision < 0) fail('--expected-revision must be a non-negative integer');
  const eventId = option(args, '--event-id') || `transition:${expectedRevision}:${step}`;

  const lockPath = join(ideaDir, '.transition.lock');
  const lockFd = acquireTransitionLock(lockPath);
  if (lockFd === null) fail('another workflow transition is in progress', 2);

  try {
    const recoveredTransactions = recoverFileTransactions(ideaDir);
    const replay = readEvents(ideaDir).find(event => event.event_id === eventId);
    if (replay) {
      if (replay.to !== step) throw new Error(`event_id already used for a different step: ${eventId}`);
      console.log(JSON.stringify({ transitioned: false, idempotent_replay: true, recovered_transactions: recoveredTransactions, ...replay }));
      return;
    }

    const actualRevision = readWorkflowRevision(ideaDir);
    if (actualRevision !== expectedRevision) throw new Error(`workflow revision conflict: expected ${expectedRevision}, actual ${actualRevision}`);
    const recommended = recommendedStep(ideaDir);
    if (recommended !== step) throw new Error(`transition rejected: authoritative resume_step is ${recommended}, requested ${step}`);

    const statePath = join(ideaDir, 'workflow-state.yaml');
    if (!existsSync(statePath)) initWorkflowState(ideaDir, basename(ideaDir));
    const stateText = readFileSync(statePath, 'utf8');
    const previousStep = stateText.match(/^current_step:\s*(.+)$/m)?.[1]?.trim() || 'receive-requirement';
    if (previousStep === step) {
      console.log(JSON.stringify({ transitioned: false, current_step: step, revision: readWorkflowRevision(ideaDir), reason: 'already current' }));
      return;
    }

    try { createSnapshot(ideaDir); } catch { /* snapshots are non-critical */ }
    const at = new Date().toISOString();
    const rendered = renderWorkflowPhaseUpdate(stateText, step, { expectedRevision, incrementRevision: true, now: at });
    const transition = rendered.transition;
    const event = {
      event_id: eventId,
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
      // Write the event first and state last. If interrupted, the next transition
      // still sees the old revision and can roll the prepared transaction forward.
      { path: 'events.ndjson', content: `${eventsText}${JSON.stringify(event)}\n` },
      { path: 'workflow-state.yaml', content: rendered.content },
    ], { id: `workflow-${eventId}`, failAfterWrites });
    try { recordStepFinish(ideaDir, previousStep); } catch { /* metrics are non-critical */ }
    try { recordStepStart(ideaDir, step); } catch { /* metrics are non-critical */ }

    let dashboardUpdated = false;
    try {
      const scriptDir = dirname(fileURLToPath(import.meta.url));
      const dashboardArgs = [join(scriptDir, 'dashboard.mjs'), ideaDir];
      if (!openDashboard) dashboardArgs.push('--no-open');
      execFileSync('node', dashboardArgs, { stdio: 'ignore', timeout: 5000 });
      dashboardUpdated = true;
    } catch { /* dashboard is observational, not transactional */ }
    console.log(JSON.stringify({ transitioned: true, ...event, transaction_id: transaction.transaction_id, recovered_transactions: transaction.recovered, dashboard_updated: dashboardUpdated, dashboard_opened: dashboardUpdated && openDashboard }));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.message })}\n`);
    process.exitCode = 2;
  } finally {
    closeSync(lockFd);
    try { unlinkSync(lockPath); } catch { /* already removed */ }
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) main();

export { acquireTransitionLock, processIsAlive };
