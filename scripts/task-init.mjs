#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile, ensureDir, initTaskState, normalizeImpactSurface, readFrontmatter } from './workflow-lib.mjs';

const VALID_RISK_LEVELS = new Set(['low', 'medium', 'high']);
const VALID_TASK_COMPLEXITIES = new Set(['trivial', 'standard', 'complex']);
const VALID_FILE_CHANGE_TYPES = new Set(['add', 'modify', 'delete', 'rename', 'config', 'test', 'docs', 'review_only']);

function fail(message) {
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(1);
}

function parseArgs(argv) {
  const ideaDir = argv[0];
  const options = { ideaDir, ideaName: '', from: 'to-be/tasks.json', check: false, force: false };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--idea') options.ideaName = argv[++i] || '';
    else if (arg === '--from') options.from = argv[++i] || '';
    else if (arg === '--check') options.check = true;
    else if (arg === '--force') options.force = true;
    else fail(`未知参数: ${arg}`);
  }
  if (!options.ideaDir) fail('用法: task-init.mjs <idea-dir> --idea <idea-name> --from to-be/tasks.json [--check] [--force]');
  if (!options.ideaName && !options.check) fail('--idea 需要 idea-name');
  if (!options.from) fail('--from 需要 tasks.json 路径');
  return options;
}

function loadTasksJson(ideaDir, fromPath) {
  const file = join(ideaDir, fromPath);
  if (!existsSync(file)) throw new Error(`tasks json not found: ${fromPath}`);
  const parsed = JSON.parse(readFileSync(file, 'utf8'));
  return parsed;
}

function requireArray(value, field, taskId) {
  if (!Array.isArray(value)) throw new Error(`${taskId} ${field} must be an array`);
  return value;
}

