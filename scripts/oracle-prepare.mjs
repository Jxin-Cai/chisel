#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, extname, join, resolve } from 'node:path';
import { generateRepoMap } from './repo-map.mjs';

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.py', '.go', '.rb', '.php', '.java', '.kt']);
const ENTRY_NAMES = /^(?:src\/|lib\/)?(?:index|main|cli|server|app|routes?|router)(?:\.[^/]+)?$|(?:^|\/)__init__\.py$/i;
const SOFT_BUDGET = 80_000;

function fail(message) {
  process.stderr.write(`${JSON.stringify({ error: message })}\n`);
  process.exit(1);
}

function readJson(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}

function listFiles(projectRoot) {
  try {
    return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
      cwd: projectRoot, encoding: 'utf8', maxBuffer: 20 * 1024 * 1024,
    }).split('\n').filter(Boolean);
  } catch { return []; }
}

function flattenStrings(value) {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(flattenStrings);
  if (value && typeof value === 'object') return Object.values(value).flatMap(flattenStrings);
  return [];
}

function packageEntries(projectRoot, files) {
  const entries = [];
  let characters = 0;
  for (const file of [...new Set(files)]) {
    const absolute = join(projectRoot, file);
    if (!existsSync(absolute) || !SOURCE_EXTENSIONS.has(extname(file).toLowerCase())) continue;
    let content;
    try { content = readFileSync(absolute, 'utf8'); } catch { continue; }
    if (entries.length > 0 && characters + content.length > SOFT_BUDGET) continue;
    entries.push({ path: file, content });
    characters += content.length;
  }
  return entries;
}

export function discoverPublicEntries(projectRoot, requirementPath) {
  const files = listFiles(projectRoot);
  const explicit = [];
  const packageJson = readJson(join(projectRoot, 'package.json'));
  if (packageJson) {
    explicit.push(...flattenStrings(packageJson.bin), ...flattenStrings(packageJson.exports), packageJson.main, packageJson.module);
  }
  const normalizedExplicit = explicit.filter(Boolean).map(file => String(file).replace(/^\.\//, ''));
  const common = files.filter(file => ENTRY_NAMES.test(file));
  let mapped = [];
  try {
    const repoMap = generateRepoMap(projectRoot, { requirement: requirementPath });
    mapped = [
      ...repoMap.entry_candidates.map(candidate => candidate.file),
      ...repoMap.frontend.routes.map(route => route.component_file),
    ];
  } catch { /* public discovery is best effort */ }
  return packageEntries(projectRoot, [...normalizedExplicit, ...common, ...mapped]);
}

export function prepareOracle(ideaDir, projectRoot) {
  const oracleDir = join(ideaDir, 'oracle');
  const contextPath = join(oracleDir, 'context.json');
  const manifestPath = join(oracleDir, 'manifest.json');
  mkdirSync(oracleDir, { recursive: true });
  if (existsSync(manifestPath) && existsSync(contextPath)) {
    return { status: 'frozen', oracle_dir: oracleDir, context_path: contextPath, manifest_path: manifestPath };
  }
  const requirementPath = join(ideaDir, 'requirement.md');
  if (!existsSync(requirementPath)) fail(`requirement not found: ${requirementPath}`);
  const context = {
    schema_version: 2,
    canonical_requirement: readFileSync(requirementPath, 'utf8'),
    requirement: readFileSync(requirementPath, 'utf8'),
    project: {
      root: projectRoot,
      name: basename(projectRoot),
      public_entries: discoverPublicEntries(projectRoot, requirementPath),
    },
    allowed_runners: ['node-test', 'pytest', 'jest'],
    output_contract: {
      directory: oracleDir,
      manifest: 'manifest.json',
      assertion_count: { minimum: 3, maximum: 8 },
    },
  };
  writeFileSync(contextPath, `${JSON.stringify(context, null, 2)}\n`);
  return { status: 'prepared', oracle_dir: oracleDir, context_path: contextPath, manifest_path: manifestPath };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ideaDir = process.argv[2] && resolve(process.argv[2]);
  const projectRoot = resolve(process.argv[3] || '.');
  if (!ideaDir) fail('用法: oracle-prepare.mjs <idea-dir> [project-root]');
  console.log(JSON.stringify(prepareOracle(ideaDir, projectRoot)));
}
