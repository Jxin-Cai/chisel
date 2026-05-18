import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkGate } from '../scripts/gate-check.mjs';
import { initFromTasksJson } from '../scripts/task-init.mjs';
import { initWiki, mergeCandidate, readCandidate, setCandidateStatus } from '../scripts/wiki-manage.mjs';
import { readTaskState, taskStateFile, writeTaskState } from '../scripts/workflow-lib.mjs';

const TEST_DIR = join(import.meta.dirname, '.tmp-test-e2e-flow');
const PROJECT_NAME = 'test-project';

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

function assertGatePass(gateId) {
  const result = checkGate(TEST_DIR, gateId);
  assert.equal(result.pass, true, `${gateId} failed: ${result.reason || ''}`);
}

function writeAsIsArtifacts() {
  writeFile('as-is/overview.md', `# Overview

\`\`\`mermaid
graph TD
  Client[外部调用方] --> Entry[用户入口]
  Entry --> Service[用户服务]
\`\`\`

### 3分钟摘要

- 一句话目标：理解用户创建校验的当前链路
- 当前主链路：外部调用方进入用户入口，再调用用户服务
- 本次最可能改动的点：src/user.ts
- 最大风险：保持旧接口响应兼容

### 读者导航

| 如果你想了解 | 先看 | 再看 |
|---|---|---|
| 业务主链路 | overview.md#3分钟摘要 | core-walkthrough.md |
| 修改风险 | overview.md#风险地图 | as-is/ai-input/change-surface.md |

### 需求摘要

给用户创建增加输入校验。

### 系统全景

用户入口负责接收请求，用户服务负责执行业务规则。

### 当前能力边界

当前系统支持创建用户，但缺少名称为空的校验。

### 核心事实

- [F-001] [已确认] 用户创建进入 UserService。证据：src/user.ts:10
- [F-002] [已确认] 当前响应字段需要保持。证据：src/user.ts:28

### 风险地图

| 风险 | 影响区域 | 证据 | 缓解建议 |
|---|---|---|---|
| 旧接口响应变化 | src/user.ts | src/user.ts:28 | 只增加校验，不改响应结构 |

### 常见误解点

| 容易误解为 | 实际情况 | 证据/置信度 |
|---|---|---|
| 可以重构整个用户模块 | 本次只允许改校验逻辑 | src/user.ts:10，高 |

### 禁区 / 包袱 / 暂不重构

- 禁区：不要修改响应结构
- 包袱：旧客户端依赖当前字段
- 坏味道：用户模块缺少统一 validator，本次不重构

### 不确定点

- 无。

### 用户确认清单

- [ ] C-001 需确认事实：旧接口响应字段是否必须保持

### 待澄清问题

- 旧接口响应字段是否必须保持？
`);

  writeFile('as-is/core-walkthrough.md', `# Core Walkthrough

## 核心时序图

\`\`\`mermaid
sequenceDiagram
  participant Client as 外部调用方
  participant Entry as 用户入口
  participant Service as 用户服务
  Client->>Entry: 提交创建用户请求
  Entry->>Service: 触发创建用户
  Service-->>Client: 返回创建结果
\`\`\`

## 核心流程图

\`\`\`mermaid
flowchart TD
  A[接收请求] --> B{名称是否为空}
  B -->|否| C[创建用户]
  B -->|是| D[返回校验错误]
\`\`\`

## 状态变化

- 用户从不存在变为已创建。

## 异常路径

- 名称为空时返回校验错误。

## safe-to-change area

- src/user.ts 的输入校验分支。
`);

  writeFile('as-is/evidence-index.md', `| 结论 | 证据位置 | 类型 |
|---|---|---|
| [F-001] 用户创建进入 UserService | src/user.ts:10 | 已确认 |
| [F-002] 响应字段需要保持 | src/user.ts:28 | 已确认 |
| 名称为空当前缺少校验 | src/user.ts:14 | 已确认 |
| 安全修改区是校验分支 | src/user.ts:12 | 已确认 |
`);
  writeFile('as-is/evidence-ledger.json', JSON.stringify({ facts: [
    { id: 'F-001', claim: '用户创建进入 UserService', status: 'confirmed', evidence: [{ file: 'src/user.ts', line_start: 10, line_end: 20, kind: 'code' }] },
    { id: 'F-002', claim: '旧接口响应字段需要保持', status: 'confirmed', evidence: [{ file: 'src/user.ts', line_start: 28, line_end: 35, kind: 'code' }] }
  ] }, null, 2));
  writeFile('as-is/knowledge-candidates.md', '# Knowledge Candidates\n\n暂无新增候选。\n');
}

