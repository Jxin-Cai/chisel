#!/usr/bin/env node
import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { readFrontmatter, readTaskState, taskStateFile } from './workflow-lib.mjs';

function fail(msg) {
  process.stderr.write(`${JSON.stringify({ error: msg })}\n`);
  process.exit(1);
}

function safeRead(path) {
  try { return existsSync(path) ? readFileSync(path, 'utf8') : null; } catch { return null; }
}


function extractRelevantSection(content, keywords) {
  if (!content) return null;
  const lines = content.split('\n');
  const relevant = [];
  let capturing = false;
  let blankCount = 0;

  for (const line of lines) {
    const isHeader = /^#{1,3}\s/.test(line);
    if (isHeader) {
      const matches = keywords.some(kw => line.toLowerCase().includes(kw.toLowerCase()));
      capturing = matches;
      blankCount = 0;
      if (capturing) relevant.push(line);
    } else if (capturing) {
      if (line.trim() === '') {
        blankCount++;
        if (blankCount > 2) { capturing = false; continue; }
      } else {
        blankCount = 0;
      }
      relevant.push(line);
    }
  }
  return relevant.length > 0 ? relevant.join('\n') : null;
}

function readStyleSamples(expectedFiles, projectRoot, maxLines = 50) {
  const samples = {};
  for (const file of expectedFiles.slice(0, 5)) {
    const fullPath = join(projectRoot, file);
    if (!existsSync(fullPath)) continue;
    try {
      const content = readFileSync(fullPath, 'utf8');
      const lines = content.split('\n').slice(0, maxLines);
      samples[file] = lines.join('\n');
    } catch { /* skip unreadable files */ }
  }
  return Object.keys(samples).length > 0 ? samples : null;
}

function readInvariants(ideaDir, expectedFiles) {
  const invariantsPath = join(ideaDir, 'invariants.jsonl');
  if (!existsSync(invariantsPath)) return null;
  try {
    const lines = readFileSync(invariantsPath, 'utf8').split('\n').filter(Boolean);
    const all = lines.map(l => JSON.parse(l));
    if (expectedFiles.length === 0) return all.length > 0 ? all : null;
    const relevant = all.filter(inv =>
      !inv.related_files || inv.related_files.some(f => expectedFiles.includes(f))
    );
    return relevant.length > 0 ? relevant : (all.length > 0 ? all : null);
  } catch { return null; }
}

function readReworkItems(ideaDir, taskId) {
  const crDir = join(ideaDir, 'cr');
  if (!existsSync(crDir)) return null;
  const items = [];
  try {
    const files = readdirSync(crDir).filter(f => f.startsWith('dim-') && f.endsWith('-cr.md'));
    for (const file of files) {
      const content = readFileSync(join(crDir, file), 'utf8');
      const fm = readFrontmatter(content);
      if (fm.result !== 'fail') continue;
      if (fm.affected_tasks && !fm.affected_tasks.includes(taskId)) continue;
      const reworkMatch = content.match(/## Rework Items[\s\S]*?(?=\n## |$)/);
      if (reworkMatch) items.push({ dimension: fm.dimension || file, section: reworkMatch[0] });
    }
  } catch { /* non-critical */ }
  return items.length > 0 ? items : null;
}

function extractImplementationPlanExcerpt(ideaDir, taskId) {
  const planPath = join(ideaDir, 'to-be', 'implementation-plan.md');
  if (!existsSync(planPath)) return null;
  try {
    const content = readFileSync(planPath, 'utf8');
    const taskPattern = new RegExp(`(#{1,4}\\s*.*${taskId.replace(/-/g, '[\\s-]')}[\\s\\S]*?)(?=\\n#{1,4}\\s*(?:task|Task)|$)`, 'i');
    const match = content.match(taskPattern);
    return match ? match[1].trim() : null;
  } catch { return null; }
}

function main() {
  const ideaDir = process.argv[2];
  const taskId = process.argv[3];
  const projectRoot = process.argv[4] || '.';

  if (!ideaDir || !taskId) fail('用法: coder-prepare.mjs <idea-dir> <task-id> [project-root]');

  const state = readTaskState(taskStateFile(ideaDir));
  const task = state.tasks[taskId];
  if (!task) fail(`task ${taskId} not found in state`);

  const taskFilePath = join(ideaDir, task.file);
  const taskContent = safeRead(taskFilePath);
  if (!taskContent) fail(`task file not found: ${taskFilePath}`);

  const fm = readFrontmatter(taskContent);
  const expectedFiles = fm.expected_files || [];

  const constraintsExcerpt = safeRead(join(ideaDir, 'as-is', 'ai-input', 'constraints.md'));
  const changeSurfaceExcerpt = safeRead(join(ideaDir, 'as-is', 'ai-input', 'change-surface.md'));

  const invariants = readInvariants(ideaDir, expectedFiles);
  const styleSamples = readStyleSamples(expectedFiles, projectRoot);
  const reworkItems = readReworkItems(ideaDir, taskId);
  const implementationPlanExcerpt = extractImplementationPlanExcerpt(ideaDir, taskId);

  const context = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    task_id: taskId,
    task_content: taskContent,
    constraints_excerpt: constraintsExcerpt,
    change_surface_excerpt: changeSurfaceExcerpt,
    invariants,
    style_samples: styleSamples,
    rework_items: reworkItems,
    implementation_plan_excerpt: implementationPlanExcerpt
  };

  const outDir = join(ideaDir, 'coder-context');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `${taskId}.json`);
  writeFileSync(outPath, JSON.stringify(context, null, 2));
  console.log(JSON.stringify({ status: 'ok', path: outPath, has_invariants: !!invariants, has_rework: !!reworkItems }));
}

export { extractRelevantSection, readInvariants, readReworkItems, readStyleSamples };

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
