#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTaskState, taskStateFile } from './workflow-lib.mjs';

const IDEA_DIR = process.argv[2];
const FINAL_MODE = process.argv.includes('--final');

if (!IDEA_DIR) {
  process.stderr.write('用法: node traceability-check.mjs <idea-dir> [--final]\n');
  process.exit(1);
}

function readJson(rel) {
  const p = join(IDEA_DIR, rel);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

function main() {
  const matrix = readJson('to-be/traceability-matrix.json');
  if (!matrix) {
    console.log(JSON.stringify({ schema_version: 1, pass: true, reason: 'traceability-matrix.json not found, skipped' }));
    return;
  }

  const items = Array.isArray(matrix.items) ? matrix.items : Array.isArray(matrix) ? matrix : [];
  if (items.length === 0) {
    console.log(JSON.stringify({ schema_version: 1, pass: true, reason: 'traceability matrix is empty, skipped' }));
    return;
  }

  const state = readTaskState(taskStateFile(IDEA_DIR));
  const clarification = readJson('requirement-clarification.json');
  const acceptanceCriteria = clarification?.dimensions?.acceptance_criteria || [];

  const results = [];
  let covered = 0, inProgress = 0, pending = 0, missing = 0;

  for (const item of items) {
    const id = item.id || item.req_id || 'unknown';
    const description = item.description || item.source || '';
    const coveredByTasks = item.covered_by_tasks || [];

    if (coveredByTasks.length === 0) {
      missing++;
      results.push({ id, description, covered_by_tasks: coveredByTasks, task_statuses: {}, coverage_status: 'missing' });
      continue;
    }

    const taskStatuses = {};
    let allApproved = true;
    let anyActive = false;
    let anyMissing = false;

    for (const taskId of coveredByTasks) {
      const task = state.tasks[taskId];
      if (!task) {
        taskStatuses[taskId] = 'not_found';
        anyMissing = true;
        allApproved = false;
      } else {
        taskStatuses[taskId] = task.status;
        if (task.status !== 'approved') allApproved = false;
        if (['coding', 'coded', 'reviewing', 'repairing'].includes(task.status)) anyActive = true;
      }
    }

    let coverageStatus;
    if (anyMissing) {
      coverageStatus = 'missing';
      missing++;
    } else if (allApproved) {
      coverageStatus = 'complete';
      covered++;
    } else if (anyActive) {
      coverageStatus = 'in_progress';
      inProgress++;
    } else {
      coverageStatus = 'pending';
      pending++;
    }

    results.push({ id, description, covered_by_tasks: coveredByTasks, task_statuses: taskStatuses, coverage_status: coverageStatus });
  }

  const acCoverage = acceptanceCriteria.map(ac => {
    const acId = ac.id || ac.description?.slice(0, 20);
    const mappedTraceIds = items.filter(it => (it.covered_by_tasks || []).length > 0 && it.source_refs?.includes(acId)).map(it => it.id);
    const directMatch = items.filter(it => it.id === acId || it.source === acId);
    const mapped = mappedTraceIds.length > 0 ? mappedTraceIds : directMatch.map(it => it.id);
    return { ac_id: acId, description: ac.description || '', mapped_trace_ids: mapped, status: mapped.length > 0 ? 'mapped' : 'unmapped' };
  });

  let pass;
  let reason;
  if (FINAL_MODE) {
    pass = missing === 0 && pending === 0 && inProgress === 0;
    reason = pass ? 'all requirements fully covered' : `${missing} missing, ${pending} pending, ${inProgress} in_progress`;
  } else {
    pass = missing === 0;
    reason = pass ? 'no missing coverage' : `${missing} requirements have no covering task`;
  }

  const output = {
    schema_version: 1,
    total_requirements: items.length,
    covered,
    in_progress: inProgress,
    pending,
    missing,
    items: results,
    acceptance_criteria_coverage: acCoverage,
    pass,
    reason
  };

  console.log(JSON.stringify(output, null, 2));
}

main();