function sourceCoverage(source = 'as-is/evidence-ledger.json', refs = 'F-001, F-002') {
  return `## Source Coverage

| Source | Covered refs | Omissions | Reason |
|---|---|---|---|
| ${source} | ${refs} | 无 | — |

`;
}

function writeAiInputArtifacts() {
  writeFile('as-is/ai-input/facts.md', `${sourceCoverage()}## 已确认事实

- [F-001] 用户创建进入 UserService | 证据: src/user.ts:10
- [F-002] 旧接口响应字段需要保持 | 证据: src/user.ts:28
`);
  writeFile('as-is/ai-input/call-graph.md', '# Call Graph\n\nClient -> Entry -> UserService\n');
  writeFile('as-is/ai-input/data-schema.md', '# Data Schema\n\n本需求不涉及数据结构变化。\n');
  writeFile('as-is/ai-input/api-surface.md', '# API Surface\n\n创建用户接口保持响应字段不变。\n');
  writeFile('as-is/ai-input/constraints.md', `${sourceCoverage('as-is/overview.md + clarifications.md', 'C-001')}## 禁区

- 不修改旧接口响应字段。

## 包袱

- 旧客户端依赖当前响应字段。

## 坏味道

- 暂不抽统一 validator。

## 兼容约束

- 澄清：旧接口响应字段必须保持。
`);
  writeFile('as-is/ai-input/change-surface.md', `${sourceCoverage('as-is/core-walkthrough.md', 'F-001')}## Safe-to-Change Areas

| 区域 | 文件范围 | 修改类型 | 注意事项 |
|---|---|---|---|
| 用户创建校验 | src/user.ts | 增加校验 | 不改响应结构 |
`);
}

function writeToBeArtifacts() {
  writeFile('to-be/implementation-plan.md', `# Implementation Plan

## 目标行为

用户创建时拒绝空名称。

## 非目标行为

不重构用户模块，不修改响应字段。

## 允许修改范围

- src/user.ts

## 禁止修改范围

- 响应字段结构

## Task 拆分建议

### task-001

- 目标：增加空名称校验
- Acceptance Criteria：空名称创建失败
- Verification：node --test tests/user.test.mjs
`);
  writeFile('to-be/traceability-matrix.json', JSON.stringify({
    items: [
      {
        id: 'REQ-001',
        type: 'goal',
        source: 'requirement.md',
        description: '用户创建时拒绝空名称',
        covered_by_tasks: ['task-001'],
        verification: ['node --test tests/user.test.mjs']
      }
    ]
  }, null, 2));
  writeFile('to-be/tasks.json', JSON.stringify({
    tasks: [
      {
        task_id: 'task-001',
        depends_on: [],
        title: '增加用户创建空名称校验',
        goal: '用户创建时拒绝空名称，并保持旧接口响应字段不变。',
        allowed_files: ['src/user.ts'],
        forbidden_files: ['src/legacy-response.ts'],
        expected_files: ['src/user.ts'],
        trace_refs: ['REQ-001'],
        allowed_symbols: ['UserService.create'],
        forbidden_symbols: ['LegacyResponseShape'],
        behavior_invariants: ['旧接口响应字段保持不变'],
        impact_surface: {
          files: ['src/user.ts'],
          symbols: ['UserService.create'],
          invariants: ['旧接口响应字段保持不变'],
          shared_state: ['user table']
        },
        context_to_load: {
          as_is: ['as-is/ai-input/facts.md', 'as-is/ai-input/constraints.md'],
          to_be: ['to-be/implementation-plan.md'],
          wiki: [],
          module_map: [],
          adr: [],
          tests: ['tests/user.test.mjs']
        },
        acceptance_criteria: ['空名称创建失败', '旧接口响应字段保持不变'],
        verification: ['node --test tests/user.test.mjs'],
        risk_level: 'low',
        rollback: '回退 src/user.ts 的校验修改'
      }
    ]
  }, null, 2));
}

