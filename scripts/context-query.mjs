#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFrontmatter } from './workflow-lib.mjs';
import { isValidConfirmationActor } from './execution-mode.mjs';

const DEFAULT_LIMIT = 20;
const DEFAULT_MAX_CHARS = 24_000;

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function fail(message) {
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(1);
}

function option(args, name, fallback = undefined) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : fallback;
}

function bounded(value, maxCharacters = DEFAULT_MAX_CHARS) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  if (text.length <= maxCharacters) return { content: text, truncated: false, characters: text.length };
  return {
    content: text.slice(0, maxCharacters),
    truncated: true,
    characters: maxCharacters,
    total_characters: text.length,
    continuation: maxCharacters,
  };
}

function within(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function safePath(root, path) {
  const candidate = resolve(root, path);
  if (!within(root, candidate)) throw new Error(`path escapes selected root: ${path}`);
  return candidate;
}

function sectionText(content, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(content || '').match(new RegExp(`^#{2,6}\\s+${escaped}[^\\n]*\\n([\\s\\S]*?)(?=^#{2,6}\\s+|(?![\\s\\S]))`, 'm'))?.[1]?.trim() || '';
}

function markdownTask(content, taskId) {
  const fm = readFrontmatter(content);
  return {
    task_id: fm.task_id || taskId,
    task_complexity: fm.task_complexity || 'standard',
    starting_points: fm.starting_points || [],
    forbidden_files: fm.forbidden_files || [],
    trace_refs: fm.trace_refs || [],
    change_point_refs: fm.change_point_refs || [],
    goal: sectionText(content, '目标行为'),
    acceptance_criteria: sectionText(content, 'Acceptance Criteria'),
    behavior_invariants: sectionText(content, 'Behavior Invariants'),
    file_plan: sectionText(content, 'File-Level Plan'),
    modification_hints: sectionText(content, 'Modification Hints'),
  };
}

function selectFields(value, fields) {
  if (!fields?.length) return value;
  return Object.fromEntries(fields.filter(field => Object.hasOwn(value, field)).map(field => [field, value[field]]));
}

export function queryTask(ideaDir, taskId, fields = []) {
  const tasksPath = safePath(ideaDir, 'to-be/tasks.json');
  if (existsSync(tasksPath)) {
    const content = readFileSync(tasksPath, 'utf8');
    const doc = JSON.parse(content);
    const task = (doc.tasks || []).find(candidate => candidate?.task_id === taskId);
    if (task) return { source: 'to-be/tasks.json', source_sha256: sha256(content), task: selectFields(task, fields) };
  }
  const taskPath = safePath(ideaDir, `tasks/${taskId}.md`);
  if (!existsSync(taskPath)) throw new Error(`task not found: ${taskId}`);
  const content = readFileSync(taskPath, 'utf8');
  return { source: `tasks/${taskId}.md`, source_sha256: sha256(content), task: selectFields(markdownTask(content, taskId), fields) };
}

function collectJsonMatches(value, refs, path = '$', matches = []) {
  if (matches.length >= 100) return matches;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      const itemPath = `${path}[${index}]`;
      if (typeof item === 'string' && refs.some(ref => item.includes(ref))) matches.push({ selector: itemPath, value: item });
      else if (item && typeof item === 'object') {
        const shallowValues = Object.values(item).filter(candidate =>
          typeof candidate === 'string' || (Array.isArray(candidate) && candidate.every(entry => typeof entry === 'string'))
        ).flat();
        if (shallowValues.some(candidate => refs.some(ref => candidate.includes(ref)))) {
          matches.push({ selector: itemPath, value: item });
        } else collectJsonMatches(item, refs, itemPath, matches);
      }
    });
  } else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      const itemPath = `${path}.${key}`;
      if (typeof item === 'string' && refs.some(ref => item.includes(ref))) matches.push({ selector: itemPath, value: item });
      else if (item && typeof item === 'object') collectJsonMatches(item, refs, itemPath, matches);
    }
  }
  return matches;
}

