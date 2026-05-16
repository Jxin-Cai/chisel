import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { checkGate } from '../scripts/gate-check.mjs';

const TEST_DIR = join(import.meta.dirname, '.tmp-test-gate');

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

function writeFile(rel, content) {
  const path = join(TEST_DIR, rel);
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, content);
}

describe('gate: requirement-exists', () => {
  it('fails when missing', () => {
    assert.equal(checkGate(TEST_DIR, 'requirement-exists').pass, false);
  });

  it('passes when present', () => {
    writeFile('requirement.md', '# Requirement');
    assert.equal(checkGate(TEST_DIR, 'requirement-exists').pass, true);
  });
});

describe('gate: as-is-complete', () => {
  function writeMainFiles(overrides = {}) {
    const defaults = {
      'as-is/overview.md': '# Overview\n```mermaid\ngraph TD\n  A-->B\n```\n### 需求摘要\n### 当前能力边界\n### 待澄清问题\n',
      'as-is/core-walkthrough.md': '# Core\n```mermaid\nsequenceDiagram\n  A->>B: call\n```\n',
      'as-is/evidence-index.md': '| 结论 | 证据 | 类型 |\n|---|---|---|\n| A | f:1 | 已确认 |\n| B | f:2 | 已确认 |\n| C | f:3 | 已确认 |\n| D | f:4 | 已确认 |\n| E | f:5 | 已确认 |\n',
      'as-is/knowledge-candidates.md': '# Candidates\n'
    };
    for (const [file, content] of Object.entries({ ...defaults, ...overrides })) {
      writeFile(file, content);
    }
  }

  it('fails when main files missing', () => {
    const r = checkGate(TEST_DIR, 'as-is-complete');
    assert.equal(r.pass, false);
    assert.match(r.reason, /missing main files/);
  });

  it('fails when overview missing sections', () => {
    writeMainFiles({ 'as-is/overview.md': '# Overview\n```mermaid\ngraph TD\n  A-->B\n```\n' });
    const r = checkGate(TEST_DIR, 'as-is-complete');
    assert.equal(r.pass, false);
    assert.match(r.reason, /需求摘要/);
  });

  it('fails when main files lack Mermaid', () => {
    writeMainFiles({ 'as-is/core-walkthrough.md': '# Core\nno diagrams here\n' });
    const r = checkGate(TEST_DIR, 'as-is-complete');
    assert.equal(r.pass, false);
    assert.match(r.reason, /Mermaid/);
  });

  it('fails when evidence-index too short', () => {
    writeMainFiles({ 'as-is/evidence-index.md': '| A | B |\n' });
    const r = checkGate(TEST_DIR, 'as-is-complete');
    assert.equal(r.pass, false);
    assert.match(r.reason, /evidence-index/);
  });

  it('passes with complete main files', () => {
    writeMainFiles();
    assert.equal(checkGate(TEST_DIR, 'as-is-complete').pass, true);
  });
});

describe('gate: as-is-confirmed', () => {
  it('fails without .as-is-confirmed', () => {
    assert.equal(checkGate(TEST_DIR, 'as-is-confirmed').pass, false);
  });

  it('fails without clarifications.md', () => {
    writeFile('.as-is-confirmed', '');
    const r = checkGate(TEST_DIR, 'as-is-confirmed');
    assert.equal(r.pass, false);
    assert.match(r.reason, /clarifications/);
  });

  it('passes with both files', () => {
    writeFile('.as-is-confirmed', '');
    writeFile('clarifications.md', '');
    assert.equal(checkGate(TEST_DIR, 'as-is-confirmed').pass, true);
  });
});

describe('gate: to-be-exists', () => {
  it('fails when plan missing', () => {
    const r = checkGate(TEST_DIR, 'to-be-exists');
    assert.equal(r.pass, false);
  });

  it('fails when plan missing required sections', () => {
    writeFile('to-be/implementation-plan.md', '# Plan\n## 目标行为\n');
    const r = checkGate(TEST_DIR, 'to-be-exists');
    assert.equal(r.pass, false);
    assert.match(r.reason, /missing required sections/);
  });

  it('passes with all required sections', () => {
    writeFile('to-be/implementation-plan.md', [
      '# Plan',
      '## 目标行为',
      '## 非目标行为',
      '## 允许修改范围',
      '## 禁止修改范围',
      '## Task 拆分建议',
      ''
    ].join('\n'));
    assert.equal(checkGate(TEST_DIR, 'to-be-exists').pass, true);
  });
});

describe('gate: ai-input-ready', () => {
  it('fails when files missing', () => {
    const r = checkGate(TEST_DIR, 'ai-input-ready');
    assert.equal(r.pass, false);
    assert.match(r.reason, /missing ai-input files/);
  });

  it('passes when all 6 files exist', () => {
    const files = ['facts.md', 'call-graph.md', 'data-schema.md', 'api-surface.md', 'constraints.md', 'change-surface.md'];
    for (const f of files) writeFile(`as-is/ai-input/${f}`, '# Content');
    assert.equal(checkGate(TEST_DIR, 'ai-input-ready').pass, true);
  });
});

describe('gate: unknown', () => {
  it('returns false for unknown gate', () => {
    const r = checkGate(TEST_DIR, 'nonexistent');
    assert.equal(r.pass, false);
    assert.match(r.reason, /unknown gate/);
  });
});
