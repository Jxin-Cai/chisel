import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareOracle } from '../scripts/oracle-prepare.mjs';
import { runnerCommand } from '../scripts/oracle-run.mjs';

const runScript = new URL('../scripts/oracle-run.mjs', import.meta.url).pathname;

describe('independent acceptance oracle', () => {
  let root;
  let ideaDir;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'chisel-oracle-'));
    ideaDir = join(root, '.control', 'feature');
    mkdirSync(join(root, 'src'), { recursive: true });
    mkdirSync(ideaDir, { recursive: true });
    execFileSync('git', ['init', '-q'], { cwd: root });
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'sample', exports: './src/index.js' }));
    writeFileSync(join(root, 'src/index.js'), 'export const publicValue = () => 42;\n');
    writeFileSync(join(ideaDir, 'requirement.md'), '# Requirement\nThe public value is 42.\n');
    execFileSync('git', ['add', 'package.json', 'src/index.js'], { cwd: root });
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('prepares only the canonical requirement and public entry evidence, then freezes it', () => {
    const prepared = prepareOracle(ideaDir, root);
    const context = JSON.parse(readFileSync(prepared.context_path, 'utf8'));
    assert.equal(prepared.status, 'prepared');
    assert.equal(context.schema_version, 3);
    assert.equal(context.canonical_requirement, context.requirement);
    assert.match(context.requirement, /public value is 42/);
    assert.deepEqual(context.project.public_entries.map(entry => entry.path), ['src/index.js']);
    assert.equal(JSON.stringify(context).includes('expected_files'), false);
    assert.equal(JSON.stringify(context).includes('task_file'), false);
    assert.ok(context.allowed_runners.includes('node-test'));
    assert.ok(context.allowed_runners.includes('python-unittest'));
    writeFileSync(join(ideaDir, 'oracle/manifest.json'), JSON.stringify({ schema_version: 1, status: 'not_applicable', reason_code: 'requirement_not_observable', reason: 'test' }));
    assert.equal(prepareOracle(ideaDir, root).status, 'frozen');
  });

  it('discovers Python and Go public entries and exposes matching native runners', () => {
    writeFileSync(join(root, 'pyproject.toml'), '[project.scripts]\nhello = "app.cli:main"\n');
    mkdirSync(join(root, 'app'), { recursive: true });
    writeFileSync(join(root, 'app/cli.py'), 'def main(): return 0\n');
    writeFileSync(join(root, 'go.mod'), 'module example.com/demo\n');
    mkdirSync(join(root, 'cmd', 'demo'), { recursive: true });
    writeFileSync(join(root, 'cmd/demo/main.go'), 'package main\nfunc main() {}\n');
    execFileSync('git', ['add', '.'], { cwd: root });
    const prepared = prepareOracle(ideaDir, root);
    const context = JSON.parse(readFileSync(prepared.context_path, 'utf8'));
    assert.ok(context.project.public_entries.some(entry => entry.path === 'app/cli.py'));
    assert.ok(context.project.public_entries.some(entry => entry.path === 'cmd/demo/main.go'));
    assert.ok(context.allowed_runners.includes('go-test'));
    assert.deepEqual(runnerCommand('vitest', '/tmp/oracle.test.ts').args.slice(0, 4), ['exec', '--', 'vitest', 'run']);
  });

  it('rejects an unclassified not-applicable escape hatch', () => {
    const prepared = prepareOracle(ideaDir, root);
    writeFileSync(join(prepared.oracle_dir, 'manifest.json'), JSON.stringify({ schema_version: 1, status: 'not_applicable', reason: 'unknown' }));
    const execution = spawnSync(process.execPath, [runScript, ideaDir, root], { encoding: 'utf8' });
    assert.equal(execution.status, 1);
    assert.match(execution.stderr, /reason_code/);
  });

  it('runs a frozen node acceptance script and records pass', () => {
    const prepared = prepareOracle(ideaDir, root);
    writeFileSync(join(prepared.oracle_dir, 'acceptance.test.mjs'), `
import test from 'node:test';
import assert from 'node:assert/strict';
test('one', () => assert.equal(1, 1));
test('two', () => assert.ok(true));
test('three', () => assert.notEqual(1, 2));
`);
    writeFileSync(join(prepared.oracle_dir, 'manifest.json'), JSON.stringify({
      schema_version: 1, status: 'ready', runner: 'node-test', script: 'acceptance.test.mjs', assertion_count: 3,
    }));
    const execution = spawnSync(process.execPath, [runScript, ideaDir, root], { encoding: 'utf8' });
    assert.equal(execution.status, 0, execution.stderr);
    assert.equal(JSON.parse(readFileSync(join(prepared.oracle_dir, 'result.json'), 'utf8')).status, 'pass');
  });

  it('turns assertion failure into a non-zero repair signal without rewriting the oracle', () => {
    const prepared = prepareOracle(ideaDir, root);
    writeFileSync(join(prepared.oracle_dir, 'acceptance.test.mjs'), `
import test from 'node:test';
import assert from 'node:assert/strict';
test('one', () => assert.equal(1, 2));
test('two', () => assert.ok(true));
test('three', () => assert.notEqual(1, 2));
`);
    writeFileSync(join(prepared.oracle_dir, 'manifest.json'), JSON.stringify({
      schema_version: 1, status: 'ready', runner: 'node-test', script: 'acceptance.test.mjs', assertion_count: 3,
    }));
    const before = readFileSync(join(prepared.oracle_dir, 'acceptance.test.mjs'), 'utf8');
    const execution = spawnSync(process.execPath, [runScript, ideaDir, root], { encoding: 'utf8' });
    assert.equal(execution.status, 1, `${execution.stdout}\n${execution.stderr}`);
    assert.equal(JSON.parse(readFileSync(join(prepared.oracle_dir, 'result.json'), 'utf8')).status, 'fail');
    assert.equal(readFileSync(join(prepared.oracle_dir, 'acceptance.test.mjs'), 'utf8'), before);
  });
});
