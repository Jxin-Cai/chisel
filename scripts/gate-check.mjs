#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MAX_REWORK_COUNT, allTasksApproved, readTaskState, taskStateFile } from './workflow-lib.mjs';
import { appendAuditLog } from './audit-log.mjs';

const AS_IS_MAIN_FILES = [
  'as-is/overview.md',
  'as-is/core-walkthrough.md',
  'as-is/evidence-index.md',
  'as-is/knowledge-candidates.md'
];

const AI_INPUT_FILES = [
  'as-is/ai-input/facts.md',
  'as-is/ai-input/call-graph.md',
  'as-is/ai-input/data-schema.md',
  'as-is/ai-input/api-surface.md',
  'as-is/ai-input/constraints.md',
  'as-is/ai-input/change-surface.md'
];

function has(ideaDir, rel) {
  return existsSync(join(ideaDir, rel));
}

function taskEntries(ideaDir) {
  return Object.entries(readTaskState(taskStateFile(ideaDir)).tasks || {});
}

function hasRequiredLines(file, needles) {
  if (!existsSync(file)) return false;
  const text = readFileSync(file, 'utf8');
  return needles.every(needle => text.includes(needle));
}

function fileHasMermaid(file) {
  if (!existsSync(file)) return false;
  const text = readFileSync(file, 'utf8');
  return text.includes('```mermaid');
}

function fileLineCount(file) {
  if (!existsSync(file)) return 0;
  return readFileSync(file, 'utf8').split('\n').filter(line => line.trim()).length;
}

const MIN_EVIDENCE_LINES = 5;

