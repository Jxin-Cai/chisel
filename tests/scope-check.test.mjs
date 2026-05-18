import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkScope } from '../scripts/scope-check.mjs';
import { writeTaskState, taskStateFile } from '../scripts/workflow-lib.mjs';

const TEST_DIR = join(import.meta.dirname, '.tmp-test-scope-check');
const IDEA_DIR = join(TEST_DIR, '.chisel/idea');
const WIKI_PROJECT = '.tmp-test-scope-check';

beforeEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
  mkdirSync(IDEA_DIR, { recursive: true });
  execFileSync('git', ['init'], { cwd: TEST_DIR, stdio: 'ignore' });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function writeFile(rel, content) {
  const path = join(TEST_DIR, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function writeIdeaFile(rel, content) {
  const path = join(IDEA_DIR, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

function writeTask({ expected = ['src/user.ts'], forbidden = [], allowedSymbols = [], forbiddenSymbols = [], behaviorInvariants = ['旧接口响应字段保持不变'] } = {}) {
  writeTaskState(taskStateFile(IDEA_DIR), {
    idea: 'test',
    tasks: {
      'task-001': {
        status: 'confirmed',
        depends_on: [],
        description: 'Task',
        file: 'tasks/task-001.md',
        expected_files: expected,
        report_file: 'task-reports/task-001-report.md',
        cr_file: 'cr/task-001-cr.md',
        rework_count: 0,
        changed_files: [],
        loc_added: 0,
        loc_deleted: 0
      }
    }
  });
  writeIdeaFile('tasks/task-001.md', `---
task_id: task-001
status: confirmed
expected_files: [${expected.join(', ')}]
allowed_symbols: [${allowedSymbols.join(', ')}]
forbidden_symbols: [${forbiddenSymbols.join(', ')}]
---

# Task

## Scope

### Forbidden Files / Areas

${forbidden.map(item => `- ${item}`).join('\n') || '- 无'}

### Allowed Symbols

${allowedSymbols.map(item => `- ${item}`).join('\n') || '- 无'}

### Forbidden Symbols

${forbiddenSymbols.map(item => `- ${item}`).join('\n') || '- 无'}

## Behavior Invariants

${behaviorInvariants.map(item => `- [ ] ${item}`).join('\n') || '- [ ] 无'}
`);
}

function check() {
  return checkScope(IDEA_DIR, 'task-001', TEST_DIR);
}

describe('scope-check hit proofs', () => {
  it('generates hit proofs for exact expected matches', () => {
    writeTask({ expected: ['src/user.ts'] });
    writeFile('src/user.ts', 'export const user = 1;\n');

    const result = check();

    assert.equal(result.schema_version, 3);
    assert.equal(result.pass, true);
    assert.deepEqual(result.changed_files, ['src/user.ts']);
    assert.equal(result.hit_proofs[0].status, 'within_expected');
    assert.deepEqual(result.hit_proofs[0].expected[0], {
      pattern: 'src/user.ts',
      source: 'task.frontmatter.expected_files',
      match_type: 'exact'
    });
    assert.equal(result.summary.violations_count, 0);
  });

  it('supports glob double star expected matches', () => {
    writeTask({ expected: ['src/user/**'] });
    writeFile('src/user/service.ts', 'export const service = 1;\n');

    const result = check();

    assert.equal(result.pass, true);
    assert.equal(result.hit_proofs[0].expected[0].match_type, 'glob_double_star');
  });

  it('reports forbidden symbol hits inside expected files', () => {
    writeTask({ expected: ['src/user.ts'], forbiddenSymbols: ['LegacyResponseShape'] });
    writeFile('src/user.ts', 'export const LegacyResponseShape = {};\n');

    const result = check();

    assert.equal(result.pass, false);
    assert.equal(result.violations[0].type, 'forbidden_symbol');
    assert.equal(result.symbol_scope.hits[0].forbidden[0], 'LegacyResponseShape');
    assert.equal(result.summary.forbidden_symbol_hits_count, 1);
  });

  it('reports allowed symbol hits inside expected files', () => {
    writeTask({ expected: ['src/user.ts'], allowedSymbols: ['UserService.create'] });
    writeFile('src/user.ts', 'UserService.create({ name });\n');

    const result = check();

    assert.equal(result.pass, true);
    assert.equal(result.symbol_scope.hits[0].allowed[0], 'UserService.create');
  });

  it('reports unexpected files outside expected scope', () => {
    writeTask({ expected: ['src/user.ts'] });
    writeFile('src/order.ts', 'export const order = 1;\n');

    const result = check();

    assert.equal(result.pass, false);
    assert.equal(result.hit_proofs[0].status, 'unexpected');
    assert.equal(result.violations[0].type, 'unexpected');
    assert.equal(result.summary.unexpected_files_count, 1);
  });

  it('reports task forbidden matches with proof', () => {
    writeTask({ expected: ['src/**'], forbidden: ['src/legacy-response.ts'] });
    writeFile('src/legacy-response.ts', 'export const legacy = 1;\n');

    const result = check();

    assert.equal(result.pass, false);
    assert.equal(result.hit_proofs[0].status, 'forbidden');
    assert.equal(result.violations[0].type, 'forbidden');
    assert.deepEqual(result.violations[0].proof, {
      pattern: 'src/legacy-response.ts',
      source: 'task-file.forbidden-section',
      match_type: 'exact'
    });
  });

  it('marks files as both forbidden and unexpected', () => {
    writeTask({ expected: ['src/user.ts'], forbidden: ['src/legacy-response.ts'] });
    writeFile('src/legacy-response.ts', 'export const legacy = 1;\n');

    const result = check();

    assert.equal(result.pass, false);
    assert.equal(result.hit_proofs[0].status, 'forbidden_and_unexpected');
    assert.deepEqual(result.violations.map(v => v.type).sort(), ['forbidden', 'unexpected']);
  });

  it('detects wiki forbidden zones in inline format', () => {
    writeTask({ expected: ['src/**'] });
    writeFile(`.chisel/wiki/${WIKI_PROJECT}/forbidden-zones.md`, '# Forbidden\n\n### FZ-001\n\n**范围：** src/legacy-response.ts\n');
    writeFile('src/legacy-response.ts', 'export const legacy = 1;\n');

    const result = check();

    assert.equal(result.pass, false);
    assert.equal(result.violations[0].proof.source, 'wiki.forbidden-zones');
  });

  it('detects wiki forbidden zones in template path format', () => {
    writeTask({ expected: ['src/**'] });
    writeFile(`.chisel/wiki/${WIKI_PROJECT}/forbidden-zones.md`, '# Forbidden\n\n### FZ-001\n\n**范围：**\n\n- 路径：src/legacy-response.ts\n- 模块：UserService\n');
    writeFile('src/legacy-response.ts', 'export const legacy = 1;\n');

    const result = check();

    assert.equal(result.pass, false);
    assert.equal(result.forbidden_scope.includes('src/legacy-response.ts'), true);
    assert.equal(result.forbidden_scope.includes('UserService'), false);
  });

  it('detects wiki forbidden zones in direct bullet glob format', () => {
    writeTask({ expected: ['src/**'] });
    writeFile(`.chisel/wiki/${WIKI_PROJECT}/forbidden-zones.md`, '# Forbidden\n\n### FZ-001\n\n**范围：**\n\n- src/legacy/**\n');
    writeFile('src/legacy/response.ts', 'export const legacy = 1;\n');

    const result = check();

    assert.equal(result.pass, false);
    assert.equal(result.hit_proofs[0].forbidden[0].match_type, 'glob_double_star');
  });

  it('does not treat non-path wiki notes as forbidden patterns', () => {
    writeTask({ expected: ['src/**'] });
    writeFile(`.chisel/wiki/${WIKI_PROJECT}/forbidden-zones.md`, '# Forbidden\n\n### FZ-001\n\n**范围：**\n\n- 接口 / 行为：旧响应字段结构\n');
    writeFile('src/user.ts', 'export const user = 1;\n');

    const result = check();

    assert.equal(result.pass, true);
    assert.deepEqual(result.forbidden_scope, []);
  });

  it('includes untracked files in changed files', () => {
    writeTask({ expected: ['src/user.ts'] });
    writeFile('src/new-file.ts', 'export const created = 1;\n');

    const result = check();

    assert.equal(result.changed_files.includes('src/new-file.ts'), true);
    assert.equal(result.pass, false);
  });

  it('filters .chisel internal changes', () => {
    writeTask({ expected: ['src/user.ts'] });
    writeFile('.chisel/idea/task-reports/task-001-report.md', '# report\n');

    const result = check();

    assert.deepEqual(result.changed_files, []);
    assert.equal(result.pass, true);
  });
});
