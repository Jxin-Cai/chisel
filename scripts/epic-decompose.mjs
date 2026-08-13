#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function loadEpicState(epicDir) {
  const statePath = join(epicDir, 'epic-state.json');
  if (!existsSync(statePath)) return null;
  try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return null; }
}

export function updateIdeaStatus(epicDir, ideaId, status) {
  const state = loadEpicState(epicDir);
  if (!state) return { error: 'epic-state.json not found' };
  const idea = state.ideas.find(i => i.id === ideaId);
  if (!idea) return { error: `idea ${ideaId} not found` };
  idea.status = status;
  if (status === 'done') idea.completed_at = new Date().toISOString();
  writeFileSync(join(epicDir, 'epic-state.json'), JSON.stringify(state, null, 2));
  return { updated: true, idea: ideaId, status };
}

export function getNextIdeas(epicDir) {
  const state = loadEpicState(epicDir);
  if (!state) return [];
  return state.ideas.filter(idea => {
    if (idea.status !== 'pending') return false;
    return idea.depends_on.every(dep => {
      const depIdea = state.ideas.find(i => i.id === dep);
      return depIdea && depIdea.status === 'done';
    });
  });
}

function main() {
  const args = process.argv.slice(2);
  const epicDir = args.find(a => !a.startsWith('--'));

  if (!epicDir || args.includes('--help')) {
    console.log('用法: node epic-decompose.mjs <epic-dir> [--status|--next|--update <idea-id> <status>]');
    process.exit(0);
  }

  if (args.includes('--status')) {
    const state = loadEpicState(epicDir);
    console.log(JSON.stringify(state || { error: 'not initialized' }, null, 2));
  } else if (args.includes('--next')) {
    console.log(JSON.stringify(getNextIdeas(epicDir), null, 2));
  } else if (args.includes('--update')) {
    const idx = args.indexOf('--update');
    const ideaId = args[idx + 1];
    const status = args[idx + 2];
    if (!ideaId || !status) { process.stderr.write('--update requires <idea-id> <status>\n'); process.exit(1); }
    console.log(JSON.stringify(updateIdeaStatus(epicDir, ideaId, status), null, 2));
  } else {
    const state = loadEpicState(epicDir);
    console.log(JSON.stringify(state || { error: 'not initialized' }, null, 2));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
