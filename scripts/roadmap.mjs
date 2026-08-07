#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { WORKFLOW_PATHS } from './workflow-definition.mjs';
import { detectComplexity } from './workflow-lib.mjs';
import { checkGate } from './gate-check.mjs';

const STEP_DESCRIPTIONS = {
  'receive-requirement': '接收并结构化需求，产出 requirement.md',
  'understand:explore': '代码侦察 + 深度走查，产出 as-is 结构化分析',
  'understand:confirm': '向用户展示 as-is 摘要，确认理解正确',
  'clarify:requirement': '多维度需求澄清，产出 requirement-clarification.json',
  'plan:design': '方案设计 + task 拆分，产出 to-be/ 全套产物',
  'plan:confirm': '向用户展示方案，确认后写入确认凭据',
  'worktree:setup': '决定是否 worktree 隔离开发',
  'quick-dev:init': '快速通道自动生成 task + worktree-decision',
  'tasks:init': '初始化 task 状态机，生成 coder-context',
  'implement:code': '按 task 逐个实现代码',
  'repair:code': '按 CR 返修意见修复代码',
  'review:cr': '多维度 Code Review（spec + D2-D9）',
  'review:cr-light': '轻量 Code Review（仅 spec 维度）',
  'review:cr-moderate': 'Code Review（spec + D3-D5）',
  'review:integration': '跨 task 集成一致性审查',
  'final:summary': '生成最终变更摘要 + 验证证据汇总',
};

function resolveStepStatus(ideaDir, step, gateId) {
  if (!gateId) return 'pending';
  const result = checkGate(ideaDir, gateId);
  return result.pass ? 'completed' : 'pending';
}

function main() {
  const args = process.argv.slice(2);
  const ideaDir = resolve(args[0] || '.');

  if (!existsSync(ideaDir)) {
    console.log(JSON.stringify({ error: 'idea-dir does not exist', idea_dir: ideaDir }));
    process.exit(1);
  }

  const complexity = detectComplexity(ideaDir) || 'standard';
  const path = WORKFLOW_PATHS[complexity];
  if (!path) {
    console.log(JSON.stringify({ error: `unknown complexity: ${complexity}`, idea_dir: ideaDir }));
    process.exit(1);
  }

  const steps = path.map(({ step, phase }) => {
    const status = resolveStepStatus(ideaDir, step, getGateForStep(step));
    return {
      step,
      phase: phase || null,
      status,
      description: STEP_DESCRIPTIONS[step] || step,
    };
  });

  let currentIdx = steps.findIndex(s => s.status !== 'completed');
  if (currentIdx < 0) currentIdx = steps.length - 1;
  if (currentIdx >= 0 && steps[currentIdx].status === 'pending') {
    steps[currentIdx].status = 'in_progress';
  }

  console.log(JSON.stringify({
    idea_dir: ideaDir,
    complexity,
    total_steps: steps.length,
    completed_steps: steps.filter(s => s.status === 'completed').length,
    current_step: steps[currentIdx]?.step || null,
    steps,
  }, null, 2));
}

function getGateForStep(step) {
  const map = {
    'receive-requirement': 'requirement-exists',
    'understand:explore': 'as-is-complete',
    'understand:confirm': 'as-is-confirmed',
    'clarify:requirement': 'clarification-complete',
    'plan:design': 'to-be-exists',
    'plan:confirm': 'to-be-confirmed',
    'worktree:setup': 'worktree-decided',
    'quick-dev:init': 'task-workflow-exists',
    'tasks:init': 'task-workflow-exists',
    'implement:code': 'implementation-verified',
    'repair:code': 'implementation-verified',
    'review:cr': 'cr-complete',
    'review:cr-light': 'cr-complete',
    'review:cr-moderate': 'cr-complete',
    'review:integration': 'integration-cr-complete',
    'final:summary': 'done',
  };
  return map[step] || null;
}

main();