function validateFilePlan(task, { requireFilePlan = false } = {}) {
  const taskId = task.task_id || '';
  if (task.file_plan === undefined) {
    if (requireFilePlan) throw new Error(`${taskId} missing file_plan (required by schema_version>=2 or plan_with_file=true)`);
    return [];
  }
  const filePlan = requireArray(task.file_plan, 'file_plan', taskId);
  if (requireFilePlan && filePlan.length === 0) throw new Error(`${taskId} file_plan must not be empty`);
  const cpRefs = new Set(task.change_point_refs || []);
  const traceRefs = new Set(task.trace_refs || []);
  for (const [index, item] of filePlan.entries()) {
    const label = `${taskId} file_plan[${index}]`;
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${label} must be an object`);
    if (!item.path || typeof item.path !== 'string') throw new Error(`${label} missing path`);
    if (!VALID_FILE_CHANGE_TYPES.has(item.change_type)) throw new Error(`${label} change_type must be one of: ${[...VALID_FILE_CHANGE_TYPES].join(', ')}`);
    if (!item.purpose || typeof item.purpose !== 'string') throw new Error(`${label} missing purpose`);
    const itemCpRefs = requireArray(item.change_point_refs || [], `${label}.change_point_refs`, taskId);
    const itemTraceRefs = requireArray(item.trace_refs || [], `${label}.trace_refs`, taskId);
    requireArray(item.expected_symbols || [], `${label}.expected_symbols`, taskId);
    if (item.report_required !== undefined && typeof item.report_required !== 'boolean') throw new Error(`${label} report_required must be boolean`);
    const unknownCpRefs = itemCpRefs.filter(ref => !cpRefs.has(ref));
    if (unknownCpRefs.length > 0) throw new Error(`${label} references unknown change_point_refs: ${unknownCpRefs.join(', ')}`);
    const unknownTraceRefs = itemTraceRefs.filter(ref => !traceRefs.has(ref));
    if (unknownTraceRefs.length > 0) throw new Error(`${label} references unknown trace_refs: ${unknownTraceRefs.join(', ')}`);
  }
  return filePlan;
}

function validateTask(task, index, options = {}) {
  const taskId = task.task_id || '';
  if (!/^task-\d{3}[A-Za-z0-9_-]*$/.test(taskId)) throw new Error(`tasks[${index}] missing valid task_id`);
  if (!task.goal) throw new Error(`${taskId} missing goal`);
  if (!task.title) throw new Error(`${taskId} missing title`);
  requireArray(task.depends_on || [], 'depends_on', taskId);
  requireArray(task.allowed_files, 'allowed_files', taskId);
  requireArray(task.forbidden_files, 'forbidden_files', taskId);
  requireArray(task.expected_files, 'expected_files', taskId);
  requireArray(task.acceptance_criteria, 'acceptance_criteria', taskId);
  requireArray(task.verification || [], 'verification', taskId);
  requireArray(task.trace_refs, 'trace_refs', taskId);
  requireArray(task.exports || [], 'exports', taskId);
  requireArray(task.imports || [], 'imports', taskId);
  requireArray(task.allowed_symbols || [], 'allowed_symbols', taskId);
  requireArray(task.forbidden_symbols || [], 'forbidden_symbols', taskId);
  requireArray(task.behavior_invariants, 'behavior_invariants', taskId);
  requireArray(task.change_point_refs, 'change_point_refs', taskId);
  if (!task.impact_surface || typeof task.impact_surface !== 'object' || Array.isArray(task.impact_surface)) throw new Error(`${taskId} missing impact_surface`);
  for (const key of ['files', 'symbols', 'invariants', 'shared_state']) requireArray(task.impact_surface[key] || [], `impact_surface.${key}`, taskId);
  if (task.acceptance_criteria.length === 0) throw new Error(`${taskId} acceptance_criteria must not be empty`);
  if (task.trace_refs.length === 0) throw new Error(`${taskId} trace_refs must not be empty`);
  if (task.behavior_invariants.length === 0) throw new Error(`${taskId} behavior_invariants must not be empty`);
  if (task.change_point_refs.length === 0) throw new Error(`${taskId} change_point_refs must not be empty`);
  if (!task.context_to_load || typeof task.context_to_load !== 'object') throw new Error(`${taskId} missing context_to_load`);
  for (const key of ['as_is', 'to_be', 'wiki', 'module_map', 'adr']) requireArray(task.context_to_load[key] || [], `context_to_load.${key}`, taskId);
  if (!VALID_RISK_LEVELS.has(task.risk_level)) throw new Error(`${taskId} risk_level must be low, medium, or high`);
  if (!task.rollback) throw new Error(`${taskId} missing rollback`);
  if (task.task_complexity && !VALID_TASK_COMPLEXITIES.has(task.task_complexity)) throw new Error(`${taskId} task_complexity must be trivial, standard, or complex`);
  validateFilePlan(task, options);
  return task;
}

function validateTasksDocument(doc) {
  if (!doc || !Array.isArray(doc.tasks)) throw new Error('tasks.json must contain tasks array');
  const requireFilePlan = doc.plan_with_file === true || Number(doc.schema_version || 1) >= 2;
  const tasks = doc.tasks.map((task, index) => validateTask(task, index, { requireFilePlan }));
  const ids = new Set(tasks.map(task => task.task_id));
  if (ids.size !== tasks.length) throw new Error('tasks.json contains duplicate task_id');
  for (const task of tasks) {
    const dangling = (task.depends_on || []).filter(dep => !ids.has(dep));
    if (dangling.length > 0) throw new Error(`${task.task_id} has unknown dependencies: ${dangling.join(', ')}`);
  }
  return tasks;
}

function yamlList(values = []) {
  return `[${values.join(', ')}]`;
}

function bulletList(values = []) {
  return values.length > 0 ? values.map(value => `- ${value}`).join('\n') : '- 无';
}

function checkboxList(values = []) {
  return values.map(value => `- [ ] ${value}`).join('\n');
}

function inlineList(values = []) {
  return `[${values.join(', ')}]`;
}

function markdownCell(value) {
  return String(value ?? '').replace(/\|/g, '/').replace(/\n/g, ' ').trim() || '无';
}

function renderFilePlanRows(filePlan = []) {
  if (filePlan.length === 0) return '| 无 | review_only | 未声明 file_plan；请按 expected_files 和 implementation_notes 执行，并在 report 中列出 changed_files。 | 无 | 无 | 无 | false |';
  return filePlan.map(item => [
    item.path,
    item.change_type,
    item.purpose,
    (item.change_point_refs || []).join(', ') || '无',
    (item.trace_refs || []).join(', ') || '无',
    (item.expected_symbols || []).join(', ') || '无',
    item.report_required === false ? 'false' : 'true'
  ].map(markdownCell)).map(cells => `| ${cells.join(' | ')} |`).join('\n');
}

function contextLines(context = {}) {
  return [
    `- as-is：${(context.as_is || []).join(', ') || '无'}`,
    `- to-be：${(context.to_be || []).join(', ') || '无'}`,
    `- wiki：${(context.wiki || []).join(', ') || '无'}`,
    `- module map：${(context.module_map || []).join(', ') || '无'}`,
    `- ADR：${(context.adr || []).join(', ') || '无'}`
  ].join('\n');
}

function renderTaskMarkdown(task) {
  return `---
task_id: ${task.task_id}
status: confirmed
depends_on: ${yamlList(task.depends_on || [])}
description: ${JSON.stringify(task.title)}
expected_files: ${yamlList(task.expected_files || [])}
trace_refs: ${yamlList(task.trace_refs || [])}
change_point_refs: ${yamlList(task.change_point_refs || [])}
${task.file_plan ? 'file_plan_schema_version: 1\n' : ''}allowed_symbols: ${yamlList(task.allowed_symbols || [])}
forbidden_symbols: ${yamlList(task.forbidden_symbols || [])}
exports: ${yamlList(task.exports || [])}
imports: ${yamlList(task.imports || [])}
impact_surface: ${JSON.stringify(normalizeImpactSurface(task.impact_surface))}
task_complexity: ${task.task_complexity || 'standard'}
---

# Task: ${task.task_id} - ${task.title}

## 背景

${task.background || '引用 as-is 和 to-be 中与本 task 相关的内容。'}

## 目标行为

${task.goal}

## Scope

### Allowed Files / Areas

${bulletList(task.allowed_files)}

### Forbidden Files / Areas

${bulletList(task.forbidden_files)}

### Safe-to-change Assumptions

${bulletList(task.safe_to_change_assumptions || [])}

### Allowed Symbols

${bulletList(task.allowed_symbols || [])}

### Forbidden Symbols

${bulletList(task.forbidden_symbols || [])}

## Impact Surface

- files：${inlineList(normalizeImpactSurface(task.impact_surface).files)}
- symbols：${inlineList(normalizeImpactSurface(task.impact_surface).symbols)}
- invariants：${inlineList(normalizeImpactSurface(task.impact_surface).invariants)}
- shared_state：${inlineList(normalizeImpactSurface(task.impact_surface).shared_state)}

## Change Points

${bulletList(task.change_point_refs)}

## File-Level Plan

| File | Change Type | Purpose | CP Refs | Trace Refs | Expected Symbols | Report Required |
|---|---|---|---|---|---|---|
${renderFilePlanRows(task.file_plan || [])}

## Exports

${bulletList(task.exports || [])}

## Imports

${bulletList(task.imports || [])}

## Context to Load

${contextLines(task.context_to_load)}

## 实现要求

${task.implementation_notes || '按 to-be 方案实现本 task，保持现有风格，不做范围外重构。'}

## Traceability

${bulletList(task.trace_refs)}

## Behavior Invariants

${checkboxList(task.behavior_invariants)}

## Acceptance Criteria

${checkboxList(task.acceptance_criteria)}

## Rollback Point

${task.rollback}

## Risk Level

${task.risk_level}

## Notes for Coder Agent

${task.notes_for_coder || '无'}
${task.modification_hints && task.modification_hints.length > 0 ? `
## Modification Hints

${bulletList(task.modification_hints)}
` : ''}
## Notes for Reviewer Agent

${task.notes_for_reviewer || '无'}
`;
}

function checkExistingTaskFiles(ideaDir, tasks) {
  for (const task of tasks) {
    const taskFile = join(ideaDir, 'tasks', `${task.task_id}.md`);
    if (!existsSync(taskFile)) continue;
    const fm = readFrontmatter(readFileSync(taskFile, 'utf8'));
    const existing = fm.expected_files || [];
    if (existing.length !== task.expected_files.length || existing.some((value, index) => value !== task.expected_files[index])) {
      throw new Error(`${task.task_id} expected_files mismatch with existing task file`);
    }
  }
}

function writeTasks(ideaDir, tasks, force) {
  ensureDir(join(ideaDir, 'tasks'));
  for (const task of tasks) {
    const taskFile = join(ideaDir, 'tasks', `${task.task_id}.md`);
    if (existsSync(taskFile) && !force) throw new Error(`task file already exists: tasks/${task.task_id}.md (use --force to overwrite)`);
    atomicWriteFile(taskFile, renderTaskMarkdown(task));
  }
}

function initFromTasksJson(options) {
  const doc = loadTasksJson(options.ideaDir, options.from);
  const tasks = validateTasksDocument(doc);
  if (options.check) checkExistingTaskFiles(options.ideaDir, tasks);

  if (options.check) return { checked: true, tasks: tasks.map(task => task.task_id) };

  writeTasks(options.ideaDir, tasks, options.force);
  const specs = tasks.map(task => ({
    taskId: task.task_id,
    depends_on: task.depends_on || [],
    description: task.title,
    file: `tasks/${task.task_id}.md`,
    expected_files: task.expected_files || [],
    exports: task.exports || [],
    imports: task.imports || [],
    impact_surface: normalizeImpactSurface(task.impact_surface)
  }));
  initTaskState(options.ideaDir, options.ideaName, specs);
  return { initialized: true, idea: options.ideaName, tasks: tasks.map(task => task.task_id) };
}

function main(argv) {
  try {
    const options = parseArgs(argv);
    console.log(JSON.stringify(initFromTasksJson(options)));
  } catch (error) {
    fail(error.message);
  }
}

export { initFromTasksJson, parseArgs, renderTaskMarkdown, validateTasksDocument };

if (import.meta.url === `file://${process.argv[1]}`) {
  main(process.argv.slice(2));
}
