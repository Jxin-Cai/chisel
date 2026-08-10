import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkGate } from '../scripts/gate-check.mjs';
import { generateGreenfieldAsIs } from '../scripts/greenfield-as-is.mjs';
import { generateRepoMap } from '../scripts/repo-map.mjs';

const dirs = [];
function temp() { const dir = mkdtempSync(join(tmpdir(), 'chisel-greenfield-')); dirs.push(dir); return dir; }
afterEach(() => { while (dirs.length) rmSync(dirs.pop(), { recursive: true, force: true }); });

function seedGreenfield() {
  const projectRoot = temp();
  const ideaDir = join(projectRoot, '.chisel', 'new-app');
  mkdirSync(ideaDir, { recursive: true });
  writeFileSync(join(projectRoot, 'README.md'), '# New app\n');
  writeFileSync(join(ideaDir, 'requirement.md'), '# New app\n\n## 需求目标\n\nBuild a new internal tool.\n');
  writeFileSync(join(ideaDir, 'requirement-classification.json'), JSON.stringify({
    schema_version: 1,
    source_step: 'classify:requirement',
    routing_complexity: 'standard',
  }));
  mkdirSync(join(ideaDir, 'as-is'), { recursive: true });
  const repoMap = generateRepoMap(projectRoot, { requirement: join(ideaDir, 'requirement.md') });
  writeFileSync(join(ideaDir, 'as-is/repo-map.json'), `${JSON.stringify(repoMap, null, 2)}\n`);
  return { ideaDir, repoMap };
}

describe('greenfield as-is fast path', () => {
  it('classifies a repository without historical source as greenfield', () => {
    const { repoMap } = seedGreenfield();
    assert.equal(repoMap.stats.source_files, 0);
    assert.equal(repoMap.project_mode, 'greenfield');
  });

  it('generates a truthful N/A baseline that passes the normal as-is gate', () => {
    const { ideaDir } = seedGreenfield();
    const result = generateGreenfieldAsIs(ideaDir);
    const gate = checkGate(ideaDir, 'as-is-complete');
    const coverage = JSON.parse(readFileSync(join(ideaDir, 'as-is/coverage-matrix.json'), 'utf8'));
    const score = JSON.parse(readFileSync(join(ideaDir, 'as-is/quality-score.json'), 'utf8'));
    const budget = readFileSync(join(ideaDir, 'as-is/context-budget.md'), 'utf8');

    assert.equal(result.fast_path, true);
    assert.equal(gate.pass, true, gate.reason);
    assert.deepEqual(coverage.entrypoints, []);
    assert.match(coverage.not_applicable.entrypoints, /greenfield/);
    assert.equal(score.dimensions.coverage.detail.applicable, false);
    assert.equal(score.dimensions.coverage.detail.covered_dimensions, 0);
    assert.equal(score.dimensions.coverage.detail.not_applicable_dimensions, 4);
    assert.equal(score.dimensions.coverage.detail.line_coverage_rate, null);
    assert.equal(score.dimensions.evidence_density.detail.applicable, false);
    assert.doesNotMatch(budget, /100%/);
    assert.match(budget, /行覆盖率：不适用/);
  });

  it('can be rerun safely after an interrupted or resumed workflow', () => {
    const { ideaDir } = seedGreenfield();
    generateGreenfieldAsIs(ideaDir);
    const rerun = generateGreenfieldAsIs(ideaDir);
    const gate = checkGate(ideaDir, 'as-is-complete');
    assert.equal(rerun.document_receipt, true);
    assert.equal(gate.pass, true, gate.reason);
  });

  it('refuses to run against a repository that contains source code', () => {
    const { ideaDir } = seedGreenfield();
    writeFileSync(join(ideaDir, 'as-is/repo-map.json'), JSON.stringify({
      schema_version: 4,
      generated_at: new Date().toISOString(),
      project_mode: 'existing',
      stats: { total_files: 1, source_files: 1 },
      languages: [{ language: 'JavaScript', extensions: ['.js'], file_count: 1, percentage: 100 }],
      directory_summary: [],
      entry_candidates: [],
    }));
    assert.throws(() => generateGreenfieldAsIs(ideaDir), /requires zero historical source files/);
  });
});
