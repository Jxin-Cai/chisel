#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { ensureDir } from './workflow-lib.mjs';

function parseReworkItems(crText) {
  const items = [];
  const lines = crText.split('\n');
  let inReworkTable = false;
  let headerParsed = false;
  let columns = [];

  for (const line of lines) {
    if (/^##\s*Rework Items/.test(line)) {
      inReworkTable = true;
      headerParsed = false;
      continue;
    }
    if (inReworkTable && /^##\s/.test(line)) break;
    if (!inReworkTable) continue;
    if (!/^\|/.test(line)) continue;

    const cells = line.split('|').slice(1, -1).map(c => c.trim());
    if (!headerParsed) {
      if (cells.every(c => /^:?-+:?$/.test(c))) continue;
      columns = cells.map(c => c.toLowerCase().replace(/\s+/g, '_'));
      headerParsed = true;
      continue;
    }
    if (cells.every(c => /^:?-+:?$/.test(c))) continue;
    if (cells.length < 3) continue;

    const row = {};
    columns.forEach((col, i) => { row[col] = cells[i] || ''; });
    if (row.id || row.ID) items.push(row);
  }
  return items;
}

function categorizeFromDimension(dimension) {
  const map = {
    'd2': 'concurrency',
    'd3': 'duplication',
    'd4': 'design-principle',
    'd5': 'style',
    'd6': 'maintainability',
    'd7': 'dead-code',
    'd8': 'impact-surface',
    'spec': 'spec-compliance'
  };
  return map[dimension] || 'general';
}

function main() {
  const ideaDir = process.argv[2];
  const taskId = process.argv[3];
  const dimension = process.argv[4];

  if (!ideaDir || !taskId) {
    process.stderr.write('用法: node extract-invariant.mjs <idea-dir> <task-id> [dimension]\n');
    process.exit(1);
  }

  const crFiles = [];
  if (dimension) {
    crFiles.push(join(ideaDir, `cr/dim-${dimension}-cr.md`));
  } else {
    const crDir = join(ideaDir, 'cr');
    if (existsSync(crDir)) {
      for (const f of readdirSync(crDir)) {
        if (/^dim-.*-cr\.md$/.test(f)) crFiles.push(join(crDir, f));
      }
    }
  }

  const invariantsPath = join(ideaDir, 'invariants.jsonl');
  const existing = new Set();
  if (existsSync(invariantsPath)) {
    for (const line of readFileSync(invariantsPath, 'utf8').split('\n').filter(Boolean)) {
      try {
        const inv = JSON.parse(line);
        if (inv.source_item) existing.add(inv.source_item);
      } catch { /* skip malformed lines */ }
    }
  }

  let extracted = 0;
  let skipped = 0;
  let idCounter = existing.size;

  for (const crFile of crFiles) {
    if (!existsSync(crFile)) continue;
    const text = readFileSync(crFile, 'utf8');
    const items = parseReworkItems(text);
    const dim = crFile.match(/dim-([^-]+)-cr\.md/)?.[1] || 'unknown';

    for (const item of items) {
      const sourceItem = item.id || item.ID || '';
      if (!sourceItem) continue;
      if (existing.has(sourceItem)) { skipped++; continue; }

      idCounter++;
      const invariant = {
        id: `INV-${String(idCounter).padStart(3, '0')}`,
        source_cr: `dim-${dim}-cr.md`,
        source_item: sourceItem,
        task_id: taskId,
        category: categorizeFromDimension(dim),
        condition: item.problem || item.问题 || '',
        fix_direction: item.fix_suggestion || item.修复建议 || item.suggestion || '',
        extracted_at: new Date().toISOString(),
        rework_round: Number(item.rework_count || 1)
      };

      ensureDir(dirname(invariantsPath));
      appendFileSync(invariantsPath, JSON.stringify(invariant) + '\n');
      existing.add(sourceItem);
      extracted++;
    }
  }

  console.log(JSON.stringify({ extracted, skipped, total: existing.size }));
}

main();
