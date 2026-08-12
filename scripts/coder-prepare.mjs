#!/usr/bin/env node
import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative, resolve } from 'node:path';
import { readFrontmatter, readTaskState, taskStateFile } from './workflow-lib.mjs';

const DEFAULT_SOFT_CONTEXT_BUDGET = 120_000;
const SOURCE_EXTENSIONS = ['', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.go', '.java', '.kt', '.rb', '.php'];

function fail(msg) {
  process.stderr.write(`${JSON.stringify({ error: msg })}\n`);
  process.exit(1);
}

function safeRead(path) {
  try { return existsSync(path) ? readFileSync(path, 'utf8') : null; } catch { return null; }
}

function safeJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function unique(values) {
  return [...new Set(values.map(value => String(value || '').trim()).filter(Boolean))];
}

function sectionText(content, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return String(content || '').match(new RegExp(`^#{2,6}\\s+${escaped}[^\\n]*\\n([\\s\\S]*?)(?=^#{2,6}\\s+|(?![\\s\\S]))`, 'm'))?.[1]?.trim() || '';
}

function listItems(content, heading) {
  return sectionText(content, heading).split('\n')
    .map(line => line.replace(/^\s*[-*]\s*(?:\[[ xX]\]\s*)?/, '').trim())
    .filter(line => line && line !== '无');
}

function listRepositoryFiles(projectRoot, excludedDirectory = null) {
  try {
    const excluded = excludedDirectory ? relative(projectRoot, resolve(excludedDirectory)).replaceAll('\\', '/') : null;
    const excludedPrefix = excluded && excluded !== '..' && !excluded.startsWith('../') ? `${excluded.replace(/\/$/, '')}/` : null;
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: projectRoot, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024,
    }).split('\n').filter(file => file && !file.startsWith('.chisel/') && (!excludedPrefix || !file.startsWith(excludedPrefix)));
  } catch { return []; }
}

function concreteFiles(values, projectRoot) {
  return unique(values).filter(file => !file.includes('*') && existsSync(join(projectRoot, file)));
}

function matchesHint(file, hint) {
  if (file === hint) return true;
  if (hint.endsWith('/')) return file.startsWith(hint);
  if (hint.endsWith('/**')) return file.startsWith(hint.slice(0, -2));
  if (hint.endsWith('/*')) return file.startsWith(hint.slice(0, -1)) && !file.slice(hint.length - 1).includes('/');
  return false;
}

function resolveRelativeDependency(projectRoot, sourceFile, specifier) {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(projectRoot, dirname(sourceFile), specifier);
  const candidates = SOURCE_EXTENSIONS.flatMap(extension => [
    `${base}${extension}`,
    join(base, `index${extension}`),
  ]);
  const match = candidates.find(candidate => {
    try { return existsSync(candidate) && statSync(candidate).isFile(); } catch { return false; }
  });
  return match ? relative(projectRoot, match).replaceAll('\\', '/') : null;
}

function importDependencies(projectRoot, sourceFile, content) {
  const specifiers = [];
  const patterns = [
    /(?:import|export)\s+(?:[^'";]+?\s+from\s+)?['"]([^'"]+)['"]/g,
    /require\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*from\s+([.\w/]+)\s+import\s+/gm,
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) specifiers.push(match[1]);
  }
  return unique(specifiers.map(specifier => resolveRelativeDependency(projectRoot, sourceFile, specifier)).filter(Boolean));
}

function looksLikeTestFor(file, startingPoints) {
  const lower = file.toLowerCase();
  if (!/(?:^|\/)(?:test|tests|spec|specs)(?:\/|$)|\.(?:test|spec)\.[^.]+$/.test(lower)) return false;
  return startingPoints.some(start => {
    const stem = start.split('/').pop()?.replace(/\.[^.]+$/, '').toLowerCase();
    return stem && lower.includes(stem);
  });
}

