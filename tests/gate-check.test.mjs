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

function writeTaskState(tasks) {
  writeFile('task-workflow-state.yaml', [
    'idea: test',
    'tasks:',
    ...Object.entries(tasks).flatMap(([taskId, task]) => [
      `  ${taskId}:`,
      `    status: ${task.status || 'confirmed'}`,
      `    depends_on: [${(task.depends_on || []).join(', ')}]`,
      `    description: "${task.description || ''}"`,
      `    file: "${task.file || `tasks/${taskId}.md`}"`,
      `    expected_files: [${(task.expected_files || []).join(', ')}]`,
      `    report_file: "${task.report_file || `task-reports/${taskId}-report.md`}"`,
      `    cr_file: "${task.cr_file || `cr/${taskId}-cr.md`}"`,
      `    rework_count: ${task.rework_count || 0}`,
      '    changed_files: []',
      '    loc_added: 0',
      '    loc_deleted: 0'
    ]),
    ''
  ].join('\n'));
}

function writeEvidenceLedger(facts = [{ id: 'F-001', claim: '用户创建走 UserService', status: 'confirmed', evidence: [{ file: 'src/user.ts', line_start: 42, line_end: 80, kind: 'code' }] }]) {
  writeFile('as-is/evidence-ledger.json', JSON.stringify({ facts }, null, 2));
}

function writeTraceabilityMatrix(items = [{ id: 'REQ-001', type: 'goal', source: 'requirement.md', description: '实现目标', covered_by_tasks: ['task-001'], verification: ['node --test'] }]) {
  writeFile('to-be/traceability-matrix.json', JSON.stringify({ items }, null, 2));
}

function validTasksJson(overrides = {}) {
  return {
    tasks: [{
      task_id: 'task-001',
      title: '实现目标',
      goal: '实现目标',
      depends_on: [],
      allowed_files: ['src/a.ts'],
      forbidden_files: [],
      expected_files: ['src/a.ts'],
      acceptance_criteria: ['满足需求'],
      verification: ['node --test'],
      trace_refs: ['REQ-001'],
      allowed_symbols: ['UserService.create'],
      forbidden_symbols: [],
      behavior_invariants: ['保持旧行为'],
      impact_surface: { files: ['src/a.ts'], symbols: ['UserService.create'], invariants: ['保持旧行为'], shared_state: [] },
      context_to_load: { as_is: ['as-is/ai-input/facts.md'], to_be: ['to-be/implementation-plan.md'], wiki: [], module_map: [], adr: [], tests: [] },
      risk_level: 'low',
      rollback: 'revert commit',
      ...overrides
    }]
  };
}

function writeTasksJson(overrides = {}) {
  writeFile('to-be/tasks.json', JSON.stringify(validTasksJson(overrides), null, 2));
}

function sourceCoverage(source = 'as-is/evidence-ledger.json', refs = 'F-001') {
  return `## Source Coverage\n\n| Source | Covered refs | Omissions | Reason |\n|---|---|---|---|\n| ${source} | ${refs} | 无 | — |\n\n`;
}

function validCoverageMatrix(overrides = {}) {
  return {
    schema_version: 1,
    entrypoints: [{ id: 'E-001', type: 'http', name: 'POST /users', location: { file: 'src/user.ts', line_start: 10 }, covered_by_facts: ['F-001'] }],
    links: [{ id: 'L-001', from: 'Controller.create', to: 'UserService.create', kind: 'sync-call', evidence: [{ file: 'src/user.ts', line_start: 42 }], covered_by_facts: ['F-001'] }],
    data: [{ id: 'D-001', entity: 'user', operation: 'write', fields: ['id'], evidence: [{ file: 'src/user.ts', line_start: 70 }] }],
    side_effects: [{ id: 'S-001', kind: 'db_write', description: '写入 user', evidence: [{ file: 'src/user.ts', line_start: 80 }] }],
    not_applicable: {},
    ...overrides
  };
}

function writeCoverageMatrix(overrides = {}) {
  writeFile('as-is/coverage-matrix.json', JSON.stringify(validCoverageMatrix(overrides), null, 2));
}

function validClarificationsJson(overrides = {}) {
  return {
    schema_version: 1,
    source_step: 'understand:confirm',
    confirmed_at: '2026-05-18T00:00:00.000Z',
    summary: '用户确认 AS_IS。',
    decisions: [{ id: 'C-001', question: '旧接口响应字段是否必须保持？', decision: '必须保持', rationale: '旧客户端依赖', status: 'confirmed', source: 'as-is/overview.md#用户确认清单' }],
    answers: [],
    unresolved: [],
    constraints_added: [],
    knowledge_signals: [],
    ...overrides
  };
}

function writeClarificationsJson(overrides = {}) {
  writeFile('clarifications.json', JSON.stringify(validClarificationsJson(overrides), null, 2));
}

function validAsIsConfirmation(overrides = {}) {
  return {
    schema_version: 1,
    phase: 'as-is',
    status: 'confirmed',
    confirmed_at: '2026-05-18T00:00:00.000Z',
    confirmed_by: 'user',
    source_files: ['as-is/overview.md', 'as-is/core-walkthrough.md', 'as-is/evidence-index.md', 'as-is/evidence-ledger.json', 'as-is/coverage-matrix.json', 'clarifications.json'],
    checklist: [{ id: 'C-001', status: 'confirmed' }],
    ...overrides
  };
}

function writeAsIsConfirmation(overrides = {}) {
  writeFile('confirmations/as-is.json', JSON.stringify(validAsIsConfirmation(overrides), null, 2));
}

function validToBeConfirmation(overrides = {}) {
  return {
    schema_version: 1,
    phase: 'to-be',
    status: 'confirmed',
    confirmed_at: '2026-05-18T00:00:00.000Z',
    confirmed_by: 'user',
    source_files: ['to-be/implementation-plan.md', 'to-be/tasks.json', 'to-be/traceability-matrix.json'],
    task_acknowledgement: { task_ids: ['task-001'], dependencies_reviewed: true, verification_reviewed: true },
    risk_acknowledgement: { reviewed: true, notes: '低风险' },
    ...overrides
  };
}

