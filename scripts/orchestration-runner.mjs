#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { durableAtomicWrite, recoverFileTransactions } from './file-transaction.mjs';
import { ideaDirectory } from './control-plane.mjs';
import { computeStatus } from './orchestration-status.mjs';
import { performTransition } from './orchestration-transition.mjs';
import { collectPhaseArtifacts, formatPhaseArtifacts } from './phase-artifacts.mjs';
import { WORKFLOW_STEPS } from './workflow-definition.mjs';

function parse(argv) {
  const result = { command: argv[0] || '--next' };
  for (let index = 1; index < argv.length; index += 1) {
    const key = argv[index];
    if (key.startsWith('--')) result[key.slice(2).replaceAll('-', '_')] = argv[++index];
  }
  return result;
}

export function parseStatus(text) {
  const result = {};
  for (const line of text.split('\n')) {
    const match = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!match || match[1] === 'phase_detail') continue;
    const [, key, raw] = match;
    if (raw === 'true' || raw === 'false') result[key] = raw === 'true';
    else if (key === 'state_revision') result[key] = Number(raw);
    else {
      try { result[key] = JSON.parse(raw); } catch { result[key] = raw; }
    }
  }
  return result;
}

function runnerFile(ideaDir) { return join(ideaDir, 'runner-state.json'); }
function readRunner(ideaDir) {
  if (!existsSync(runnerFile(ideaDir))) return null;
  return JSON.parse(readFileSync(runnerFile(ideaDir), 'utf8'));
}
function writeRunner(ideaDir, state) {
  durableAtomicWrite(runnerFile(ideaDir), `${JSON.stringify(state, null, 2)}\n`);
}
function leaseUntil(now, seconds) {
  const value = Number(seconds || 3600);
  if (!Number.isFinite(value) || value < 30) throw new Error('lease-seconds must be at least 30');
  return new Date(new Date(now).getTime() + value * 1000).toISOString();
}

function claim(ideaDir, owner, leaseSeconds) {
  const now = new Date().toISOString();
  const previous = readRunner(ideaDir);
  const leased = previous?.status === 'active' && new Date(previous.lease_until).getTime() > Date.now();
  if (leased && previous.owner !== owner) throw new Error(`workflow is leased by ${previous.owner} until ${previous.lease_until}`);
  const state = previous || { schema_version: 1, runner_id: randomUUID(), created_at: now, iteration: 0 };
  state.owner = owner;
  state.status = 'active';
  state.last_heartbeat = now;
  state.lease_until = leaseUntil(now, leaseSeconds);
  return state;
}

function status(ideaDir) {
  return computeStatus(ideaDir);
}

function tick(ideaDir, state) {
  const recovered_transactions = recoverFileTransactions(ideaDir);
  let decision = status(ideaDir);
  let completed_step_delivery = null;
  if (decision.transition_required) {
    const transition = performTransition(ideaDir, decision.resume_step, {
      expectedRevision: decision.state_revision,
      eventId: `runner-${state.runner_id}-${state.iteration + 1}`,
      statusFn: (dir) => computeStatus(dir).resume_step,
    });
    const completedStep = transition.from;
    if (completedStep && WORKFLOW_STEPS.includes(completedStep)) {
      const artifacts = collectPhaseArtifacts(ideaDir, completedStep);
      completed_step_delivery = {
        step: completedStep,
        artifacts,
        markdown: formatPhaseArtifacts(ideaDir, completedStep, artifacts),
        instruction: '将 markdown 字段原样输出到对话中，不得只说产物已生成。',
      };
    }
    decision = status(ideaDir);
  }
  state.iteration += 1;
  state.current_step = decision.resume_step;
  state.last_decision = decision;
  state.recovered_transactions = recovered_transactions;
  state.updated_at = new Date().toISOString();
  if (decision.resume_step === 'done') state.status = 'done';
  else if (decision.resume_step === 'blocked') state.status = 'blocked';
  writeRunner(ideaDir, state);
  return { ...decision, runner_id: state.runner_id, owner: state.owner, lease_until: state.lease_until, runner_status: state.status, recovered_transactions, completed_step_delivery };
}

function main() {
  const args = parse(process.argv.slice(2));
  const projectRoot = resolve(args.project_root || '.');
  const ideaDir = args.idea_dir ? resolve(args.idea_dir) : ideaDirectory(projectRoot, args.idea);
  mkdirSync(ideaDir, { recursive: true });
  try {
    if (args.command === '--status') {
      console.log(JSON.stringify({ idea_dir: ideaDir, runner: readRunner(ideaDir), decision: status(ideaDir) }, null, 2));
      return;
    }
    const owner = args.owner || process.env.CHISEL_RUN_OWNER || 'main-orchestrator';
    const state = claim(ideaDir, owner, args.lease_seconds);
    if (args.command === '--pause') {
      state.status = 'paused';
      state.updated_at = new Date().toISOString();
      writeRunner(ideaDir, state);
      console.log(JSON.stringify({ runner_id: state.runner_id, status: state.status }));
      return;
    }
    if (!['--start', '--next', '--resume', '--heartbeat'].includes(args.command)) throw new Error('command must be --start, --next, --resume, --heartbeat, --pause, or --status');
    if (args.command === '--heartbeat') {
      writeRunner(ideaDir, state);
      console.log(JSON.stringify({ runner_id: state.runner_id, status: state.status, lease_until: state.lease_until }));
      return;
    }
    console.log(JSON.stringify({ idea_dir: ideaDir, ...tick(ideaDir, state) }, null, 2));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ error: error.message, idea_dir: ideaDir })}\n`);
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) main();

export { readRunner };
