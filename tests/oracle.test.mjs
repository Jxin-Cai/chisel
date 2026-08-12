import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { prepareOracle } from '../scripts/oracle-prepare.mjs';

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

  it('prepares only the original requirement and public entry evidence, then freezes it', () => {
    const prepared = prepareOracle(ideaDir, root);
    const context = JSON.parse(readFileSync(prepared.context_path, 'utf8'));
    assert.equal(prepared.status, 'prepared');
    assert.match(context.requirement, /public value is 42/);
    assert.deepEqual(context.project.public_entries.map(entry => entry.path), ['src/index.js']);
    assert.equal(JSON.stringify(context).includes('expected_files'), false);
    assert.equal(JSON.stringify(context).includes('task_file'), false);
    writeFileSync(join(ideaDir, 'oracle/manifest.json'), JSON.stringify({ schema_version: 1, status: 'not_applicable', reason: 'test' }));
    assert.equal(prepareOracle(ideaDir, root).status, 'frozen');
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