function wikiProof() {
  return `## Wiki Entries Loaded

| Entry | File | Why Loaded | Used For |
|---|---|---|---|
| None matched | — | 无命中 | — |

## Progressive Load Proof

- Query command：node scripts/wiki-manage.mjs --query . --text "用户创建空名称校验" --category "" --min-score 2 --load-plan --limit 10
- Query summary：命中 0 条，must_load 0 条，optional_load 0 条
- category/min-score：空 / 2
- load_plan：{"must_load":[],"optional_load":[],"skip":[]}
- None matched：无命中
`;
}

function scopeProof({ mode = 'report' } = {}) {
  const heading = mode === 'cr' ? 'Hit Proofs Reviewed' : 'Hit Proofs Summary';
  const lastColumn = mode === 'cr' ? 'Reviewer assessment' : 'Status';
  const lastValue = mode === 'cr' ? 'OK' : 'within_expected';
  const runHeading = mode === 'cr' ? 'Scope Check Re-run' : 'Scope Check Proof';
  return `### ${runHeading}

- Command：node scripts/scope-check.mjs .chisel/idea task-001
- Result：pass
- schema_version：3
- changed_files_count：1
- violations_count：0
- forbidden_symbol_hits_count：0

#### Scope Check JSON Summary

\`\`\`json
{"task_id":"task-001","pass":true,"changed_files":["src/user.ts"],"violations":[],"summary":{"violations_count":0}}
\`\`\`

#### ${heading}

| File | Expected proof | Forbidden proof | Symbol proof | ${lastColumn} |
|---|---|---|---|---|
| src/user.ts | src/user.ts from task.frontmatter.expected_files exact | none | allowed: UserService.create | ${lastValue} |

#### Invariant Proofs

| Invariant | Proof | Result |
|---|---|---|
| 旧接口响应字段保持不变 | 回归验证旧响应字段 | pass |
`;
}

function writeTaskReport() {
  writeFile('task-reports/task-001-report.md', `# Task Report

## 做了什么

增加用户创建空名称校验。

## 改了什么

| 文件 | 修改点 | 是否在 expected_files 内 |
|---|---|---|
| src/user.ts | 增加校验分支 | Yes |

## 验证

node --test tests/user.test.mjs 通过。

${wikiProof()}

## Scope Control

${scopeProof()}
`);
}

function writeKnowledgeCandidate() {
  const candidate = {
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
    merge: null
  };
  writeFile('knowledge-candidates/fz-001.json', `${JSON.stringify(candidate, null, 2)}\n`);
  return join(TEST_DIR, 'knowledge-candidates/fz-001.json');
}

function writeFinalSummary() {
  writeFile('final-summary.md', `# Final Summary

## 变更摘要

- 完成用户创建空名称校验。

## 验证结果

- node --test tests/user.test.mjs 通过。

## Scope Control Summary

- scope-check.mjs 通过，所有变更都在 expected_files 内，未触碰 forbidden zones。

## Knowledge Candidates

- fz-001 已 confirmed 并 merged。

## Wiki Updates

- forbidden-zones.md 新增 FZ 条目。
`);
}

function writeCr() {
  writeFile('cr/task-001-cr.md', `---
task_id: task-001
result: approved
rework_count: 0
---

# CR

## 结论

approved

## 功能完整度

满足 task 验收标准。

## Scope Control

${scopeProof({ mode: 'cr' })}

## Verification

- 已复跑的验证命令：node --test tests/user.test.mjs
- 结果：通过

${wikiProof()}

## Rework Items

- [ ] 无
`);
}

