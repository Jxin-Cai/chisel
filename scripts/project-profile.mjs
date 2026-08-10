import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const PROJECT_MODES = Object.freeze({
  GREENFIELD: 'greenfield',
  EXISTING: 'existing',
  UNKNOWN: 'unknown',
});

export function projectModeFromRepoMap(repoMap) {
  if (!repoMap || typeof repoMap !== 'object') return PROJECT_MODES.UNKNOWN;
  if (repoMap.project_mode === PROJECT_MODES.GREENFIELD || repoMap.project_mode === PROJECT_MODES.EXISTING) {
    return repoMap.project_mode;
  }
  const sourceFiles = repoMap.stats?.source_files;
  if (!Number.isInteger(sourceFiles) || sourceFiles < 0) return PROJECT_MODES.UNKNOWN;
  return sourceFiles === 0 ? PROJECT_MODES.GREENFIELD : PROJECT_MODES.EXISTING;
}

export function readProjectProfile(ideaDir) {
  const file = join(ideaDir, 'as-is/repo-map.json');
  if (!existsSync(file)) return { mode: PROJECT_MODES.UNKNOWN, reason: 'repo-map missing' };
  try {
    const repoMap = JSON.parse(readFileSync(file, 'utf8'));
    const mode = projectModeFromRepoMap(repoMap);
    return {
      mode,
      repo_map: repoMap,
      reason: mode === PROJECT_MODES.GREENFIELD
        ? 'repository contains no historical source files'
        : mode === PROJECT_MODES.EXISTING ? 'repository contains historical source files' : 'repo-map stats are incomplete',
    };
  } catch (error) {
    return { mode: PROJECT_MODES.UNKNOWN, reason: `repo-map malformed: ${error.message}` };
  }
}
