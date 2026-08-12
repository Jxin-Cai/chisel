#!/usr/bin/env node
import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { readFrontmatter, readTaskState, taskStateFile } from './workflow-lib.mjs';
import { requirementConfirmationStatus } from './requirement-context.mjs';
import { discoverRelatedFiles, importDependencies, preloadSourceContext, unique } from './source-discovery.mjs';

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

function boundedText(content, maxCharacters, label) {
  if (!content || content.length <= maxCharacters) return content || '';
  return `${content.slice(0, maxCharacters)}\n\n[${label} truncated; continue through the corresponding hashed ref]`;
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

function concreteFiles(values, projectRoot) {
  return unique(values).filter(file => !file.includes('*') && existsSync(join(projectRoot, file)));
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
  const preloadedSource = preloadSourceContext(projectRoot, startingFiles, related);
  const decisionRefs = buildDecisionRefs(ideaDir, task, fm);
  const clarification = safeJson(join(ideaDir, 'requirement-clarification.json'));
  const requirementConfirmation = clarification?.schema_version === 2 ? requirementConfirmationStatus(ideaDir) : null;
  if (requirementConfirmation && !requirementConfirmation.valid) fail(`canonical requirement is not confirmed: ${requirementConfirmation.reason}`);

  const context = {
    schema_version: 6,
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
    essential_context: {
      canonical_requirement: boundedText(safeRead(join(ideaDir, 'requirement.md')), 48_000, 'canonical requirement'),
      original_request: existsSync(join(ideaDir, 'requirement-original.md'))
        ? boundedText(safeRead(join(ideaDir, 'requirement-original.md')), 32_000, 'original request') : null,
      task: {
        goal: sectionText(taskContent, '目标行为'),
        acceptance_criteria: sectionText(taskContent, 'Acceptance Criteria'),
        behavior_invariants: sectionText(taskContent, 'Behavior Invariants'),
      },
      source_files: preloadedSource.files,
    },
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
      continue_on_truncation: true,
      preloaded_files: preloadedSource.files.map(file => file.path),
      omitted_candidates: preloadedSource.omitted,
      budget_policy: 'soft: continue while new evidence changes the implementation decision',
    },
    coder_contract: [
      'Start from essential_context, then use context-query and repository search for unresolved evidence.',
      'Treat canonical_requirement as the normalized contract and original_request as loss-detection context; do not silently discard a conflict.',
      'Whenever a retrieval result is truncated, follow continuation offsets until the required section is complete.',
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
    preloaded_files: preloadedSource.files.length, preloaded_characters: preloadedSource.characters,
    bootstrap_bytes: Buffer.byteLength(JSON.stringify(context)), has_rework: Boolean(context.rework_refs),
  }));
}

export {
  discoverRelatedFiles,
  importDependencies,
  fileRef,
};

if (import.meta.url === `file://${process.argv[1]}`) main();
