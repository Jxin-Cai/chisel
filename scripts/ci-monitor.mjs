#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';

const MAX_FIX_ATTEMPTS = 3;

function getCurrentBranch() {
  try {
    return execSync('git branch --show-current', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch { return null; }
}

function getCiStatus(branch) {
  try {
    const result = execSync(
      `gh run list --branch "${branch}" --limit 1 --json status,conclusion,name,databaseId`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }
    );
    const runs = JSON.parse(result);
    if (runs.length === 0) return { status: 'no_runs' };
    const run = runs[0];
    return { status: run.status, conclusion: run.conclusion, name: run.name, id: run.databaseId };
  } catch (e) {
    return { status: 'error', error: e.message };
  }
}

function getCiFailureLogs(runId) {
  try {
    return execSync(
      `gh run view ${runId} --log-failed 2>/dev/null | tail -50`,
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 2 * 1024 * 1024 }
    );
  } catch { return ''; }
}

export function monitorCi(ideaDir, { pollInterval = 30, maxAttempts = MAX_FIX_ATTEMPTS } = {}) {
  const branch = getCurrentBranch();
  if (!branch) return { status: 'error', error: 'not in a git branch' };

  const ciState = getCiStatus(branch);

  if (ciState.status === 'no_runs') return { status: 'no_runs', branch };
  if (ciState.status === 'error') return { status: 'error', error: ciState.error };
  if (ciState.status === 'in_progress' || ciState.status === 'queued') {
    return { status: 'polling', branch, run_name: ciState.name, poll_interval: pollInterval };
  }

  if (ciState.conclusion === 'success') return { status: 'passed', branch };

  // CI failed
  const stateFile = join(ideaDir, 'ci-fix-state.json');
  let fixState = { attempts: 0, last_error: null };
  if (existsSync(stateFile)) {
    try { fixState = JSON.parse(readFileSync(stateFile, 'utf8')); } catch { /* fresh */ }
  }

  if (fixState.attempts >= maxAttempts) {
    return { status: 'blocked', attempts: fixState.attempts, last_error: fixState.last_error, branch };
  }

  const logs = getCiFailureLogs(ciState.id);
  fixState.attempts++;
  fixState.last_error = logs.substring(0, 500);
  fixState.last_run_id = ciState.id;
  writeFileSync(stateFile, JSON.stringify(fixState, null, 2));

  return {
    status: 'failed',
    branch,
    attempts: fixState.attempts,
    max_attempts: maxAttempts,
    failure_logs: logs.substring(0, 1000),
    action: fixState.attempts < maxAttempts ? 'analyze_and_fix' : 'escalate',
  };
}

function main() {
  const args = process.argv.slice(2);
  const ideaDir = args.find(a => !a.startsWith('--'));
  const pollIdx = args.indexOf('--poll-interval');
  const pollInterval = pollIdx !== -1 ? parseInt(args[pollIdx + 1]) : 30;
  const maxIdx = args.indexOf('--max-attempts');
  const maxAttempts = maxIdx !== -1 ? parseInt(args[maxIdx + 1]) : MAX_FIX_ATTEMPTS;

  if (!ideaDir || args.includes('--help')) {
    console.log('用法: node ci-monitor.mjs <idea-dir> [--poll-interval 30] [--max-attempts 3]');
    process.exit(0);
  }

  if (!existsSync(ideaDir)) {
    process.stderr.write(`idea-dir not found: ${ideaDir}\n`);
    process.exit(1);
  }

  const result = monitorCi(ideaDir, { pollInterval, maxAttempts });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
