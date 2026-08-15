#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { STEP_GATE_MAP, WORKFLOW_PATHS } from './workflow-definition.mjs';
import { detectComplexity } from './workflow-lib.mjs';
import { checkGate } from './gate-check.mjs';
import { resolveExistingIdeaDirectory } from './control-plane.mjs';

const STEP_DESCRIPTIONS = {
  'receive-requirement': '接收并结构化需求，产出 requirement.md',
  'understand:explore': '代码侦察 + 深度走查，产出 as-is 结构化分析',
  'understand:confirm': '向用户展示 as-is 摘要，确认理解正确',
  'clarify:requirement': '多维度需求澄清，产出 requirement-clarification.json',
  'classify:requirement': '澄清后分级并确定执行档位与 subagent 预算',
  'plan:design': '方案设计 + task 拆分，产出 to-be/ 全套产物',
  'plan:confirm': '向用户展示方案，确认后写入确认凭据',
  'worktree:setup': '决定是否 worktree 隔离开发',
  'quick-dev:init': '校验有界低风险 scope；通过 quick-dev-ready 后生成 task，超限自动升级',
  'tasks:init': '初始化 task 状态机，生成 coder-context',
  'implement:code': '按 task 逐个实现代码',
  'repair:code': '按 CR 返修意见修复代码',
  'test:unit': '运行单测与覆盖率，集中修复异常并确认测试报告',
  'review:cr': '多维度 Code Review（spec + D2-D9）',
  'review:cr-light': '轻量 Code Review（仅 spec 维度）',
  'review:cr-moderate': 'Code Review（spec + D3-D5）',
  'review:integration': '跨 task 集成一致性审查',
  'review:cr-report': '全部 CR 返修闭环后生成并确认最终 CR 报告',
  'final:summary': '生成最终变更摘要 + 验证证据汇总',
  'review:merge': '把当前实现与精确快照并入 CR 报告，等待用户批准合并',
};

function resolveStepStatus(ideaDir, step, gateId) {
  if (!gateId) return 'pending';
  const result = checkGate(ideaDir, gateId);
  return result.pass ? 'completed' : 'pending';
}

function main() {
  const args = process.argv.slice(2);
  const ideaDir = resolveExistingIdeaDirectory(args[0] || '.', process.cwd());

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
    const status = resolveStepStatus(ideaDir, step, STEP_GATE_MAP[step]);
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

main();