function discoverRelatedFiles(projectRoot, startingPoints, taskContent, startingHints = startingPoints, excludedDirectory = null) {
  const repositoryFiles = listRepositoryFiles(projectRoot, excludedDirectory);
  const contents = Object.fromEntries(startingPoints.map(file => [file, safeRead(join(projectRoot, file)) || '']));
  const hintMatches = repositoryFiles.filter(file => startingHints.some(hint => matchesHint(file, hint)) && !startingPoints.includes(file));
  const dependencies = unique([...startingPoints.flatMap(file => importDependencies(projectRoot, file, contents[file])), ...hintMatches]);
  const tests = repositoryFiles.filter(file => looksLikeTestFor(file, startingPoints));
  const symbols = unique([
    ...(readFrontmatter(taskContent).allowed_symbols || []),
    ...startingPoints.map(file => file.split('/').pop()?.replace(/\.[^.]+$/, '')),
  ]).filter(symbol => symbol && symbol.length >= 3);
  const callers = [];
  for (const file of repositoryFiles) {
    if (startingPoints.includes(file) || dependencies.includes(file) || tests.includes(file)) continue;
    const path = join(projectRoot, file);
    let text;
    try {
      if (!existsSync(path)) continue;
      text = readFileSync(path, 'utf8');
      if (text.length > 300_000) continue;
    } catch { continue; }
    if (symbols.some(symbol => text.includes(symbol))) callers.push(file);
  }
  return { hint_matches: hintMatches, dependencies, tests: unique(tests), callers: unique(callers) };
}

function packageSourceContext(projectRoot, startingPoints, related, softBudget = DEFAULT_SOFT_CONTEXT_BUDGET) {
  const priority = unique([...startingPoints, ...related.dependencies, ...related.tests, ...related.callers]);
  const startingSet = new Set(startingPoints);
  const included = {};
  const omitted = [];
  let characters = 0;
  for (const file of priority) {
    const content = safeRead(join(projectRoot, file));
    if (content === null) continue;
    // Starting points are always complete. The budget is deliberately soft:
    // it reduces pre-packaging, never the coder's permission to read files.
    if (!startingSet.has(file) && characters + content.length > softBudget) {
      omitted.push(file);
      continue;
    }
    included[file] = content;
    characters += content.length;
  }
  return {
    files: included,
    inventory: {
      soft_budget_characters: softBudget,
      packaged_characters: characters,
      budget_exceeded_by_starting_points: characters > softBudget,
      included_files: Object.keys(included),
      omitted_related_files: omitted,
      note: 'Omitted files remain readable. The soft budget is not an exploration boundary.',
    },
  };
}

