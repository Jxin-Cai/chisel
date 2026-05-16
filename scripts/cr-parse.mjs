#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readFrontmatter } from './workflow-lib.mjs';

const VALID_RESULTS = ['approved', 'needs_rework', 'blocked'];

function parseCrResult(crFilePath) {
  if (!existsSync(crFilePath)) return { error: `file not found: ${crFilePath}` };

  const content = readFileSync(crFilePath, 'utf8');
  const fm = readFrontmatter(content);

  if (fm.result && VALID_RESULTS.includes(fm.result)) {
    return { result: fm.result, source: 'frontmatter' };
  }

  const conclusionMatch = content.match(/^##\s*结论\s*\n+\s*(approved|needs_rework|blocked)/m);
  if (conclusionMatch) {
    return { result: conclusionMatch[1], source: 'conclusion_section' };
  }

  const bodyMatch = content.match(/\b(approved|needs_rework|blocked)\b/i);
  if (bodyMatch) {
    const found = bodyMatch[0].toLowerCase();
    if (VALID_RESULTS.includes(found)) {
      return { result: found, source: 'body_scan', confidence: 'low' };
    }
  }

  return { error: 'could not parse CR result from file' };
}

function main() {
  const ideaDir = process.argv[2];
  const taskId = process.argv[3];

  if (!ideaDir || !taskId) {
    process.stderr.write('用法: cr-parse.mjs <idea-dir> <task-id>\n');
    process.exit(1);
  }

  const crFile = join(ideaDir, `cr/${taskId}-cr.md`);
  const parsed = parseCrResult(crFile);

  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n`);
    console.log(JSON.stringify({ task_id: taskId, error: parsed.error }));
    process.exit(1);
  }

  console.log(JSON.stringify({ task_id: taskId, ...parsed }));
}

export { parseCrResult };

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
