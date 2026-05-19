#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { atomicWriteFile, ensureDir, initTaskState, normalizeImpactSurface, readFrontmatter } from './workflow-lib.mjs';

const VALID_RISK_LEVELS = new Set(['low', 'medium', 'high']);

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

function validateTask(task, index) {
  const taskId = task.task_id || '';
  if (!/^task-\d{3}[A-Za-z0-9_-]*$/.test(taskId)) throw new Error(`tasks[${index}] missing valid task_id`);
  if (!task.goal) throw new Error(`${taskId} missing goal`);
  if (!task.title) throw new Error(`${taskId} missing title`);
  requireArray(task.depends_on || [], 'depends_on', taskId);
  requireArray(task.allowed_files, 'allowed_files', taskId);
  requireArray(task.forbidden_files, 'forbidden_files', taskId);
  requireArray(task.expected_files, 'expected_files', taskId);
  requireArray(task.acceptance_criteria, 'acceptance_criteria', taskId);
  requireArray(task.verification, 'verification', taskId);
  requireArray(task.trace_refs, 'trace_refs', taskId);
  requireArray(task.exports || [], 'exports', taskId);
  requireArray(task.imports || [], 'imports', taskId);
  requireArray(task.allowed_symbols || [], 'allowed_symbols', taskId);
  requireArray(task.forbidden_symbols || [], 'forbidden_symbols', taskId);
  requireArray(task.behavior_invariants, 'behavior_invariants', taskId);
  if (!task.impact_surface || typeof task.impact_surface !== 'object' || Array.isArray(task.impact_surface)) throw new Error(`${taskId} missing impact_surface`);
  for (const key of ['files', 'symbols', 'invariants', 'shared_state']) requireArray(task.impact_surface[key] || [], `impact_surface.${key}`, taskId);
  if (task.acceptance_criteria.length === 0) throw new Error(`${taskId} acceptance_criteria must not be empty`);
  if (task.verification.length === 0) throw new Error(`${taskId} verification must not be empty`);
  if (task.trace_refs.length === 0) throw new Error(`${taskId} trace_refs must not be empty`);
  if (task.behavior_invariants.length === 0) throw new Error(`${taskId} behavior_invariants must not be empty`);
  if (!task.context_to_load || typeof task.context_to_load !== 'object') throw new Error(`${taskId} missing context_to_load`);
  for (const key of ['as_is', 'to_be', 'wiki', 'module_map', 'adr', 'tests']) requireArray(task.context_to_load[key] || [], `context_to_load.${key}`, taskId);
  if (!VALID_RISK_LEVELS.has(task.risk_level)) throw new Error(`${taskId} risk_level must be low, medium, or high`);
  if (!task.rollback) throw new Error(`${taskId} missing rollback`);
  return task;
}

function validateTasksDocument(doc) {
  if (!doc || !Array.isArray(doc.tasks)) throw new Error('tasks.json must contain tasks array');
  const tasks = doc.tasks.map(validateTask);
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

function contextLines(context = {}) {
  return [
    `- as-is：${(context.as_is || []).join(', ') || '无'}`,
    `- to-be：${(context.to_be || []).join(', ') || '无'}`,
    `- wiki：${(context.wiki || []).join(', ') || '无'}`,
    `- module map：${(context.module_map || []).join(', ') || '无'}`,
    `- ADR：${(context.adr || []).join(', ') || '无'}`,
    `- tests：${(context.tests || []).join(', ') || '无'}`
  ].join('\n');
}

function renderTaskMarkdown(task) {
  const verificationPreCheck = checkVerificationBinaries(task);
  return `---
task_id: ${task.task_id}
status: confirmed
depends_on: ${yamlList(task.depends_on || [])}
description: ${JSON.stringify(task.title)}
expected_files: ${yamlList(task.expected_files || [])}
trace_refs: ${yamlList(task.trace_refs || [])}
allowed_symbols: ${yamlList(task.allowed_symbols || [])}
forbidden_symbols: ${yamlList(task.forbidden_symbols || [])}
exports: ${yamlList(task.exports || [])}
imports: ${yamlList(task.imports || [])}
impact_surface: ${JSON.stringify(normalizeImpactSurface(task.impact_surface))}
verification_pre_check: ${verificationPreCheck}
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

## Verification

\`\`\`bash
${task.verification.join('\n')}
\`\`\`

## Rollback Point

${task.rollback}

## Risk Level

${task.risk_level}

## Notes for Coder Agent

${task.notes_for_coder || '无'}

## Notes for Reviewer Agent

${task.notes_for_reviewer || '无'}
`;
}

function checkVerificationBinaries(task) {
  const warnings = [];
  for (const cmd of task.verification || []) {
    const binary = cmd.trim().split(/\s+/)[0];
    if (!binary || binary.startsWith('#') || binary.startsWith('$') || binary.startsWith('cd')) continue;
    try {
      execSync(`command -v ${binary}`, { encoding: 'utf8', stdio: 'pipe' });
    } catch {
      warnings.push(binary);
    }
  }
  return warnings.length > 0 ? `missing: ${warnings.join(', ')}` : 'pass';
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