function writeToBeConfirmation(overrides = {}) {
  writeFile('confirmations/to-be.json', JSON.stringify(validToBeConfirmation(overrides), null, 2));
}

function writeValidAiInput({ facts = '', constraints = '', changeSurface = '', clarifications = '' } = {}) {
  writeFile('clarifications.md', clarifications);
  writeEvidenceLedger();
  writeFile('as-is/ai-input/facts.md', facts || `${sourceCoverage()}## 已确认事实\n\n- [F-001] 用户创建走 UserService | 证据: src/user.ts:42\n`);
  writeFile('as-is/ai-input/call-graph.md', '# Call graph\n');
  writeFile('as-is/ai-input/data-schema.md', '# Data schema\n');
  writeFile('as-is/ai-input/api-surface.md', '# API surface\n');
  writeFile('as-is/ai-input/constraints.md', constraints || `${sourceCoverage('as-is/overview.md + clarifications.md', 'C-001')}## 禁区\n\n- 无\n\n## 包袱\n\n- 无\n\n## 坏味道\n\n- 无\n\n## 兼容约束\n\n- 无\n`);
  writeFile('as-is/ai-input/change-surface.md', changeSurface || `${sourceCoverage('as-is/core-walkthrough.md', 'F-001')}## Safe-to-Change Areas\n\n- src/user.ts:42-80 可增加校验\n`);
}

function validTaskFile(expectedFiles = ['src/a.ts'], invariants = ['保持旧行为']) {
  const invariantLines = invariants.map(invariant => `- [ ] ${invariant}`).join('\n');
  return `---
task_id: task-001
status: confirmed
depends_on: []
description: "Task"
expected_files: [${expectedFiles.join(', ')}]
trace_refs: [REQ-001]
allowed_symbols: [UserService.create]
forbidden_symbols: [LegacyResponseShape]
impact_surface: {"files":["src/a.ts"],"symbols":["UserService.create"],"invariants":["保持旧行为"],"shared_state":[]}
---

# Task

## 目标行为

实现目标。

## Scope

### Allowed Files / Areas

- src/a.ts

### Forbidden Files / Areas

- 无

### Allowed Symbols

- UserService.create

### Forbidden Symbols

- LegacyResponseShape

## Impact Surface

- files：[src/a.ts]
- symbols：[UserService.create]
- invariants：[保持旧行为]
- shared_state：[]

## Context to Load

- as-is：as-is/ai-input/facts.md

## Traceability

- REQ-001

## Behavior Invariants

${invariantLines}

## Acceptance Criteria

- [ ] 行为生效

## Verification

\`\`\`bash
node --test
\`\`\`
`;
}

function wikiProof() {
  return `## Wiki Entries Loaded

| Entry | File | Why Loaded | Used For |
|---|---|---|---|
| None matched | — | 无命中 | — |

## Progressive Load Proof

- Query command：node scripts/wiki-manage.mjs --query . --text "task" --category "" --min-score 2 --load-plan --limit 10
- Query summary：命中 0 条，must_load 0 条，optional_load 0 条
- category/min-score：空 / 2
- load_plan：{"must_load":[],"optional_load":[],"skip":[]}
- None matched：无命中
`;
}

function scopeProof({ mode = 'report', result = 'pass', invariantRows = '| 保持旧行为 | 已验证旧行为 | pass |' } = {}) {
  const heading = mode === 'cr' ? 'Hit Proofs Reviewed' : 'Hit Proofs Summary';
  const lastColumn = mode === 'cr' ? 'Reviewer assessment' : 'Status';
  const lastValue = mode === 'cr' ? 'OK' : 'within_expected';
  const runHeading = mode === 'cr' ? 'Scope Check Re-run' : 'Scope Check Proof';
  return `### ${runHeading}

- Command：node scripts/scope-check.mjs .chisel/idea task-001
- Result：${result}
- schema_version：3
- changed_files_count：1
- violations_count：${result === 'pass' ? 0 : 1}
- forbidden_symbol_hits_count：0

#### Scope Check JSON Summary

\`\`\`json
{"task_id":"task-001","pass":${result === 'pass'},"changed_files":["src/a.ts"],"violations":[],"summary":{"violations_count":${result === 'pass' ? 0 : 1}}}
\`\`\`

#### ${heading}

| File | Expected proof | Forbidden proof | Symbol proof | ${lastColumn} |
|---|---|---|---|---|
| src/a.ts | src/a.ts from task.frontmatter.expected_files exact | none | allowed: UserService.create | ${lastValue} |

#### Invariant Proofs

| Invariant | Proof | Result |
|---|---|---|
${invariantRows}
`;
}

function validReport({ includeWikiProof = true, includeScopeProof = true, invariantRows } = {}) {
  return `# Task Report

## 做了什么

实现目标。

## 改了什么

| 文件 | 修改点 | 是否在 expected_files 内 |
|---|---|---|
| src/a.ts | 修改 | Yes |

## 验证

通过。

${includeWikiProof ? wikiProof() : ''}

## Scope Control

${includeScopeProof ? scopeProof({ invariantRows }) : ''}
`;
}

function validCr(result = 'approved', { includeWikiProof = true, includeScopeProof = true, scopeResult = 'pass', invariantRows } = {}) {
  const rework = result === 'needs_rework' ? '\n- [ ] CR-001：修复 src/a.ts 的边界行为\n' : '\n- [ ] 无\n';
  return `---
task_id: task-001
result: ${result}
rework_count: 0
---

# CR

## 结论

${result}

## 功能完整度

OK

## Scope Control

${includeScopeProof ? scopeProof({ mode: 'cr', result: scopeResult, invariantRows }) : 'OK'}

## Verification

- 已复跑的验证命令：node --test
- 结果：通过

${includeWikiProof ? wikiProof() : ''}

## Rework Items
${rework}
`;
}