function readJsonWithRef(ideaDir, path) {
  const absolute = safePath(ideaDir, path);
  if (!existsSync(absolute)) return null;
  const content = readFileSync(absolute, 'utf8');
  return { path, sha256: sha256(content), value: JSON.parse(content) };
}

export function queryDecision(ideaDir, taskId) {
  const taskResult = queryTask(ideaDir, taskId, ['change_point_refs']);
  const cpRefs = Array.isArray(taskResult.task.change_point_refs) ? taskResult.task.change_point_refs : [];
  const notesSource = readJsonWithRef(ideaDir, 'to-be/design-notes.json');
  const confirmationSource = readJsonWithRef(ideaDir, 'confirmations/to-be.json');
  const confirmation = confirmationSource?.value;
  const userConfirmed = (confirmation?.status === 'confirmed' && isValidConfirmationActor(ideaDir, confirmation?.confirmed_by))
    || existsSync(safePath(ideaDir, '.to-be-confirmed'));
  const notes = notesSource?.value || {};
  const changePoints = Array.isArray(notes.change_point_details) ? notes.change_point_details : [];
  const relevantChangePoints = changePoints.filter(point =>
    cpRefs.includes(point?.cp_id || point?.id) || (point?.corresponding_tasks || []).includes(taskId)
  );
  return {
    task_id: taskId,
    user_confirmed: userConfirmed,
    authority: userConfirmed ? 'user-confirmed-plan' : 'unconfirmed-advisory',
    confirmed_at: userConfirmed ? confirmation?.confirmed_at || null : null,
    task_change_point_refs: cpRefs,
    decisions: {
      goal_behavior: notes.goal_behavior || null,
      non_goal_behavior: notes.non_goal_behavior || null,
      strategy_overview: notes.strategy_overview || notes.tl_dr || null,
      historical_behaviors: Array.isArray(notes.historical_behaviors) ? notes.historical_behaviors : [],
      verification_surface: Array.isArray(notes.verification_surface) ? notes.verification_surface : [],
      forbidden_scope: Array.isArray(notes.forbidden_scope) ? notes.forbidden_scope : [],
      relevant_change_points: relevantChangePoints,
    },
    source_refs: {
      design_notes: notesSource ? { path: notesSource.path, sha256: notesSource.sha256 } : null,
      confirmation: confirmationSource ? { path: confirmationSource.path, sha256: confirmationSource.sha256 } : null,
      api_contract: readJsonWithRef(ideaDir, 'to-be/api-change-plan.json')?.path || null,
      data_contract: readJsonWithRef(ideaDir, 'to-be/data-change-plan.json')?.path || null,
    },
    interpretation: userConfirmed
      ? 'Honor these decisions as user intent. Verify claims about current code, file locations, and implementation mechanics against source and runtime evidence.'
      : 'This plan is not user-confirmed. Treat it only as navigation and do not elevate it above the requirement.',
  };
}

export function queryRefs(ideaDir, refs, limit = DEFAULT_LIMIT) {
  const candidates = [
    'requirement-clarification.json',
    'to-be/tasks.json',
    'to-be/design-notes.json',
    'to-be/traceability-matrix.json',
    'to-be/impact-risk-report.json',
    'to-be/api-change-plan.json',
    'to-be/data-change-plan.json',
  ];
  const results = [];
  for (const path of candidates) {
    const absolute = safePath(ideaDir, path);
    if (!existsSync(absolute)) continue;
    const content = readFileSync(absolute, 'utf8');
    const value = JSON.parse(content);
    for (const match of collectJsonMatches(value, refs)) {
      results.push({ path, sha256: sha256(content), ...match });
      if (results.length >= limit) return results;
    }
  }
  return results;
}