function readReworkItems(ideaDir, taskId) {
  const crDir = join(ideaDir, 'cr');
  if (!existsSync(crDir)) return null;
  const items = [];
  try {
    const files = readdirSync(crDir).filter(file => file.startsWith('dim-') && file.endsWith('-cr.md'));
    for (const file of files) {
      const content = readFileSync(join(crDir, file), 'utf8');
      const fm = readFrontmatter(content);
      if (fm.result !== 'fail') continue;
      if (fm.affected_tasks && !fm.affected_tasks.includes(taskId)) continue;
      const section = content.match(/## Rework Items[\s\S]*?(?=\n## |$)/)?.[0];
      if (section) items.push({ dimension: fm.dimension || file, section });
    }
  } catch { /* optional rework context */ }
  return items.length > 0 ? items : null;
}

export function buildDecisionContext(ideaDir, task, taskFrontmatter = {}) {
  const notes = safeJson(join(ideaDir, 'to-be', 'design-notes.json')) || {};
  const confirmation = safeJson(join(ideaDir, 'confirmations', 'to-be.json'));
  const cpRefs = unique([...(taskFrontmatter.change_point_refs || []), ...(task.change_point_refs || [])]);
  const allChangePoints = Array.isArray(notes.change_point_details) ? notes.change_point_details : [];
  const relevantChangePoints = cpRefs.length > 0
    ? allChangePoints.filter(point => cpRefs.includes(point.cp_id || point.id))
    : allChangePoints;
  const confirmed = (confirmation?.status === 'confirmed' && confirmation?.confirmed_by === 'user')
    || existsSync(join(ideaDir, '.to-be-confirmed'));
  return {
    user_confirmed: confirmed,
    confirmed_at: confirmed ? confirmation.confirmed_at : null,
    task_change_point_refs: cpRefs,
    goal_behavior: notes.goal_behavior || null,
    non_goal_behavior: notes.non_goal_behavior || null,
    strategy_overview: notes.strategy_overview || notes.tl_dr || null,
    relevant_change_points: relevantChangePoints,
    historical_behaviors: Array.isArray(notes.historical_behaviors) ? notes.historical_behaviors : [],
    verification_surface: Array.isArray(notes.verification_surface) ? notes.verification_surface : [],
    confirmed_scope_guidance: {
      starting_scope: Array.isArray(notes.allowed_scope) ? notes.allowed_scope : [],
      forbidden_scope: Array.isArray(notes.forbidden_scope) ? notes.forbidden_scope : [],
    },
    api_contract: safeJson(join(ideaDir, 'to-be', 'api-change-plan.json')),
    data_contract: safeJson(join(ideaDir, 'to-be', 'data-change-plan.json')),
    interpretation: [
      'Confirmed goals, non-goals, contracts, invariants, and design tradeoffs express user intent and must be honored.',
      'Implementation approaches, current-behavior claims, file lists, and impact predictions are hypotheses; verify them against source and runtime evidence.',
      'starting_scope and task starting_points are navigation, not modification boundaries. Confirmed forbidden_scope and explicit_forbidden_paths remain constraints.',
    ],
  };
}

function main() {
  const ideaDir = process.argv[2];
  const taskId = process.argv[3];
  const projectRoot = resolve(process.argv[4] || '.');
  if (!ideaDir || !taskId) fail('用法: coder-prepare.mjs <idea-dir> <task-id> [project-root]');

  const state = readTaskState(taskStateFile(ideaDir));
  const task = state.tasks[taskId];
  if (!task) fail(`task ${taskId} not found in state`);
  const taskContent = safeRead(join(ideaDir, task.file));
  if (!taskContent) fail(`task file not found: ${join(ideaDir, task.file)}`);

  const fm = readFrontmatter(taskContent);
  const filePlan = sectionText(taskContent, 'File-Level Plan');
  const filePlanPaths = [...filePlan.matchAll(/^\|\s*([^|]+?)\s*\|/gm)]
    .map(match => match[1].trim())
    .filter(file => file && file !== 'File' && !/^-+$/.test(file));
  const startingHints = unique([
    ...(fm.starting_points || []),
    ...(fm.expected_files || []),
    ...(task.expected_files || []),
    ...filePlanPaths,
  ]);
  const startingFiles = concreteFiles(startingHints, projectRoot);
  const related = discoverRelatedFiles(projectRoot, startingFiles, taskContent, startingHints, ideaDir);
  const source = packageSourceContext(projectRoot, startingFiles, related);
  const decisionContext = buildDecisionContext(ideaDir, task, fm);

  const context = {
    schema_version: 3,
    generated_at: new Date().toISOString(),
    task_id: taskId,
    goal: sectionText(taskContent, '目标行为') || task.description || '',
    acceptance_criteria: listItems(taskContent, 'Acceptance Criteria'),
    starting_points: startingHints,
    explicit_forbidden_paths: unique([...(fm.forbidden_files || []), ...listItems(taskContent, 'Forbidden Files / Areas')]),
    original_requirement: safeRead(join(ideaDir, 'requirement.md')) || '',
    decision_context: decisionContext,
    source_context: source.files,
    discovery: { ...related, ...source.inventory },
    advisory_context: {
      constraints: safeRead(join(ideaDir, 'as-is', 'ai-input', 'constraints.md')),
      change_surface: safeRead(join(ideaDir, 'as-is', 'ai-input', 'change-surface.md')),
      note: 'Advisory only; verify every claim against source code and runtime behavior.',
    },
    rework_items: readReworkItems(ideaDir, taskId),
    coder_contract: [
      'The task brief and starting_points are navigation hints, not fact or scope boundaries.',
      'Honor user-confirmed goals, non-goals, contracts, invariants, and design tradeoffs in decision_context.',
      'Treat plan claims about existing code, exact files, and implementation mechanics as hypotheses to verify firsthand.',
      'Independently grep callers, read neighboring tests, and trace dependencies before editing.',
      'Modify files outside starting_points when required; record the reason in the final summary.',
      'Only explicit_forbidden_paths are hard file boundaries.',
      'Deliver code, tests, and a summary of at most five lines; do not write process-proof reports.',
    ],
  };

  const outDir = join(ideaDir, 'coder-context');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${taskId}.json`);
  writeFileSync(outPath, `${JSON.stringify(context, null, 2)}\n`);
  console.log(JSON.stringify({
    status: 'ok', path: outPath, starting_points: startingHints.length, concrete_starting_files: startingFiles.length,
    packaged_files: Object.keys(source.files).length, omitted_related_files: source.inventory.omitted_related_files.length,
    packaged_characters: source.inventory.packaged_characters, has_rework: Boolean(context.rework_items),
  }));
}

export {
  discoverRelatedFiles,
  importDependencies,
  packageSourceContext,
};

if (import.meta.url === `file://${process.argv[1]}`) main();
