#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readFrontmatter } from './workflow-lib.mjs';

const VALID_RESULTS = ['approved', 'needs_rework', 'blocked'];
const VALID_SPEC_RESULTS = ['pass', 'fail'];
const VALID_DIM_RESULTS = ['pass', 'fail'];
const VALID_DIMENSIONS = ['spec', 'd2', 'd3', 'd4', 'd5', 'd6', 'd7'];

function parseCrResult(crFilePath) {
  if (!existsSync(crFilePath)) return { error: `file not found: ${crFilePath}` };

  const content = readFileSync(crFilePath, 'utf8');
  const fm = readFrontmatter(content);

  if (!fm.result) return { error: 'CR frontmatter missing result' };
  if (!VALID_RESULTS.includes(fm.result)) return { error: 'CR frontmatter result must be approved, needs_rework, or blocked' };
  return { result: fm.result, source: 'frontmatter' };
}

function parseSpecCrResult(crFilePath) {
  if (!existsSync(crFilePath)) return { error: `file not found: ${crFilePath}` };

  const content = readFileSync(crFilePath, 'utf8');
  const fm = readFrontmatter(content);

  if (fm.review_type !== 'spec_compliance') return { error: 'not a spec compliance CR (missing review_type: spec_compliance)' };
  if (!fm.result) return { error: 'Spec CR frontmatter missing result' };
  if (!VALID_SPEC_RESULTS.includes(fm.result)) return { error: 'Spec CR frontmatter result must be pass or fail' };
  return { result: fm.result, source: 'frontmatter' };
}

function parseRequirementCrResult(crFilePath) {
  if (!existsSync(crFilePath)) return { error: `file not found: ${crFilePath}` };

  const content = readFileSync(crFilePath, 'utf8');
  const fm = readFrontmatter(content);

  if (fm.review_level !== 'requirement') return { error: 'not a requirement-level CR (missing review_level: requirement)' };
  if (!fm.result) return { error: 'Requirement CR frontmatter missing result' };
  if (!VALID_RESULTS.includes(fm.result)) return { error: 'Requirement CR frontmatter result must be approved, needs_rework, or blocked' };

  const affected_tasks = Array.isArray(fm.affected_tasks) ? fm.affected_tasks : [];
  const rework_count = Number(fm.rework_count || 0);

  return { result: fm.result, affected_tasks, rework_count, source: 'frontmatter' };
}

function parseDimCrResult(crFilePath, dimension) {
  if (!existsSync(crFilePath)) return { error: `file not found: ${crFilePath}` };

  const content = readFileSync(crFilePath, 'utf8');
  const fm = readFrontmatter(content);

  if (fm.dimension !== dimension) return { error: `not a ${dimension} CR (frontmatter dimension=${fm.dimension})` };
  if (!fm.result) return { error: `Dim CR frontmatter missing result` };
  if (!VALID_DIM_RESULTS.includes(fm.result)) return { error: `Dim CR frontmatter result must be pass or fail` };

  const affected_tasks = Array.isArray(fm.affected_tasks) ? fm.affected_tasks : [];
  const rework_count = Number(fm.rework_count || 0);

  return { result: fm.result, dimension, affected_tasks, rework_count, source: 'frontmatter' };
}

function main() {
  const args = process.argv.slice(2);
  const typeIdx = args.indexOf('--type');
  const dimIdx = args.indexOf('--dim');
  let type = 'cr';
  let dim = null;

  if (dimIdx !== -1) {
    dim = args[dimIdx + 1] || '';
    args.splice(dimIdx, 2);
  }
  if (typeIdx !== -1) {
    type = args[typeIdx + 1] || 'cr';
    args.splice(typeIdx, 2);
  }

  const ideaDir = args[0];
  const taskId = args[1];

  if (dim) {
    if (!ideaDir) {
      process.stderr.write('用法: cr-parse.mjs <idea-dir> --dim <dimension>\n');
      process.exit(1);
    }
    if (!VALID_DIMENSIONS.includes(dim)) {
      process.stderr.write(`无效维度: ${dim}，有效值: ${VALID_DIMENSIONS.join(', ')}\n`);
      process.exit(1);
    }
    const crFile = join(ideaDir, `cr/dim-${dim}-cr.md`);
    const parsed = parseDimCrResult(crFile, dim);
    if (parsed.error) {
      process.stderr.write(`${parsed.error}\n`);
      console.log(JSON.stringify({ dimension: dim, error: parsed.error }));
      process.exit(1);
    }
    console.log(JSON.stringify({ dimension: dim, ...parsed }));
    return;
  }

  if (type === 'requirement') {
    if (!ideaDir) {
      process.stderr.write('用法: cr-parse.mjs <idea-dir> --type requirement\n');
      process.exit(1);
    }
    const crFile = join(ideaDir, 'cr/requirement-cr.md');
    const parsed = parseRequirementCrResult(crFile);
    if (parsed.error) {
      process.stderr.write(`${parsed.error}\n`);
      console.log(JSON.stringify({ type, error: parsed.error }));
      process.exit(1);
    }
    console.log(JSON.stringify({ type, ...parsed }));
    return;
  }

  if (!ideaDir || !taskId) {
    process.stderr.write('用法: cr-parse.mjs <idea-dir> <task-id> [--type spec|cr|requirement]\n');
    process.exit(1);
  }

  const crFile = type === 'spec'
    ? join(ideaDir, `cr/${taskId}-spec-cr.md`)
    : join(ideaDir, `cr/${taskId}-cr.md`);

  const parsed = type === 'spec'
    ? parseSpecCrResult(crFile)
    : parseCrResult(crFile);

  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n`);
    console.log(JSON.stringify({ task_id: taskId, type, error: parsed.error }));
    process.exit(1);
  }

  console.log(JSON.stringify({ task_id: taskId, type, ...parsed }));
}

export { parseCrResult, parseSpecCrResult, parseRequirementCrResult, parseDimCrResult };

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