export function checkGate(ideaDir, gateId) {
  if (!ideaDir || ideaDir === 'none') return { pass: false, gate: gateId, reason: 'idea-dir does not exist' };
  switch (gateId) {
    case 'requirement-exists':
      return result(gateId, has(ideaDir, 'requirement.md'), 'requirement.md missing');
    case 'as-is-complete': {
      const missing = AS_IS_MAIN_FILES.filter(file => !has(ideaDir, file));
      if (missing.length > 0) return result(gateId, false, `missing main files: ${missing.join(', ')}`);
      if (!hasRequiredLines(join(ideaDir, 'as-is/overview.md'), ['### 需求摘要', '### 当前能力边界', '### 待澄清问题']))
        return result(gateId, false, 'as-is overview is missing required sections (需求摘要, 当前能力边界, 待澄清问题)');
      const mermaidFiles = ['as-is/overview.md', 'as-is/core-walkthrough.md'];
      const noMermaid = mermaidFiles.filter(f => !fileHasMermaid(join(ideaDir, f)));
      if (noMermaid.length > 0) return result(gateId, false, `main files missing Mermaid diagrams: ${noMermaid.join(', ')}`);
      const evidenceLines = fileLineCount(join(ideaDir, 'as-is/evidence-index.md'));
      if (evidenceLines < MIN_EVIDENCE_LINES) return result(gateId, false, `evidence-index.md has only ${evidenceLines} non-empty lines (min ${MIN_EVIDENCE_LINES})`);
      return result(gateId, true);
    }
    case 'as-is-confirmed':
      if (!has(ideaDir, '.as-is-confirmed')) return result(gateId, false, '.as-is-confirmed missing');
      return result(gateId, has(ideaDir, 'clarifications.md'), 'clarifications.md missing — confirm must produce clarifications (empty file if none)');
    case 'to-be-exists': {
      const planFile = join(ideaDir, 'to-be/implementation-plan.md');
      if (!has(ideaDir, 'to-be/implementation-plan.md'))
        return result(gateId, false, 'to-be/implementation-plan.md missing');
      const requiredSections = ['## 目标行为', '## 非目标行为', '## 允许修改范围', '## 禁止修改范围', '## Task 拆分建议'];
      if (!hasRequiredLines(planFile, requiredSections))
        return result(gateId, false, 'to-be implementation plan is missing required sections (目标行为, 非目标行为, 允许修改范围, 禁止修改范围, Task 拆分建议)');
      const planText = readFileSync(planFile, 'utf8');
      const taskSection = planText.split('## Task 拆分建议')[1] || '';
      if (taskSection.includes('task_id') || taskSection.includes('### task-')) {
        if (!taskSection.includes('Acceptance Criteria') && !taskSection.includes('验收标准'))
          return result(gateId, false, 'Task 拆分建议 section missing Acceptance Criteria in task entries');
        if (!taskSection.includes('Verification') && !taskSection.includes('验证'))
          return result(gateId, false, 'Task 拆分建议 section missing Verification in task entries');
      }
      return result(gateId, true);
    }
    case 'to-be-confirmed':
      return result(gateId, has(ideaDir, '.to-be-confirmed'), '.to-be-confirmed missing');
    case 'tasks-exist':
      return result(gateId, has(ideaDir, 'tasks'), 'tasks directory missing');
    case 'task-workflow-exists':
      return result(gateId, has(ideaDir, 'task-workflow-state.yaml'), 'task-workflow-state.yaml missing');
    case 'task-integrity': {
      if (!has(ideaDir, 'task-workflow-state.yaml')) return result(gateId, false, 'task-workflow-state.yaml missing');
      const missing = taskEntries(ideaDir).filter(([, task]) => !has(ideaDir, task.file)).map(([taskId]) => taskId);
      return missing.length === 0 ? result(gateId, true) : result(gateId, false, `missing task files: ${missing.join(', ')}`);
    }
    case 'task-report-exists': {
      if (!has(ideaDir, 'task-workflow-state.yaml')) return result(gateId, false, 'task-workflow-state.yaml missing');
      const missing = taskEntries(ideaDir).filter(([, task]) => {
        if (!['coded', 'reviewing', 'approved', 'needs_rework', 'blocked'].includes(task.status)) return false;
        const reportPath = join(ideaDir, task.report_file);
        if (!has(ideaDir, task.report_file)) return true;
        if ((task.expected_files || []).length === 0) return false;
        return !hasRequiredLines(reportPath, ['## 做了什么', '## 改了什么', '## 验证']);
      }).map(([taskId]) => taskId);
      return missing.length === 0 ? result(gateId, true) : result(gateId, false, `missing task reports: ${missing.join(', ')}`);
    }
    case 'cr-complete': {
      if (!has(ideaDir, 'task-workflow-state.yaml')) return result(gateId, false, 'task-workflow-state.yaml missing');
      const missing = taskEntries(ideaDir).filter(([, task]) => {
        if (!['approved', 'needs_rework', 'blocked'].includes(task.status)) return false;
        return !has(ideaDir, task.cr_file) || !hasRequiredLines(join(ideaDir, task.cr_file), ['## 结论', '## 功能完整度', '## Scope Control', '## 必须返修项']);
      }).map(([taskId]) => taskId);
      return missing.length === 0 ? result(gateId, true) : result(gateId, false, `missing cr files: ${missing.join(', ')}`);
    }
    case 'rework-limit': {
      if (!has(ideaDir, 'task-workflow-state.yaml')) return result(gateId, false, 'task-workflow-state.yaml missing');
      const over = taskEntries(ideaDir).filter(([, task]) => Number(task.rework_count || 0) >= MAX_REWORK_COUNT).map(([taskId]) => taskId);
      return over.length === 0 ? result(gateId, true) : result(gateId, false, `rework over limit: ${over.join(', ')}`);
    }
    case 'all-approved':
      return result(gateId, has(ideaDir, 'task-workflow-state.yaml') && allTasksApproved(ideaDir), 'not all tasks approved');
    case 'knowledge-candidates-exists':
      return result(gateId, has(ideaDir, 'knowledge-candidates'), 'knowledge-candidates directory missing');
    case 'knowledge-extracted':
      return result(gateId, has(ideaDir, '.knowledge-extracted'), '.knowledge-extracted missing');
    case 'ai-input-ready': {
      const missing = AI_INPUT_FILES.filter(file => !has(ideaDir, file));
      return missing.length === 0 ? result(gateId, true) : result(gateId, false, `missing ai-input files: ${missing.join(', ')}`);
    }
    case 'done':
      return result(gateId, has(ideaDir, '.done'), '.done missing');
    default:
      return { pass: false, gate: gateId, reason: `unknown gate: ${gateId}` };
  }
}

function result(gate, pass, reason = '') {
  return pass ? { pass: true, gate } : { pass: false, gate, reason };
}

export async function main(argv) {
  const ideaDir = argv[0];
  const gateId = argv[1];
  if (!ideaDir || !gateId) {
    process.stderr.write('用法: gate-check.mjs <idea-dir> <gate-id>\n');
    process.exit(1);
  }
  const checked = checkGate(ideaDir, gateId);
  appendAuditLog(ideaDir, { type: 'gate_result', gate: gateId, pass: checked.pass, reason: checked.reason || '' });
  console.log(JSON.stringify(checked));
  if (!checked.pass) process.exit(1);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