describe('chisel e2e artifact flow', () => {
  it('passes gates from requirement through task report, CR, and knowledge extraction', () => {
    writeFile('requirement.md', '# Requirement\n\n## 需求目标\n\n给用户创建增加空名称校验。\n\n## 验收标准\n\n- 空名称时返回 400\n');
    assertGatePass('requirement-exists');

    writeAsIsArtifacts();
    assertGatePass('as-is-complete');

    writeFile('clarifications.md', `# Clarifications

## 确认结论

用户确认 AS_IS 理解正确。

## 逐项决策记录

| ID | 问题 | 用户决策 | 理由 | 状态 |
|---|---|---|---|---|
| C-001 | 旧接口响应字段是否必须保持 | 必须保持 | 旧客户端依赖 | confirmed |

## 澄清答案

旧接口响应字段必须保持。

## 未决项

无。

## 新增约束

旧接口响应字段必须保持。

## 知识候选信号

无。
`);
    writeFile('.as-is-confirmed', '');
    assertGatePass('as-is-confirmed');

    writeAiInputArtifacts();
    assertGatePass('ai-input-ready');

    writeToBeArtifacts();
    assertGatePass('to-be-exists');
    writeFile('.to-be-confirmed', '');
    assertGatePass('to-be-confirmed');

    const initResult = initFromTasksJson({ ideaDir: TEST_DIR, ideaName: 'user-validation', from: 'to-be/tasks.json', check: false, force: false });
    assert.deepEqual(initResult.tasks, ['task-001']);
    assert.equal(existsSync(join(TEST_DIR, 'tasks/task-001.md')), true);
    assertGatePass('task-workflow-exists');
    assertGatePass('task-integrity');

    const stateAfterInit = readTaskState(taskStateFile(TEST_DIR));
    stateAfterInit.tasks['task-001'].status = 'coded';
    writeTaskState(taskStateFile(TEST_DIR), stateAfterInit);
    writeTaskReport();
    assertGatePass('task-report-exists');

    const stateAfterReport = readTaskState(taskStateFile(TEST_DIR));
    stateAfterReport.tasks['task-001'].status = 'approved';
    writeTaskState(taskStateFile(TEST_DIR), stateAfterReport);
    writeCr();
    assertGatePass('cr-complete');
    assertGatePass('all-approved');

    const candidateFile = writeKnowledgeCandidate();
    writeFile('.knowledge-extracted', '');
    assert.equal(checkGate(TEST_DIR, 'knowledge-extracted').pass, false);
    setCandidateStatus(TEST_DIR, candidateFile, 'confirmed', '用户确认这是长期禁区');
    initWiki(TEST_DIR, '', PROJECT_NAME);
    mergeCandidate(TEST_DIR, candidateFile, PROJECT_NAME);
    assertGatePass('knowledge-extracted');
    const candidate = readCandidate(candidateFile);
    assert.equal(candidate.status, 'merged');
    assert.equal(candidate.merge.wiki_file, 'forbidden-zones.md');
    const wiki = readFileSync(join(TEST_DIR, `.chisel/wiki/${PROJECT_NAME}/forbidden-zones.md`), 'utf8');
    assert.match(wiki, /src\/user\.ts/);

    assert.equal(checkGate(TEST_DIR, 'done').pass, false);
    writeFinalSummary();
    writeFile('.done', '');
    assertGatePass('done');

    const generatedTask = readFileSync(join(TEST_DIR, 'tasks/task-001.md'), 'utf8');
    assert.match(generatedTask, /## Context to Load/);
    assert.match(generatedTask, /## Traceability/);
    assert.match(generatedTask, /REQ-001/);
    assert.match(generatedTask, /旧接口响应字段保持不变/);
    assert.match(generatedTask, /## Impact Surface/);
    assert.match(generatedTask, /user table/);
    assert.match(generatedTask, /as-is\/ai-input\/constraints\.md/);
  });
});
