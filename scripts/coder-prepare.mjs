#!/usr/bin/env node
import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, relative, resolve } from 'node:path';
import { readFrontmatter, readTaskState, taskStateFile } from './workflow-lib.mjs';
import { requirementConfirmationStatus } from './requirement-context.mjs';

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

function sha256(content) {
  return createHash('sha256').update(content).digest('hex');
}

function fileRef(ideaDir, relativePath, selector = undefined) {
  const content = safeRead(join(ideaDir, relativePath));
  if (content === null) return null;
  return {
    path: relativePath,
    ...(selector ? { selector } : {}),
    sha256: sha256(content),
    bytes: Buffer.byteLength(content),
  };
}

function reworkRefs(ideaDir, taskId) {
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
      if (section) items.push({ dimension: fm.dimension || file, ...fileRef(ideaDir, `cr/${file}`, 'section:Rework Items') });
    }
  } catch { /* optional rework context */ }
  return items.length > 0 ? items : null;
}

export function buildDecisionRefs(ideaDir, task, taskFrontmatter = {}) {
  const confirmation = safeJson(join(ideaDir, 'confirmations', 'to-be.json'));
  const cpRefs = unique([...(taskFrontmatter.change_point_refs || []), ...(task.change_point_refs || [])]);
  const confirmed = (confirmation?.status === 'confirmed' && confirmation?.confirmed_by === 'user')
    || existsSync(join(ideaDir, '.to-be-confirmed'));
  return {
    user_confirmed: confirmed,
    confirmed_at: confirmed ? confirmation.confirmed_at : null,
    task_change_point_refs: cpRefs,
    design_notes_ref: fileRef(ideaDir, 'to-be/design-notes.json', cpRefs.length > 0
      ? `change_point_details[cp_id in ${cpRefs.join(',')}]`
      : 'goal_behavior,non_goal_behavior,strategy_overview'),
    api_contract_ref: fileRef(ideaDir, 'to-be/api-change-plan.json'),
    data_contract_ref: fileRef(ideaDir, 'to-be/data-change-plan.json'),
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
  const decisionRefs = buildDecisionRefs(ideaDir, task, fm);
  const clarification = safeJson(join(ideaDir, 'requirement-clarification.json'));
  const requirementConfirmation = clarification?.schema_version === 2 ? requirementConfirmationStatus(ideaDir) : null;
  if (requirementConfirmation && !requirementConfirmation.valid) fail(`canonical requirement is not confirmed: ${requirementConfirmation.reason}`);

  const context = {
    schema_version: 5,
    generated_at: new Date().toISOString(),
    task_id: taskId,
    task_complexity: fm.task_complexity || 'standard',
    starting_points: startingHints,
    explicit_forbidden_paths: unique([...(fm.forbidden_files || []), ...listItems(taskContent, 'Forbidden Files / Areas')]),
    trace_refs: unique(fm.trace_refs || []),
    change_point_refs: unique(fm.change_point_refs || []),
    task_ref: fileRef(ideaDir, task.file),
    task_source_ref: fileRef(ideaDir, 'to-be/tasks.json', `tasks[task_id=${taskId}]`),
    requirement_ref: fileRef(ideaDir, 'requirement.md'),
    clarification_ref: fileRef(ideaDir, 'requirement-clarification.json'),
    requirement_provenance: requirementConfirmation ? {
      canonical_ref: 'requirement.md',
      original_input_ref: 'requirement-original.md',
      input_ledger_ref: 'requirement-inputs.json',
      confirmation_ref: 'confirmations/requirement.json',
      requirement_sha256: requirementConfirmation.requirement_sha256,
      source_fingerprint: requirementConfirmation.source_fingerprint,
    } : { canonical_ref: 'requirement.md', legacy: true },
    decision_refs: decisionRefs,
    discovery: related,
    advisory_refs: {
      constraints: fileRef(ideaDir, 'as-is/ai-input/constraints.md'),
      change_surface: fileRef(ideaDir, 'as-is/ai-input/change-surface.md'),
    },
    rework_refs: reworkRefs(ideaDir, taskId),
    search_seeds: unique([
      ...(fm.allowed_symbols || []),
      ...startingFiles.map(file => file.split('/').pop()?.replace(/\.[^.]+$/, '')),
      ...(fm.trace_refs || []),
      ...(fm.change_point_refs || []),
    ]),
    retrieval: {
      script: '${CLAUDE_PLUGIN_ROOT}/scripts/context-query.mjs',
      idea_dir: ideaDir,
      suggested_rounds: 6,
      suggested_files_per_round: 8,
      max_characters_per_read: 24000,
      budget_policy: 'soft: continue while new evidence changes the implementation decision',
    },
    coder_contract: [
      'Resolve requirement_ref before interpreting the task; it is the sole requirement baseline.',
      'Use context-query and repository search iteratively; do not load every referenced file up front.',
      'Retrieval round/file counts are pacing guidance, not stop conditions; continue while evidence is still changing the implementation decision.',
      'The task brief and starting_points are navigation hints, not fact or scope boundaries.',
      'Resolve decision_refs selectively and honor confirmed goals, non-goals, contracts, invariants, and design tradeoffs.',
      'Treat plan claims about existing code, exact files, and implementation mechanics as hypotheses to verify firsthand.',
      'Independently grep callers, read neighboring tests, and trace dependencies before editing.',
      'Modify files outside starting_points when required; record the reason in the final summary.',
      'Only explicit_forbidden_paths are hard file boundaries.',
      'Never read idea_dir/oracle before implementation; Oracle assertions are intentionally blinded.',
      'Deliver code, tests, and a summary of at most five lines; do not write process-proof reports.',
    ],
  };

  const outDir = join(ideaDir, 'coder-context');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${taskId}.json`);
  writeFileSync(outPath, `${JSON.stringify(context, null, 2)}\n`);
  console.log(JSON.stringify({
    status: 'ok', path: outPath, starting_points: startingHints.length, concrete_starting_files: startingFiles.length,
    discovered_files: unique([...related.dependencies, ...related.tests, ...related.callers]).length,
    bootstrap_bytes: Buffer.byteLength(JSON.stringify(context)), has_rework: Boolean(context.rework_refs),
  }));
}

export {
  discoverRelatedFiles,
  importDependencies,
  fileRef,
};

if (import.meta.url === `file://${process.argv[1]}`) main();
