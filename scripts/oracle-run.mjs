#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, relative, resolve } from 'node:path';

function fail(message) {
  process.stderr.write(`${JSON.stringify({ status: 'fail', error: message })}\n`);
  process.exit(1);
}

function inside(parent, child) {
  const rel = relative(parent, child);
  return rel && !rel.startsWith('..') && !isAbsolute(rel);
}

export function runnerCommand(runner, script) {
  if (runner === 'node-test') return { command: process.execPath, args: ['--test', script] };
  if (runner === 'python-unittest') return { command: 'python3', args: ['-m', 'unittest', '-q', script] };
  if (runner === 'pytest') return { command: 'python3', args: ['-m', 'pytest', '-q', script] };
  if (runner === 'jest') return { command: 'npm', args: ['exec', '--', 'jest', '--runInBand', script] };
  if (runner === 'vitest') return { command: 'npm', args: ['exec', '--', 'vitest', 'run', script] };
  if (runner === 'go-test') return { command: 'go', args: ['test', script] };
  if (runner === 'phpunit') return { command: 'php', args: ['vendor/bin/phpunit', script] };
  if (runner === 'rspec') return { command: 'ruby', args: ['-S', 'rspec', script] };
  throw new Error(`unsupported runner: ${runner}`);
}

export function runOracle(ideaDir, projectRoot) {
  const oracleDir = join(ideaDir, 'oracle');
  const manifestPath = join(oracleDir, 'manifest.json');
  if (!existsSync(manifestPath)) throw new Error('oracle manifest missing; generate or explicitly mark it not_applicable');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (manifest.status === 'not_applicable') {
    const reasonCode = String(manifest.reason_code || '');
    if (!['no_public_entry', 'unsupported_environment', 'requirement_not_observable'].includes(reasonCode)) {
      throw new Error('not_applicable oracle requires reason_code: no_public_entry, unsupported_environment, or requirement_not_observable');
    }
    const result = { schema_version: 1, status: 'not_applicable', reason_code: reasonCode, reason: String(manifest.reason || '') };
    writeFileSync(join(oracleDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
    return result;
  }
  if (manifest.status !== 'ready') throw new Error(`invalid oracle status: ${manifest.status}`);
  if (!Number.isInteger(manifest.assertion_count) || manifest.assertion_count < 1 || manifest.assertion_count > 12) {
    throw new Error('oracle assertion_count must be an integer from 1 to 12');
  }
  const script = resolve(oracleDir, String(manifest.script || ''));
  if (!inside(oracleDir, script) || !existsSync(script)) throw new Error('oracle script must exist inside the oracle directory');
  const invocation = runnerCommand(manifest.runner, script);
  const childEnv = { ...process.env };
  // A parent `node --test` marks descendants as nested test contexts. Keeping
  // that marker makes Node silently skip the Oracle file and report a false pass.
  delete childEnv.NODE_TEST_CONTEXT;
  const execution = spawnSync(invocation.command, invocation.args, {
    cwd: projectRoot, env: childEnv, encoding: 'utf8', timeout: 120_000, maxBuffer: 10 * 1024 * 1024,
  });
  const result = {
    schema_version: 1,
    status: execution.status === 0 ? 'pass' : 'fail',
    runner: manifest.runner,
    script: relative(oracleDir, script),
    assertion_count: manifest.assertion_count,
    exit_code: execution.status,
    output: `${execution.stdout || ''}${execution.stderr || ''}`.slice(-30_000),
  };
  writeFileSync(join(oracleDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ideaDir = process.argv[2] && resolve(process.argv[2]);
  const projectRoot = resolve(process.argv[3] || '.');
  if (!ideaDir) fail('用法: oracle-run.mjs <idea-dir> [project-root]');
  try {
    const result = runOracle(ideaDir, projectRoot);
    console.log(JSON.stringify(result));
    if (result.status === 'fail') process.exit(1);
  } catch (error) { fail(error.message); }
}
