import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { writeTaskState, taskStateFile } from '../scripts/workflow-lib.mjs';

const TEST_DIR = join(import.meta.dirname, '.tmp-test-orchestration-status');
const SCRIPT = join(import.meta.dirname, '../scripts/orchestration-status.mjs');

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

function runStatus() {
  return execFileSync(process.execPath, [SCRIPT, TEST_DIR], { encoding: 'utf8' });
}

function writeCompletePreKnowledgeFlow() {
  writeFile('requirement.md', '# Requirement\n\n## 需求目标\n\n给用户创建增加空名称校验。\n\n## 验收标准\n\n- 空名称时返回 400\n');
  writeFile('as-is/overview.md', `# Overview

\`\`\`mermaid
graph TD
  A-->B
\`\`\`

### 3分钟摘要

- 一句话目标：理解用户创建
- 当前主链路：A 到 B
- 本次最可能改动的点：src/user.ts
- 最大风险：兼容旧接口

### 读者导航

| 如果你想了解 | 先看 | 再看 |
|---|---|---|
| 业务主链路 | overview.md#3分钟摘要 | core-walkthrough.md |

### 需求摘要

新增用户校验。

### 当前能力边界

当前支持创建用户。

### 风险地图

| 风险 | 影响区域 | 证据 | 缓解建议 |
|---|---|---|---|
| 旧接口兼容 | src/user.ts | src/user.ts:42 | 保持响应字段 |

### 常见误解点

| 容易误解为 | 实际情况 | 证据/置信度 |
|---|---|---|
| 可以重构用户模块 | 只能加校验 | src/user.ts:42 |

### 用户确认清单

- [ ] C-001 需确认事实：旧接口响应字段是否必须保持

### 待澄清问题

- 旧接口响应是否兼容？
`);
  writeFile('as-is/core-walkthrough.md', '# Core\n```mermaid\nsequenceDiagram\n  A->>B: call\n```\n');
  writeFile('as-is/evidence-index.md', '| 结论 | 证据 | 类型 |\n|---|---|---|\n| [F-001] A | src/user.ts:42 | 已确认 |\n| B | f:2 | 已确认 |\n| C | f:3 | 已确认 |\n| D | f:4 | 已确认 |\n| E | f:5 | 已确认 |\n');
  writeFile('as-is/evidence-ledger.json', JSON.stringify({ facts: [{ id: 'F-001', claim: '用户创建走 UserService', status: 'confirmed', evidence: [{ file: 'src/user.ts', line_start: 42, line_end: 80, kind: 'code' }] }] }, null, 2));
  writeFile('as-is/knowledge-candidates.md', '# Candidates\n');
  writeFile('.as-is-confirmed', '');
  writeFile('clarifications.md', `# Clarifications

## 逐项决策记录

| ID | 问题 | 用户决策 | 理由 | 状态 |
|---|---|---|---|---|
| C-001 | 旧接口响应字段是否必须保持 | 必须保持 | 旧客户端依赖 | confirmed |

## 新增约束

无新增约束。
`);
  const sourceCoverage = '## Source Coverage\n\n| Source | Covered refs | Omissions | Reason |\n|---|---|---|---|\n| as-is/evidence-ledger.json | F-001 | 无 | — |\n\n';
  writeFile('as-is/ai-input/facts.md', `${sourceCoverage}## 已确认事实\n\n- [F-001] 用户创建走 UserService | 证据: src/user.ts:42\n`);
  writeFile('as-is/ai-input/call-graph.md', '# Call graph\n');
  writeFile('as-is/ai-input/data-schema.md', '# Data schema\n');
  writeFile('as-is/ai-input/api-surface.md', '# API surface\n');
  writeFile('as-is/ai-input/constraints.md', `${sourceCoverage.replace('as-is/evidence-ledger.json', 'as-is/overview.md + clarifications.md').replace('F-001', 'C-001')}## 禁区\n\n- 无\n\n## 包袱\n\n- 无\n\n## 坏味道\n\n- 无\n\n## 兼容约束\n\n- 无新增约束\n`);
  writeFile('as-is/ai-input/change-surface.md', `${sourceCoverage.replace('as-is/evidence-ledger.json', 'as-is/core-walkthrough.md')}## Safe-to-Change Areas\n\n- src/user.ts:42-80 可增加校验\n`);
  writeFile('to-be/implementation-plan.md', '# Plan\n## 目标行为\n## 非目标行为\n## 允许修改范围\n## 禁止修改范围\n## Task 拆分建议\n');
  writeFile('to-be/traceability-matrix.json', JSON.stringify({ items: [{ id: 'REQ-001', type: 'goal', source: 'requirement.md', description: '实现目标', covered_by_tasks: ['task-001'], verification: ['node --test'] }] }, null, 2));
  writeFile('.to-be-confirmed', '');
  writeTaskState(taskStateFile(TEST_DIR), {
    idea: 'test',
    tasks: {
      'task-001': {
        status: 'approved',
        depends_on: [],
        description: 'Task',
        file: 'tasks/task-001.md',
        expected_files: ['src/user.ts'],
        report_file: 'task-reports/task-001-report.md',
        cr_file: 'cr/task-001-cr.md',
        rework_count: 0,
        changed_files: [],
        loc_added: 0,
        loc_deleted: 0
      }
    }
  });
  writeFile('tasks/task-001.md', `---
task_id: task-001
status: confirmed
expected_files: [src/user.ts]
trace_refs: [REQ-001]
allowed_symbols: [UserService.create]
forbidden_symbols: [LegacyResponseShape]
---

# Task

## 目标行为

实现目标。

## Scope

### Allowed Files / Areas

- src/user.ts

### Forbidden Files / Areas

- 无

## Context to Load

- as-is：as-is/ai-input/facts.md

## Traceability

- REQ-001

## Acceptance Criteria

- [ ] 行为生效

## Verification

\`\`\`bash
node --test
\`\`\`

## Behavior Invariants

- [ ] 保持旧行为
`);
}

