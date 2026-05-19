#!/usr/bin/env node
import { existsSync } from 'node:fs';
import {
  allTasksApproved,
  getBlockedReworkTasks,
  getCodedTasksNeedingReview,
  getNextTasks,
  getReworkTasks,
  getTasksFileOverlap,
  getTasksImpactOverlap,
  getTasksExportsImportsOverlap,
  initTaskState,
  initWorkflowState,
  markCr,
  markCrRequirement,
  readTaskState,
  rollbackTask,
  rollbackWorkflow,
  taskStateFile,
  updateTaskStatus
} from './workflow-lib.mjs';

function fail(message) {
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(1);
}

function print(value) {
  console.log(JSON.stringify(value));
}

export async function main(argv) {
  const ideaDir = argv[0];
  const mode = argv[1] || '--summary';
  if (!ideaDir) fail('用法: workflow-status.mjs <idea-dir> [command] [args...]');

  try {
    switch (mode) {
      case '--init': {
        const ideaName = argv[2];
        if (!ideaName) fail('--init 需要 idea-name');
        initWorkflowState(ideaDir, ideaName);
        print({ initialized: true, idea: ideaName });
        break;
      }
      case '--init-tasks': {
        const ideaName = argv[2];
        const specs = argv.slice(3);
        if (!ideaName) fail('--init-tasks 需要 idea-name');
        if (specs.length === 0) fail('--init-tasks 需要至少一个 task spec');
        const state = initTaskState(ideaDir, ideaName, specs);
        print({ initialized: true, idea: ideaName, tasks: Object.keys(state.tasks) });
        break;
      }
      case '--next-tasks': {
        const target = argv[2] || 'code';
        if (target === 'review') print({ next_tasks: getCodedTasksNeedingReview(ideaDir) });
        else if (target === 'rework') print({ next_tasks: getReworkTasks(ideaDir) });
        else print({ next_tasks: getNextTasks(ideaDir) });
        break;
      }
      case '--start-task': {
        const taskId = argv[2];
        if (!taskId) fail('--start-task 需要 task-id');
        const state = readTaskState(taskStateFile(ideaDir));
        const current = state.tasks[taskId]?.status;
        const next = current === 'needs_rework' ? 'repairing' : 'coding';
        updateTaskStatus(ideaDir, taskId, next);
        print({ updated: true, task_id: taskId, status: next });
        break;
      }
      case '--start-review': {
        const taskId = argv[2];
        if (!taskId) fail('--start-review 需要 task-id');
        updateTaskStatus(ideaDir, taskId, 'reviewing');
        print({ updated: true, task_id: taskId, status: 'reviewing' });
        break;
      }
      case '--finish-task': {
        const taskId = argv[2];
        const result = argv[3];
        if (!taskId || !result) fail('--finish-task 需要 task-id 和 coded|failed');
        if (!['coded', 'failed'].includes(result)) fail('--finish-task 仅支持 coded|failed');
        updateTaskStatus(ideaDir, taskId, result);
        print({ updated: true, task_id: taskId, status: result });
        break;
      }
      case '--mark-cr': {
        const taskId = argv[2];
        const result = argv[3];
        if (!taskId || !result) fail('--mark-cr 需要 task-id 和 approved|needs_rework|blocked');
        if (!['approved', 'needs_rework', 'blocked'].includes(result)) fail('--mark-cr 仅支持 approved|needs_rework|blocked');
        const task = markCr(ideaDir, taskId, result);
        print({ updated: true, task_id: taskId, status: task.status, rework_count: task.rework_count || 0 });
        break;
      }
      case '--mark-cr-requirement': {
        const result = argv[2];
        if (!result) fail('--mark-cr-requirement 需要 approved|needs_rework|blocked');
        if (!['approved', 'needs_rework', 'blocked'].includes(result)) fail('--mark-cr-requirement 仅支持 approved|needs_rework|blocked');
        const affectedRaw = argv[3] || '';
        const affectedTasks = affectedRaw ? affectedRaw.split(',').filter(Boolean) : [];
        const results = markCrRequirement(ideaDir, result, affectedTasks);
        print({ updated: true, review_level: 'requirement', result, task_updates: results });
        break;
      }
      case '--rollback-step': {
        const step = argv[2];
        const dryRun = argv.includes('--dry-run');
        if (!step) fail('--rollback-step 需要 step');
        print(rollbackWorkflow(ideaDir, step, { dryRun }));
        break;
      }
      case '--rollback-task': {
        const taskId = argv[2];
        const dryRun = argv.includes('--dry-run');
        if (!taskId) fail('--rollback-task 需要 task-id');
        print(rollbackTask(ideaDir, taskId, { dryRun }));
        break;
      }
      case '--summary':
      case 'status':
      case '--status': {
        const exists = existsSync(taskStateFile(ideaDir));
        const state = exists ? readTaskState(taskStateFile(ideaDir)) : { idea: '', tasks: {} };
        print({
          idea: state.idea,
          task_count: Object.keys(state.tasks).length,
          next_code_tasks: exists ? getNextTasks(ideaDir) : [],
          next_review_tasks: exists ? getCodedTasksNeedingReview(ideaDir) : [],
          next_rework_tasks: exists ? getReworkTasks(ideaDir) : [],
          blocked_rework_tasks: exists ? getBlockedReworkTasks(ideaDir) : [],
          all_approved: exists ? allTasksApproved(ideaDir) : false,
          tasks: state.tasks
        });
        break;
      }
      case '--check-overlap': {
        const taskIds = argv.slice(2).join(',').split(',').filter(Boolean);
        if (taskIds.length < 2) fail('--check-overlap 需要至少两个 task-id（逗号分隔或空格分隔）');
        const file_overlap = getTasksFileOverlap(ideaDir, taskIds);
        const impact_overlap = getTasksImpactOverlap(ideaDir, taskIds);
        const exports_imports_overlap = getTasksExportsImportsOverlap(ideaDir, taskIds);
        print({
          overlaps: file_overlap,
          file_overlap,
          impact_overlap,
          exports_imports_overlap,
          has_overlap: file_overlap.length > 0 || impact_overlap.length > 0,
          has_dependency: exports_imports_overlap.length > 0
        });
        break;
      }
      default:
        fail(`未知命令: ${mode}`);
    }
  } catch (error) {
    fail(error.message);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