export function querySource(projectRoot, pattern, limit = DEFAULT_LIMIT, excludedDirectory = null) {
  if (!pattern) throw new Error('--query is required');
  const excluded = excludedDirectory ? relative(projectRoot, resolve(excludedDirectory)).replaceAll('\\', '/') : null;
  const excludedGlob = excluded && excluded !== '..' && !excluded.startsWith('../') ? `!${excluded.replace(/\/$/, '')}/**` : null;
  const args = ['-n', '--no-heading', '--color', 'never', '--max-count', '5', '--glob', '!.chisel/**'];
  if (excludedGlob) args.push('--glob', excludedGlob);
  args.push(pattern, '.');
  try {
    const output = execFileSync('rg', args, {
      cwd: projectRoot, encoding: 'utf8', maxBuffer: 2 * 1024 * 1024,
    });
    return output.split('\n').filter(Boolean).slice(0, limit);
  } catch (error) {
    if (error.status === 1) return [];
    throw error;
  }
}

export function readSlice(root, path, lines = '', offset = 0, maxCharacters = DEFAULT_MAX_CHARS) {
  const absolute = safePath(root, path);
  if (!existsSync(absolute)) throw new Error(`file not found: ${path}`);
  const content = readFileSync(absolute, 'utf8');
  let selected = content;
  if (lines) {
    const [rawStart, rawEnd] = lines.split(':');
    const start = Math.max(1, Number(rawStart || 1));
    const end = Math.max(start, Number(rawEnd || start));
    selected = content.split('\n').slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join('\n');
  }
  const result = bounded(selected.slice(offset), maxCharacters);
  return {
    path,
    sha256: sha256(content),
    offset,
    ...result,
    ...(result.truncated ? { continuation: offset + maxCharacters } : {}),
  };
}

function main(argv) {
  const [ideaArg, command, subject, ...args] = argv;
  if (!ideaArg || !command) fail('用法: context-query.mjs <idea-dir> <task|decision|refs|source|read> ...');
  const ideaDir = resolve(ideaArg);
  const projectRoot = resolve(option(args, '--project-root', '.'));
  const allArgs = subject === undefined ? args : [subject, ...args];
  const maxCharacters = Number(option(allArgs, '--max-chars', DEFAULT_MAX_CHARS));
  const limit = Number(option(allArgs, '--limit', DEFAULT_LIMIT));
  if (!Number.isInteger(maxCharacters) || maxCharacters < 256) fail('--max-chars must be an integer >= 256');
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) fail('--limit must be an integer between 1 and 100');
  try {
    let result;
    if (command === 'task') {
      if (!subject) throw new Error('task id is required');
      result = queryTask(ideaDir, subject, String(option(args, '--fields', '')).split(',').filter(Boolean));
    } else if (command === 'decision') {
      if (!subject) throw new Error('task id is required');
      result = queryDecision(ideaDir, subject);
    } else if (command === 'refs') {
      const refs = String(subject || '').split(',').filter(Boolean);
      if (refs.length === 0) throw new Error('at least one ref is required');
      result = { refs, matches: queryRefs(ideaDir, refs, limit) };
    } else if (command === 'source') {
      const pattern = option(allArgs, '--query', subject && !subject.startsWith('--') ? subject : undefined);
      result = { query: pattern, matches: querySource(projectRoot, pattern, limit, ideaDir) };
    } else if (command === 'read') {
      if (!subject) throw new Error('path is required');
      const scope = option(args, '--scope', 'project');
      result = readSlice(scope === 'idea' ? ideaDir : projectRoot, subject, option(args, '--lines', ''), Number(option(args, '--offset', 0)), maxCharacters);
    } else throw new Error(`unknown command: ${command}`);
    const serialized = JSON.stringify(result, null, 2);
    console.log(serialized.length <= maxCharacters
      ? serialized
      : JSON.stringify({ ...bounded(serialized, maxCharacters), result_type: command }, null, 2));
  } catch (error) {
    fail(error.message);
  }
}

if (fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