function writeProposedCandidate() {
  writeFile('knowledge-candidates/fz-001.json', JSON.stringify({
    id: 'fz-001',
    category: 'forbidden_zone',
    status: 'proposed',
    confirmed: false,
    source_step: 'understand:confirm',
    created_at: '2026-05-17T00:00:00.000Z',
    evidence: ['clarifications.md:12 - 用户确认旧接口响应字段不能改'],
    content: { '范围': 'src/user.ts', '原因': '旧客户端依赖', '建议': '不改响应结构' },
    decision: null,
    merge: null
  }, null, 2));
}

function writeFinalSummary() {
  writeFile('final-summary.md', `# Final Summary

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
`);
}

describe('orchestration-status knowledge extraction', () => {
  it('does not enter final summary when unresolved candidates remain despite marker', () => {
    writeCompletePreKnowledgeFlow();
    writeProposedCandidate();
    writeFile('.knowledge-extracted', '');

    const output = runStatus();

    assert.match(output, /resume_step: knowledge:extract/);
  });

  it('enters final summary when knowledge extraction gate passes', () => {
    writeCompletePreKnowledgeFlow();
    mkdirSync(join(TEST_DIR, 'knowledge-candidates'), { recursive: true });
    writeFile('.knowledge-extracted', '');

    const output = runStatus();

    assert.match(output, /resume_step: final:summary/);
  });

  it('does not treat .done marker as complete when final summary is missing', () => {
    writeCompletePreKnowledgeFlow();
    mkdirSync(join(TEST_DIR, 'knowledge-candidates'), { recursive: true });
    writeFile('.knowledge-extracted', '');
    writeFile('.done', '');

    const output = runStatus();

    assert.match(output, /resume_step: final:summary/);
  });

  it('enters done only when marker and final summary gate pass', () => {
    writeCompletePreKnowledgeFlow();
    mkdirSync(join(TEST_DIR, 'knowledge-candidates'), { recursive: true });
    writeFile('.knowledge-extracted', '');
    writeFile('.done', '');
    writeFinalSummary();

    const output = runStatus();

    assert.match(output, /resume_step: done/);
    assert.match(output, /in_worktree: (true|false)/);
  });
});
