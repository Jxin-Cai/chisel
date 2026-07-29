#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readTaskState, taskStateFile } from './workflow-lib.mjs';

export function capturePatterns(ideaDir) {
  const patterns = [];

  // 1. File modification pattern — what files are commonly changed together
  const reportsDir = join(ideaDir, 'task-reports');
  if (existsSync(reportsDir)) {
    const fileGroups = new Map();
    for (const f of readdirSync(reportsDir).filter(f => f.endsWith('-report.md'))) {
      const content = readFileSync(join(reportsDir, f), 'utf8');
      const filesMatch = content.match(/^changed_files:\s*\[([^\]]+)\]/m);
      if (filesMatch) {
        const files = filesMatch[1].split(',').map(s => s.trim().replace(/['"]/g, ''));
        const dirs = [...new Set(files.map(f => f.split('/').slice(0, -1).join('/')))].filter(Boolean);
        if (dirs.length > 1) {
          const key = dirs.sort().join(' + ');
          fileGroups.set(key, (fileGroups.get(key) || 0) + 1);
        }
      }
    }
    for (const [group, count] of fileGroups.entries()) {
      if (count >= 2) {
        patterns.push({
          name: `multi-dir-change-${group.replace(/[\/\s+]/g, '-').substring(0, 40)}`,
          trigger: 'changes spanning these directories typically co-occur',
          recipe: `When modifying ${group}, check all directories are updated consistently`,
          confidence: Math.min(90, 50 + count * 15),
        });
      }
    }
  }

  // 2. CR finding patterns — what keeps getting caught
  const crDir = join(ideaDir, 'cr');
  if (existsSync(crDir)) {
    const findingTypes = new Map();
    for (const f of readdirSync(crDir).filter(f => f.endsWith('-cr.md'))) {
      const content = readFileSync(join(crDir, f), 'utf8');
      const reworkSection = content.split('## Rework Items')[1]?.split('##')[0] || '';
      const items = reworkSection.match(/^\|\s*\d/gm);
      if (items) {
        const dim = f.match(/dim-(\w+)-cr/)?.[1] || 'unknown';
        findingTypes.set(dim, (findingTypes.get(dim) || 0) + items.length);
      }
    }
    for (const [dim, count] of findingTypes.entries()) {
      if (count >= 2) {
        patterns.push({
          name: `frequent-${dim}-findings`,
          trigger: `dimension ${dim} frequently catches issues`,
          recipe: `Pay extra attention to ${dim} concerns during implementation`,
          confidence: Math.min(85, 40 + count * 10),
        });
      }
    }
  }

  // 3. Task granularity pattern
  const state = existsSync(taskStateFile(ideaDir)) ? readTaskState(taskStateFile(ideaDir)) : null;
  if (state) {
    const taskCount = Object.keys(state.tasks).length;
    const reworkedCount = Object.values(state.tasks).filter(t => (t.rework_count || 0) > 0).length;
    if (taskCount > 0) {
      patterns.push({
        name: 'task-granularity-insight',
        trigger: 'task planning',
        recipe: `This idea used ${taskCount} tasks with ${reworkedCount} requiring rework (${Math.round(reworkedCount / taskCount * 100)}% rework rate)`,
        confidence: 70,
      });
    }
  }

  return { patterns, idea_dir: ideaDir, captured_at: new Date().toISOString() };
}

function main() {
  const args = process.argv.slice(2);
  const ideaDir = args.find(a => !a.startsWith('--'));

  if (!ideaDir || args.includes('--help')) {
    console.log('用法: node pattern-capture.mjs <idea-dir>');
    process.exit(0);
  }

  if (!existsSync(ideaDir)) {
    process.stderr.write(`idea-dir not found: ${ideaDir}\n`);
    process.exit(1);
  }

  const result = capturePatterns(ideaDir);
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
