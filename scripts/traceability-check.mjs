#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readTaskState, taskStateFile } from './workflow-lib.mjs';
import { resolveExistingIdeaDirectory } from './control-plane.mjs';

const IDEA_DIR = process.argv[2] ? resolveExistingIdeaDirectory(process.argv[2], process.cwd()) : '';
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

function normalizeRefs(value) {
  return Array.isArray(value) ? [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))] : [];
}

function taskTraceRefs(taskId, state) {
  const task = state.tasks?.[taskId];
  if (!task) return [];
  const text = existsSync(join(IDEA_DIR, task.file || `tasks/${taskId}.md`))
    ? readFileSync(join(IDEA_DIR, task.file || `tasks/${taskId}.md`), 'utf8') : '';
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---/);
  const line = frontmatter?.[1]?.split('\n').find(item => /^trace_refs:\s*/.test(item));
  if (!line) return [];
  const raw = line.replace(/^trace_refs:\s*/, '').trim().replace(/^\[|\]$/g, '');
  return normalizeRefs(raw ? raw.split(',').map(value => value.trim().replace(/^['"]|['"]$/g, '')) : []);
}

function main() {
  const matrix = readJson('to-be/traceability-matrix.json');
  if (!matrix) {
    console.log(JSON.stringify({ schema_version: 2, pass: false, reason: 'traceability-matrix.json missing' }));
    return;
  }

  const items = Array.isArray(matrix.items) ? matrix.items : Array.isArray(matrix) ? matrix : [];
  if (items.length === 0) {
    console.log(JSON.stringify({ schema_version: 2, pass: false, reason: 'traceability matrix is empty' }));
    return;
  }

  const state = readTaskState(taskStateFile(IDEA_DIR));
  const clarification = readJson('requirement-clarification.json');
  const acceptanceCriteria = clarification?.dimensions?.acceptance_criteria || [];

  const itemById = new Map(items.map(item => [item?.id, item]));
  const structuralErrors = [];
  for (const item of items) {
    const id = item?.id || 'unknown';
    const coveredByTasks = normalizeRefs(item?.covered_by_tasks || item?.covering_tasks);
    if (coveredByTasks.length === 0) structuralErrors.push(`${id} has no covering task`);
    for (const taskId of coveredByTasks) {
      if (!state.tasks?.[taskId]) structuralErrors.push(`${id} references unknown task ${taskId}`);
      else if (!taskTraceRefs(taskId, state).includes(id)) structuralErrors.push(`${taskId} trace_refs missing ${id}`);
    }
  }
  for (const [taskId] of Object.entries(state.tasks || {})) {
    const refs = taskTraceRefs(taskId, state);
    for (const ref of refs) {
      const item = itemById.get(ref);
      if (!item) structuralErrors.push(`${taskId} references unknown trace ref ${ref}`);
      else if (!normalizeRefs(item.covered_by_tasks || item.covering_tasks).includes(taskId)) structuralErrors.push(`${ref} missing reverse task reference ${taskId}`);
    }
  }

  const exactAcCoverage = [];
  let exactMappingMissing = 0;
  for (const ac of acceptanceCriteria) {
    const acId = String(typeof ac === 'string' ? (ac.match(/\bAC-\d{3}\b/)?.[0] || '') : (ac?.id || '')).trim();
    const item = itemById.get(acId);
    const sourceRefs = normalizeRefs(item?.source_refs);
    const mapped = Boolean(item && (!item.type || item.type === 'acceptance_criteria') && (sourceRefs.length === 0 || sourceRefs.includes(acId)));
    if (!mapped) exactMappingMissing++;
    exactAcCoverage.push({ ac_id: acId, description: typeof ac === 'string' ? ac : ac?.description || '', mapped_trace_ids: mapped ? [acId] : [], status: mapped ? 'mapped' : 'unmapped' });
    for (const vc of typeof ac === 'object' && Array.isArray(ac?.verification_conditions) ? ac.verification_conditions : []) {
      const vcId = String(vc?.id || '').trim();
      const ref = `${acId}/${vcId}`;
      const vcItem = itemById.get(ref);
      const vcRefs = normalizeRefs(vcItem?.source_refs);
      const vcMapped = Boolean(vcItem && (!vcItem.type || vcItem.type === 'verification_condition') && (vcRefs.length === 0 || vcRefs.includes(ref) || (vcRefs.includes(acId) && vcRefs.includes(vcId))));
      if (!vcMapped) exactMappingMissing++;
      exactAcCoverage.push({ vc_ref: ref, condition: vc?.condition || '', mapped_trace_ids: vcMapped ? [ref] : [], status: vcMapped ? 'mapped' : 'unmapped' });
    }
  }

  const results = [];
  let covered = 0, inProgress = 0, pending = 0, missing = 0;

  for (const item of items) {
    const id = item.id || item.req_id || 'unknown';
    const description = item.description || item.source || '';
    const coveredByTasks = item.covered_by_tasks || item.covering_tasks || [];

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

  let vcMissing = 0;
  const vcCoverage = [];
  for (const ac of acceptanceCriteria) {
    const vcs = ac.verification_conditions;
    if (!Array.isArray(vcs) || vcs.length === 0) continue;
    for (const vc of vcs) {
      const vcRef = `${ac.id}/${vc.id}`;
      const coveringItem = items.find(it =>
        (it.covered_by_tasks || []).length > 0 &&
        (it.id === vcRef || (it.source_refs || []).includes(vcRef))
      );
      const coveringTask = coveringItem ? coveringItem.covered_by_tasks : [];
      const status = coveringTask.length > 0 ? 'covered' : 'missing';
      if (status === 'missing') vcMissing++;
      vcCoverage.push({ vc_ref: vcRef, condition: vc.condition || '', covering_tasks: coveringTask, status });
    }
  }

  let pass;
  let reason;
  if (FINAL_MODE) {
    pass = missing === 0 && pending === 0 && inProgress === 0 && vcMissing === 0 && exactMappingMissing === 0 && structuralErrors.length === 0;
    reason = pass ? 'all requirements fully covered' : `${missing} missing, ${pending} pending, ${inProgress} in_progress, ${vcMissing} vc_missing, ${exactMappingMissing} exact mappings missing, ${structuralErrors.length} structural errors`;
  } else {
    pass = missing === 0 && vcMissing === 0 && exactMappingMissing === 0 && structuralErrors.length === 0;
    reason = pass ? 'no missing coverage' : `${missing} requirements have no covering task, ${vcMissing} verification conditions uncovered, ${exactMappingMissing} exact mappings missing, ${structuralErrors.length} structural errors`;
  }

  const output = {
    schema_version: 2,
    total_requirements: items.length,
    covered,
    in_progress: inProgress,
    pending,
    missing,
    items: results,
    acceptance_criteria_coverage: exactAcCoverage.length > 0 ? exactAcCoverage : acCoverage,
    verification_conditions_coverage: vcCoverage.length > 0 ? vcCoverage : undefined,
    vc_missing: vcMissing,
    pass,
    reason,
    ...(structuralErrors.length > 0 ? { structural_errors: structuralErrors } : {})
  };

  console.log(JSON.stringify(output, null, 2));
}

main();