describe('gate: requirement-exists', () => {
  it('fails when missing', () => {
    assert.equal(checkGate(TEST_DIR, 'requirement-exists').pass, false);
  });

  it('fails when file is empty', () => {
    writeFile('requirement.md', '');
    const r = checkGate(TEST_DIR, 'requirement-exists');
    assert.equal(r.pass, false);
    assert.match(r.reason, /insufficient content/);
  });

  it('fails when file has only a heading', () => {
    writeFile('requirement.md', '# Requirement\n');
    const r = checkGate(TEST_DIR, 'requirement-exists');
    assert.equal(r.pass, false);
    assert.match(r.reason, /insufficient content/);
  });

  it('passes when file has meaningful content', () => {
    writeFile('requirement.md', '# Requirement\n\n## 需求目标\n\n在用户创建时增加空名称校验。\n\n## 背景\n\n当前系统允许空名称用户。\n');
    assert.equal(checkGate(TEST_DIR, 'requirement-exists').pass, true);
  });
});

describe('gate: as-is-complete', () => {
  function validOverview() {
    return '# Overview\n```mermaid\ngraph TD\n  A-->B\n```\n### 3分钟摘要\n\n- 一句话目标：理解用户创建\n- 当前主链路：A 到 B\n- 本次最可能改动的点：src/user.ts\n- 最大风险：兼容旧接口\n\n### 读者导航\n\n| 如果你想了解 | 先看 | 再看 |\n|---|---|---|\n| 业务主链路 | overview.md#3分钟摘要 | core-walkthrough.md |\n\n### 需求摘要\n\n新增用户校验。\n\n### 系统全景\n\nA 到 B。\n\n### 当前能力边界\n\n当前支持创建用户。\n\n### 核心事实\n\n- UserService 处理创建 | 证据: src/user.ts:42\n\n### 风险地图\n\n| 风险 | 影响区域 | 证据 | 缓解建议 |\n|---|---|---|---|\n| 旧接口兼容 | src/user.ts | src/user.ts:42 | 保持响应字段 |\n\n### 常见误解点\n\n| 容易误解为 | 实际情况 | 证据/置信度 |\n|---|---|---|\n| 可以重构用户模块 | 只能加校验 | src/user.ts:42 |\n\n### 用户确认清单\n\n- [ ] C-001 需确认事实：旧接口响应字段是否必须保持\n\n### 待澄清问题\n\n- 旧接口响应是否兼容？\n';
  }

  function writeMainFiles(overrides = {}) {
    const defaults = {
      'as-is/overview.md': validOverview(),
      'as-is/core-walkthrough.md': '# Core\n```mermaid\nsequenceDiagram\n  A->>B: call\n```\n',
      'as-is/evidence-index.md': '| 结论 | 证据 | 类型 |\n|---|---|---|\n| [F-001] A | src/user.ts:42 | 已确认 |\n| B | f:2 | 已确认 |\n| C | f:3 | 已确认 |\n| D | f:4 | 已确认 |\n| E | f:5 | 已确认 |\n',
      'as-is/evidence-ledger.json': JSON.stringify({ facts: [{ id: 'F-001', claim: 'UserService 处理创建', status: 'confirmed', evidence: [{ file: 'src/user.ts', line_start: 42, line_end: 80, kind: 'code' }] }] }, null, 2),
      'as-is/coverage-matrix.json': JSON.stringify(validCoverageMatrix(), null, 2),
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

  it('fails when overview lacks 3分钟摘要', () => {
    writeMainFiles({ 'as-is/overview.md': validOverview().replace('### 3分钟摘要', '### 快速摘要') });
    const r = checkGate(TEST_DIR, 'as-is-complete');
    assert.equal(r.pass, false);
    assert.match(r.reason, /3分钟摘要/);
  });

  it('fails when overview lacks 读者导航', () => {
    writeMainFiles({ 'as-is/overview.md': validOverview().replace('### 读者导航', '### 阅读顺序') });
    const r = checkGate(TEST_DIR, 'as-is-complete');
    assert.equal(r.pass, false);
    assert.match(r.reason, /读者导航/);
  });

  it('fails when overview lacks 风险地图', () => {
    writeMainFiles({ 'as-is/overview.md': validOverview().replace('### 风险地图', '### 风险') });
    const r = checkGate(TEST_DIR, 'as-is-complete');
    assert.equal(r.pass, false);
    assert.match(r.reason, /风险地图/);
  });

  it('fails when overview lacks 常见误解点', () => {
    writeMainFiles({ 'as-is/overview.md': validOverview().replace('### 常见误解点', '### 误解点') });
    const r = checkGate(TEST_DIR, 'as-is-complete');
    assert.equal(r.pass, false);
    assert.match(r.reason, /常见误解点/);
  });

  it('fails when overview lacks 用户确认清单', () => {
    writeMainFiles({ 'as-is/overview.md': validOverview().replace('### 用户确认清单', '### 确认清单') });
    const r = checkGate(TEST_DIR, 'as-is-complete');
    assert.equal(r.pass, false);
    assert.match(r.reason, /用户确认清单/);
  });

  it('fails when overview confirmation checklist is empty', () => {
    writeMainFiles({ 'as-is/overview.md': validOverview().replace('- [ ] C-001 需确认事实：旧接口响应字段是否必须保持', '- [ ] 需确认事实：') });
    const r = checkGate(TEST_DIR, 'as-is-complete');
    assert.equal(r.pass, false);
    assert.match(r.reason, /用户确认清单/);
  });

  it('allows overview confirmation checklist to explicitly say none needed', () => {
    writeMainFiles({ 'as-is/overview.md': validOverview().replace('- [ ] C-001 需确认事实：旧接口响应字段是否必须保持', '无需用户确认') });
    assert.equal(checkGate(TEST_DIR, 'as-is-complete').pass, true);
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

  it('fails when coverage matrix references unknown facts', () => {
    writeMainFiles({ 'as-is/coverage-matrix.json': JSON.stringify(validCoverageMatrix({ entrypoints: [{ id: 'E-001', type: 'http', name: 'POST /users', location: { file: 'src/user.ts', line_start: 10 }, covered_by_facts: ['F-999'] }] }), null, 2) });
    const r = checkGate(TEST_DIR, 'as-is-complete');
    assert.equal(r.pass, false);
    assert.match(r.reason, /unknown facts/);
  });

  it('fails when coverage matrix section is empty without not_applicable reason', () => {
    writeMainFiles({ 'as-is/coverage-matrix.json': JSON.stringify(validCoverageMatrix({ data: [] }), null, 2) });
    const r = checkGate(TEST_DIR, 'as-is-complete');
    assert.equal(r.pass, false);
    assert.match(r.reason, /data/);
  });

  it('passes when a coverage matrix section has not_applicable reason', () => {
    writeMainFiles({ 'as-is/coverage-matrix.json': JSON.stringify(validCoverageMatrix({ data: [], not_applicable: { data: '不涉及数据读写' } }), null, 2) });
    assert.equal(checkGate(TEST_DIR, 'as-is-complete').pass, true);
  });

  it('passes with complete main files', () => {
    writeMainFiles();
    assert.equal(checkGate(TEST_DIR, 'as-is-complete').pass, true);
  });
});

describe('gate: as-is-confirmed', () => {
  it('fails without structured confirmation or legacy marker', () => {
    const r = checkGate(TEST_DIR, 'as-is-confirmed');
    assert.equal(r.pass, false);
    assert.match(r.reason, /confirmations\/as-is\.json/);
  });

  it('fails without clarifications.md', () => {
    writeFile('.as-is-confirmed', '');
    const r = checkGate(TEST_DIR, 'as-is-confirmed');
    assert.equal(r.pass, false);
    assert.match(r.reason, /clarifications/);
  });

  it('fails when confirmation items lack decision records', () => {
    writeFile('as-is/overview.md', '### 用户确认清单\n\n- [ ] C-001 需确认事实：旧接口响应字段是否必须保持\n');
    writeFile('.as-is-confirmed', '');
    writeFile('clarifications.md', '# Clarifications\n');
    const r = checkGate(TEST_DIR, 'as-is-confirmed');
    assert.equal(r.pass, false);
    assert.match(r.reason, /逐项决策记录/);
  });

  it('passes legacy marker with decision records for confirmation items', () => {
    writeFile('as-is/overview.md', '### 用户确认清单\n\n- [ ] C-001 需确认事实：旧接口响应字段是否必须保持\n');
    writeFile('.as-is-confirmed', '');
    writeFile('clarifications.md', '# Clarifications\n\n## 逐项决策记录\n\n| ID | 问题 | 用户决策 | 理由 | 状态 |\n|---|---|---|---|---|\n| C-001 | 旧接口响应字段是否必须保持 | 必须保持 | 旧客户端依赖 | confirmed |\n');
    const r = checkGate(TEST_DIR, 'as-is-confirmed');
    assert.equal(r.pass, true);
    assert.equal(r.legacy, true);
  });

  it('passes with structured as-is confirmation', () => {
    writeFile('as-is/overview.md', '### 用户确认清单\n\n- [ ] C-001 需确认事实：旧接口响应字段是否必须保持\n');
    writeClarificationsJson();
    writeAsIsConfirmation();
    assert.equal(checkGate(TEST_DIR, 'as-is-confirmed').pass, true);
  });

  it('fails when structured clarifications miss a confirmation item', () => {
    writeFile('as-is/overview.md', '### 用户确认清单\n\n- [ ] C-001 需确认事实：旧接口响应字段是否必须保持\n');
    writeClarificationsJson({ decisions: [] });
    writeAsIsConfirmation();
    const r = checkGate(TEST_DIR, 'as-is-confirmed');
    assert.equal(r.pass, false);
    assert.match(r.reason, /C-001/);
  });

  it('passes without decision records when no confirmation is needed', () => {
    writeFile('as-is/overview.md', '### 用户确认清单\n\n无需用户确认\n');
    writeFile('.as-is-confirmed', '');
    writeFile('clarifications.md', '');
    assert.equal(checkGate(TEST_DIR, 'as-is-confirmed').pass, true);
  });
});

describe('gate: to-be-confirmed', () => {
  it('fails without structured confirmation or legacy marker', () => {
    const r = checkGate(TEST_DIR, 'to-be-confirmed');
    assert.equal(r.pass, false);
    assert.match(r.reason, /confirmations\/to-be\.json/);
  });

  it('fails when marker exists but plan is missing', () => {
    writeFile('.to-be-confirmed', '');
    const r = checkGate(TEST_DIR, 'to-be-confirmed');
    assert.equal(r.pass, false);
    assert.match(r.reason, /implementation-plan.md is missing/);
  });

  it('passes legacy marker when plan exists', () => {
    writeFile('.to-be-confirmed', '');
    writeFile('to-be/implementation-plan.md', '# Plan\n');
    const r = checkGate(TEST_DIR, 'to-be-confirmed');
    assert.equal(r.pass, true);
    assert.equal(r.legacy, true);
  });

  it('passes with structured to-be confirmation', () => {
    writeFile('to-be/implementation-plan.md', '# Plan\n');
    writeTasksJson();
    writeTraceabilityMatrix();
    writeToBeConfirmation();
    assert.equal(checkGate(TEST_DIR, 'to-be-confirmed').pass, true);
  });

  it('fails when structured to-be confirmation misses a task', () => {
    writeFile('to-be/implementation-plan.md', '# Plan\n');
    writeTasksJson();
    writeTraceabilityMatrix();
    writeToBeConfirmation({ task_acknowledgement: { task_ids: [], dependencies_reviewed: true, verification_reviewed: true } });
    const r = checkGate(TEST_DIR, 'to-be-confirmed');
    assert.equal(r.pass, false);
    assert.match(r.reason, /task-001/);
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

  it('fails when tasks.json is missing', () => {
    writeFile('to-be/implementation-plan.md', [
      '# Plan',
      '## 目标行为',
      '## 非目标行为',
      '## 允许修改范围',
      '## 禁止修改范围',
      '## Task 拆分建议',
      ''
    ].join('\n'));
    writeTraceabilityMatrix();
    const r = checkGate(TEST_DIR, 'to-be-exists');
    assert.equal(r.pass, false);
    assert.match(r.reason, /tasks\.json/);
  });

  it('fails when traceability references an unknown task', () => {
    writeFile('to-be/implementation-plan.md', [
      '# Plan',
      '## 目标行为',
      '## 非目标行为',
      '## 允许修改范围',
      '## 禁止修改范围',
      '## Task 拆分建议',
      ''
    ].join('\n'));
    writeTasksJson();
    writeTraceabilityMatrix([{ id: 'REQ-001', type: 'goal', source: 'requirement.md', description: '实现目标', covered_by_tasks: ['task-999'], verification: ['node --test'] }]);
    const r = checkGate(TEST_DIR, 'to-be-exists');
    assert.equal(r.pass, false);
    assert.match(r.reason, /unknown tasks/);
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
    writeTasksJson();
    writeTraceabilityMatrix();
    assert.equal(checkGate(TEST_DIR, 'to-be-exists').pass, true);
  });
});

describe('gate: ai-input-ready', () => {
  it('fails when files missing', () => {
    const r = checkGate(TEST_DIR, 'ai-input-ready');
    assert.equal(r.pass, false);
    assert.match(r.reason, /missing ai-input files/);
  });

  it('fails when facts lack evidence', () => {
    writeValidAiInput({ facts: `${sourceCoverage()}## 已确认事实\n\n- [F-001] 用户创建走 UserService\n` });
    const r = checkGate(TEST_DIR, 'ai-input-ready');
    assert.equal(r.pass, false);
    assert.match(r.reason, /file:line evidence/);
  });

  it('fails when facts contain placeholders', () => {
    writeValidAiInput({ facts: `${sourceCoverage()}## 已确认事实\n\n- [F-001] <事实描述> | 证据: src/a.ts:1\n` });
    const r = checkGate(TEST_DIR, 'ai-input-ready');
    assert.equal(r.pass, false);
    assert.match(r.reason, /placeholders/);
  });

  it('fails when clarifications are not summarized', () => {
    writeValidAiInput({ clarifications: '用户说老接口必须兼容。' });
    const r = checkGate(TEST_DIR, 'ai-input-ready');
    assert.equal(r.pass, false);
    assert.match(r.reason, /clarifications/);
  });

  it('fails when change surface is empty', () => {
    writeValidAiInput({ changeSurface: `${sourceCoverage('as-is/core-walkthrough.md', 'F-001')}## Safe-to-Change Areas\n\n| 区域 | 文件范围 |\n|---|---|\n` });
    const r = checkGate(TEST_DIR, 'ai-input-ready');
    assert.equal(r.pass, false);
    assert.match(r.reason, /safe-to-change/);
  });

  it('fails when source coverage is missing', () => {
    writeValidAiInput({ facts: '## 已确认事实\n\n- [F-001] 用户创建走 UserService | 证据: src/user.ts:42\n' });
    const r = checkGate(TEST_DIR, 'ai-input-ready');
    assert.equal(r.pass, false);
    assert.match(r.reason, /Source Coverage/);
  });

  it('passes with structured ai input', () => {
    writeValidAiInput({ clarifications: '用户说老接口必须兼容。', constraints: `${sourceCoverage('as-is/overview.md + clarifications.md', 'C-001')}## 禁区\n\n- 无\n\n## 包袱\n\n- 无\n\n## 坏味道\n\n- 无\n\n## 兼容约束\n\n- 澄清：老接口必须兼容\n` });
    assert.equal(checkGate(TEST_DIR, 'ai-input-ready').pass, true);
  });
});

describe('gate: task-integrity', () => {
  it('fails when task file is missing', () => {
    writeTaskState({ 'task-001': { expected_files: ['src/a.ts'] } });
    writeTraceabilityMatrix();
    const r = checkGate(TEST_DIR, 'task-integrity');
    assert.equal(r.pass, false);
    assert.match(r.reason, /missing task file/);
  });

  it('fails when task sections are missing', () => {
    writeTaskState({ 'task-001': { expected_files: ['src/a.ts'] } });
    writeTraceabilityMatrix();
    writeFile('tasks/task-001.md', '---\nexpected_files: [src/a.ts]\n---\n# Task\n');
    const r = checkGate(TEST_DIR, 'task-integrity');
    assert.equal(r.pass, false);
    assert.match(r.reason, /missing sections/);
  });

  it('fails on dangling dependencies', () => {
    writeTaskState({ 'task-001': { depends_on: ['task-999'], expected_files: ['src/a.ts'] } });
    writeFile('tasks/task-001.md', validTaskFile());
    const r = checkGate(TEST_DIR, 'task-integrity');
    assert.equal(r.pass, false);
    assert.match(r.reason, /unknown dependencies/);
  });

  it('fails when expected_files mismatch state', () => {
    writeTaskState({ 'task-001': { expected_files: ['src/a.ts'] } });
    writeTraceabilityMatrix();
    writeFile('tasks/task-001.md', validTaskFile(['src/b.ts']));
    const r = checkGate(TEST_DIR, 'task-integrity');
    assert.equal(r.pass, false);
    assert.match(r.reason, /expected_files mismatch/);
  });

  it('passes with a valid task file and state', () => {
    writeTaskState({ 'task-001': { expected_files: ['src/a.ts'] } });
    writeTraceabilityMatrix();
    writeFile('tasks/task-001.md', validTaskFile());
    assert.equal(checkGate(TEST_DIR, 'task-integrity').pass, true);
  });
});

describe('gate: task-report-exists', () => {
  it('fails when task report lacks wiki proof', () => {
    writeTaskState({ 'task-001': { status: 'coded', expected_files: ['src/a.ts'] } });
    writeFile('tasks/task-001.md', validTaskFile());
    writeFile('task-reports/task-001-report.md', validReport({ includeWikiProof: false }));
    const r = checkGate(TEST_DIR, 'task-report-exists');
    assert.equal(r.pass, false);
    assert.match(r.reason, /wiki proof/);
  });

  it('fails when task report lacks scope proof', () => {
    writeTaskState({ 'task-001': { status: 'coded', expected_files: ['src/a.ts'] } });
    writeFile('tasks/task-001.md', validTaskFile());
    writeFile('task-reports/task-001-report.md', validReport({ includeScopeProof: false }));
    const r = checkGate(TEST_DIR, 'task-report-exists');
    assert.equal(r.pass, false);
    assert.match(r.reason, /scope proof/);
  });

  it('fails when task report misses an invariant proof', () => {
    writeTaskState({ 'task-001': { status: 'coded', expected_files: ['src/a.ts'] } });
    writeFile('tasks/task-001.md', validTaskFile(['src/a.ts'], ['保持旧行为', '保持错误响应格式']));
    writeFile('task-reports/task-001-report.md', validReport());
    const r = checkGate(TEST_DIR, 'task-report-exists');
    assert.equal(r.pass, false);
    assert.match(r.reason, /missing invariant proof/);
  });

  it('fails when task report invariant proof is placeholder', () => {
    writeTaskState({ 'task-001': { status: 'coded', expected_files: ['src/a.ts'] } });
    writeFile('tasks/task-001.md', validTaskFile());
    writeFile('task-reports/task-001-report.md', validReport({ invariantRows: '| 保持旧行为 | TODO | pass |' }));
    const r = checkGate(TEST_DIR, 'task-report-exists');
    assert.equal(r.pass, false);
    assert.match(r.reason, /invariant proof must be non-empty/);
  });

  it('fails when task report invariant result is invalid', () => {
    writeTaskState({ 'task-001': { status: 'coded', expected_files: ['src/a.ts'] } });
    writeFile('tasks/task-001.md', validTaskFile());
    writeFile('task-reports/task-001-report.md', validReport({ invariantRows: '| 保持旧行为 | 已验证旧行为 | ok |' }));
    const r = checkGate(TEST_DIR, 'task-report-exists');
    assert.equal(r.pass, false);
    assert.match(r.reason, /invariant result must be pass\/fail/);
  });

  it('passes when task report has wiki, scope, and invariant proofs', () => {
    writeTaskState({ 'task-001': { status: 'coded', expected_files: ['src/a.ts'] } });
    writeFile('tasks/task-001.md', validTaskFile(['src/a.ts'], ['保持旧行为', '保持错误响应格式']));
    writeFile('task-reports/task-001-report.md', validReport({ invariantRows: '| 保持旧行为 | 已验证旧行为 | pass |\n| 保持错误响应格式 | 已验证错误响应格式 | pass |' }));
    assert.equal(checkGate(TEST_DIR, 'task-report-exists').pass, true);
  });
});

describe('gate: cr-complete', () => {
  it('fails when Verification section is missing', () => {
    writeTaskState({ 'task-001': { status: 'approved', expected_files: ['src/a.ts'] } });
    writeFile('tasks/task-001.md', validTaskFile());
    writeFile('cr/task-001-cr.md', validCr().replace('## Verification', '## Verification Review'));
    const r = checkGate(TEST_DIR, 'cr-complete');
    assert.equal(r.pass, false);
    assert.match(r.reason, /Verification/);
  });

  it('fails when CR lacks wiki proof', () => {
    writeTaskState({ 'task-001': { status: 'approved', expected_files: ['src/a.ts'] } });
    writeFile('tasks/task-001.md', validTaskFile());
    writeFile('cr/task-001-cr.md', validCr('approved', { includeWikiProof: false }));
    const r = checkGate(TEST_DIR, 'cr-complete');
    assert.equal(r.pass, false);
    assert.match(r.reason, /wiki proof/);
  });

  it('fails when CR lacks scope proof', () => {
    writeTaskState({ 'task-001': { status: 'approved', expected_files: ['src/a.ts'] } });
    writeFile('tasks/task-001.md', validTaskFile());
    writeFile('cr/task-001-cr.md', validCr('approved', { includeScopeProof: false }));
    const r = checkGate(TEST_DIR, 'cr-complete');
    assert.equal(r.pass, false);
    assert.match(r.reason, /scope proof/);
  });

  it('fails when approved CR records failing scope check', () => {
    writeTaskState({ 'task-001': { status: 'approved', expected_files: ['src/a.ts'] } });
    writeFile('tasks/task-001.md', validTaskFile());
    writeFile('cr/task-001-cr.md', validCr('approved', { scopeResult: 'fail' }));
    const r = checkGate(TEST_DIR, 'cr-complete');
    assert.equal(r.pass, false);
    assert.match(r.reason, /approved CR.*Result: pass/);
  });

  it('fails when approved CR has failing invariant result', () => {
    writeTaskState({ 'task-001': { status: 'approved', expected_files: ['src/a.ts'] } });
    writeFile('tasks/task-001.md', validTaskFile());
    writeFile('cr/task-001-cr.md', validCr('approved', { invariantRows: '| 保持旧行为 | 已验证旧行为失败 | fail |' }));
    const r = checkGate(TEST_DIR, 'cr-complete');
    assert.equal(r.pass, false);
    assert.match(r.reason, /approved CR must have all invariant results: pass/);
  });

  it('fails when approved CR misses an invariant proof', () => {
    writeTaskState({ 'task-001': { status: 'approved', expected_files: ['src/a.ts'] } });
    writeFile('tasks/task-001.md', validTaskFile(['src/a.ts'], ['保持旧行为', '保持错误响应格式']));
    writeFile('cr/task-001-cr.md', validCr());
    const r = checkGate(TEST_DIR, 'cr-complete');
    assert.equal(r.pass, false);
    assert.match(r.reason, /missing invariant proof/);
  });

  it('fails when needs_rework lacks CR item id', () => {
    writeTaskState({ 'task-001': { status: 'needs_rework', expected_files: ['src/a.ts'] } });
    writeFile('tasks/task-001.md', validTaskFile());
    writeFile('cr/task-001-cr.md', validCr('needs_rework').replace('CR-001', '修复项'));
    const r = checkGate(TEST_DIR, 'cr-complete');
    assert.equal(r.pass, false);
    assert.match(r.reason, /CR-xxx/);
  });

  it('passes with approved CR and invariant proofs', () => {
    writeTaskState({ 'task-001': { status: 'approved', expected_files: ['src/a.ts'] } });
    writeFile('tasks/task-001.md', validTaskFile());
    writeFile('cr/task-001-cr.md', validCr());
    assert.equal(checkGate(TEST_DIR, 'cr-complete').pass, true);
  });

  it('passes with needs_rework CR item id', () => {
    writeTaskState({ 'task-001': { status: 'needs_rework', expected_files: ['src/a.ts'] } });
    writeFile('tasks/task-001.md', validTaskFile());
    writeFile('cr/task-001-cr.md', validCr('needs_rework'));
    assert.equal(checkGate(TEST_DIR, 'cr-complete').pass, true);
  });

  it('passes with needs_rework CR item id and failing scope check', () => {
    writeTaskState({ 'task-001': { status: 'needs_rework', expected_files: ['src/a.ts'] } });
    writeFile('tasks/task-001.md', validTaskFile());
    writeFile('cr/task-001-cr.md', validCr('needs_rework', { scopeResult: 'fail' }));
    assert.equal(checkGate(TEST_DIR, 'cr-complete').pass, true);
  });

  it('passes with needs_rework CR item id and failing invariant result', () => {
    writeTaskState({ 'task-001': { status: 'needs_rework', expected_files: ['src/a.ts'] } });
    writeFile('tasks/task-001.md', validTaskFile());
    writeFile('cr/task-001-cr.md', validCr('needs_rework', { invariantRows: '| 保持旧行为 | 已确认旧行为失败 | fail |' }));
    assert.equal(checkGate(TEST_DIR, 'cr-complete').pass, true);
  });
});

function knowledgeCandidate(overrides = {}) {
  return {
    id: 'fz-001',
    category: 'forbidden_zone',
    status: 'proposed',
    confirmed: false,
    source_step: 'understand:confirm',
    created_at: '2026-05-17T00:00:00.000Z',
    quality_score: 0.8,
    keywords: ['旧接口响应', 'legacy response'],
    evidence: [{ file: 'clarifications.md', line_start: 12, line_end: 12, note: '用户确认旧接口响应字段不能改' }],
    content: {
      '范围': 'src/user.ts 的旧接口响应结构',
      '原因': '旧客户端依赖当前响应字段',
      '建议': '只增加校验，不修改响应字段'
    },
    decision: null,
    merge: null,
    ...overrides
  };
}

function writeKnowledgeCandidate(candidate = knowledgeCandidate(), rel = 'knowledge-candidates/fz-001.json') {
  writeFile(rel, JSON.stringify(candidate, null, 2));
}

describe('gate: knowledge-candidates-exists', () => {
  it('fails when directory is missing', () => {
    const r = checkGate(TEST_DIR, 'knowledge-candidates-exists');
    assert.equal(r.pass, false);
    assert.match(r.reason, /directory missing/);
  });

  it('passes when directory is empty', () => {
    mkdirSync(join(TEST_DIR, 'knowledge-candidates'), { recursive: true });
    assert.equal(checkGate(TEST_DIR, 'knowledge-candidates-exists').pass, true);
  });

  it('passes with a valid proposed candidate', () => {
    writeKnowledgeCandidate();
    assert.equal(checkGate(TEST_DIR, 'knowledge-candidates-exists').pass, true);
  });

  it('fails when candidate lacks source_step', () => {
    const candidate = knowledgeCandidate();
    delete candidate.source_step;
    writeKnowledgeCandidate(candidate);
    const r = checkGate(TEST_DIR, 'knowledge-candidates-exists');
    assert.equal(r.pass, false);
    assert.match(r.reason, /source_step/);
  });

  it('fails when candidate lacks evidence', () => {
    writeKnowledgeCandidate(knowledgeCandidate({ evidence: [] }));
    const r = checkGate(TEST_DIR, 'knowledge-candidates-exists');
    assert.equal(r.pass, false);
    assert.match(r.reason, /evidence/);
  });

  it('fails when candidate quality score is too low', () => {
    writeKnowledgeCandidate(knowledgeCandidate({ quality_score: 0.4 }));
    const r = checkGate(TEST_DIR, 'knowledge-candidates-exists');
    assert.equal(r.pass, false);
    assert.match(r.reason, /quality_score/);
  });

  it('fails when candidate keywords are empty', () => {
    writeKnowledgeCandidate(knowledgeCandidate({ keywords: [] }));
    const r = checkGate(TEST_DIR, 'knowledge-candidates-exists');
    assert.equal(r.pass, false);
    assert.match(r.reason, /keywords/);
  });

  it('fails when candidate content misses category required keys', () => {
    writeKnowledgeCandidate(knowledgeCandidate({ content: { '范围': 'src/user.ts' } }));
    const r = checkGate(TEST_DIR, 'knowledge-candidates-exists');
    assert.equal(r.pass, false);
    assert.match(r.reason, /原因/);
  });

  it('fails when candidate category is unsupported', () => {
    writeKnowledgeCandidate(knowledgeCandidate({ category: 'adr' }));
    const r = checkGate(TEST_DIR, 'knowledge-candidates-exists');
    assert.equal(r.pass, false);
    assert.match(r.reason, /unsupported category/);
  });

  it('fails when candidate status is unsupported', () => {
    writeKnowledgeCandidate(knowledgeCandidate({ status: 'draft' }));
    const r = checkGate(TEST_DIR, 'knowledge-candidates-exists');
    assert.equal(r.pass, false);
    assert.match(r.reason, /unsupported status/);
  });

  it('fails when legacy markdown candidates exist', () => {
    writeFile('knowledge-candidates/fz-001.md', '# Candidate');
    const r = checkGate(TEST_DIR, 'knowledge-candidates-exists');
    assert.equal(r.pass, false);
    assert.match(r.reason, /legacy markdown/);
  });
});

describe('gate: knowledge-extracted', () => {
  it('fails when marker is missing', () => {
    mkdirSync(join(TEST_DIR, 'knowledge-candidates'), { recursive: true });
    const r = checkGate(TEST_DIR, 'knowledge-extracted');
    assert.equal(r.pass, false);
    assert.match(r.reason, /knowledge-extracted/);
  });

  it('fails when candidate is still proposed', () => {
    writeKnowledgeCandidate();
    writeFile('.knowledge-extracted', '');
    const r = checkGate(TEST_DIR, 'knowledge-extracted');
    assert.equal(r.pass, false);
    assert.match(r.reason, /not in terminal status/);
  });

  it('fails when candidate is confirmed but not merged', () => {
    writeKnowledgeCandidate(knowledgeCandidate({ status: 'confirmed', confirmed: true, decision: { by: 'user', at: '2026-05-17T00:00:00.000Z', reason: '长期禁区' } }));
    writeFile('.knowledge-extracted', '');
    const r = checkGate(TEST_DIR, 'knowledge-extracted');
    assert.equal(r.pass, false);
    assert.match(r.reason, /not in terminal status/);
  });

  it('fails when merged candidate lacks merge metadata', () => {
    writeKnowledgeCandidate(knowledgeCandidate({ status: 'merged', confirmed: true }));
    writeFile('.knowledge-extracted', '');
    const r = checkGate(TEST_DIR, 'knowledge-extracted');
    assert.equal(r.pass, false);
    assert.match(r.reason, /merge\.wiki_file/);
  });

  it('fails when rejected candidate lacks decision reason', () => {
    writeKnowledgeCandidate(knowledgeCandidate({ status: 'rejected', confirmed: false, decision: { by: 'user', at: '2026-05-17T00:00:00.000Z', reason: '' } }));
    writeFile('.knowledge-extracted', '');
    const r = checkGate(TEST_DIR, 'knowledge-extracted');
    assert.equal(r.pass, false);
    assert.match(r.reason, /decision.reason/);
  });

  it('passes when all candidates are terminal', () => {
    writeKnowledgeCandidate(knowledgeCandidate({ status: 'merged', confirmed: true, merge: { wiki_file: 'forbidden-zones.md', entry_id: 'FZ-001', merged_at: '2026-05-17T00:00:00.000Z' } }));
    writeKnowledgeCandidate(knowledgeCandidate({ id: 'term-001', category: 'glossary', status: 'deferred', keywords: ['Entitlement'], content: { '术语': 'Entitlement', '定义': '客户权益' }, decision: { by: 'user', at: '2026-05-17T00:00:00.000Z', reason: '术语定义待确认' } }), 'knowledge-candidates/term-001.json');
    writeFile('.knowledge-extracted', '');
    assert.equal(checkGate(TEST_DIR, 'knowledge-extracted').pass, true);
  });

  it('passes when no candidates exist and marker is present', () => {
    mkdirSync(join(TEST_DIR, 'knowledge-candidates'), { recursive: true });
    writeFile('.knowledge-extracted', '');
    assert.equal(checkGate(TEST_DIR, 'knowledge-extracted').pass, true);
  });
});

function finalSummary() {
  return `# Final Summary

## 变更摘要

- 完成用户创建空名称校验。

## 验证结果

- node --test tests/user.test.mjs 通过。

## Scope Control Summary

- scope-check.mjs 通过，未发现越界或 forbidden zone 命中。

## Knowledge Candidates

- 无新增候选，或所有候选已 merged/rejected/deferred。

## Wiki Updates

- 无 wiki 更新。
`;
}

describe('gate: done', () => {
  it('fails when done marker exists without final summary', () => {
    writeFile('.done', '');
    const r = checkGate(TEST_DIR, 'done');
    assert.equal(r.pass, false);
    assert.match(r.reason, /final-summary/);
  });

  it('fails when final summary lacks required sections', () => {
    writeFile('.done', '');
    writeFile('final-summary.md', '# Final Summary\n');
    const r = checkGate(TEST_DIR, 'done');
    assert.equal(r.pass, false);
    assert.match(r.reason, /missing sections/);
  });

  it('passes with done marker and complete final summary', () => {
    writeFile('.done', '');
    writeFile('final-summary.md', finalSummary());
    assert.equal(checkGate(TEST_DIR, 'done').pass, true);
  });
});

describe('gate: unknown', () => {
  it('returns false for unknown gate', () => {
    const r = checkGate(TEST_DIR, 'nonexistent');
    assert.equal(r.pass, false);
    assert.match(r.reason, /unknown gate/);
  });
});
