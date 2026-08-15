#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { basename, extname, join, resolve } from 'node:path';
import { generateRepoMap } from './repo-map.mjs';
import { resolveExistingIdeaDirectory } from './control-plane.mjs';

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.vue', '.svelte', '.py', '.go', '.rb', '.php', '.java', '.kt', '.rs', '.cs', '.swift', '.dart']);
const ENTRY_NAMES = /^(?:src\/|lib\/|cmd\/[^/]+\/)?(?:index|main|cli|server|app|routes?|router)(?:\.[^/]+)?$|(?:^|\/)__init__\.py$|(?:^|\/)Program\.cs$/i;
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

function configEntryFiles(projectRoot, files) {
  const entries = [];
  const pyproject = files.includes('pyproject.toml') ? readFileSync(join(projectRoot, 'pyproject.toml'), 'utf8') : '';
  for (const match of pyproject.matchAll(/^\s*[\w.-]+\s*=\s*["']([\w.]+):[\w.]+["']/gm)) {
    const modulePath = match[1].replaceAll('.', '/');
    entries.push(...files.filter(file => file === `${modulePath}.py` || file === `${modulePath}/__init__.py`));
  }
  const cargo = files.includes('Cargo.toml') ? readFileSync(join(projectRoot, 'Cargo.toml'), 'utf8') : '';
  for (const match of cargo.matchAll(/^\s*path\s*=\s*["']([^"']+\.rs)["']/gm)) entries.push(match[1]);
  if (/\[\[bin\]\]/.test(cargo) && files.includes('src/main.rs')) entries.push('src/main.rs');
  const composer = readJson(join(projectRoot, 'composer.json'));
  entries.push(...flattenStrings(composer?.bin));
  for (const file of files.filter(file => file.endsWith('.go'))) {
    try {
      if (/^package\s+main\b/m.test(readFileSync(join(projectRoot, file), 'utf8'))) entries.push(file);
    } catch { /* optional */ }
  }
  return entries;
}

function detectRunners(projectRoot, files) {
  const runners = new Set(['node-test', 'python-unittest']);
  const packageJson = readJson(join(projectRoot, 'package.json'));
  const scripts = JSON.stringify(packageJson?.scripts || {});
  const dependencies = JSON.stringify({ ...packageJson?.dependencies, ...packageJson?.devDependencies });
  const pyproject = files.includes('pyproject.toml') ? readFileSync(join(projectRoot, 'pyproject.toml'), 'utf8') : '';
  const composer = readJson(join(projectRoot, 'composer.json'));
  const gemfile = files.includes('Gemfile') ? readFileSync(join(projectRoot, 'Gemfile'), 'utf8') : '';
  if (files.some(file => /(?:^|\/)(?:pytest\.ini|conftest\.py)$/.test(file)) || /pytest/i.test(pyproject)) runners.add('pytest');
  if (/jest/i.test(scripts + dependencies)) runners.add('jest');
  if (/vitest/i.test(scripts + dependencies)) runners.add('vitest');
  if (files.includes('go.mod')) runners.add('go-test');
  if (files.includes('vendor/bin/phpunit') || files.some(file => /phpunit\.xml/i.test(file)) || /phpunit/i.test(JSON.stringify(composer || {}))) runners.add('phpunit');
  if (/rspec/i.test(gemfile) || files.some(file => /(?:^|\/)\.rspec$/.test(file))) runners.add('rspec');
  return [...runners];
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
  return packageEntries(projectRoot, [...normalizedExplicit, ...configEntryFiles(projectRoot, files), ...common, ...mapped]);
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
  const repositoryFiles = listFiles(projectRoot);
  const allowedRunners = detectRunners(projectRoot, repositoryFiles);
  const context = {
    schema_version: 3,
    canonical_requirement: readFileSync(requirementPath, 'utf8'),
    requirement: readFileSync(requirementPath, 'utf8'),
    project: {
      root: projectRoot,
      name: basename(projectRoot),
      public_entries: discoverPublicEntries(projectRoot, requirementPath),
    },
    allowed_runners: allowedRunners,
    runner_guidance: {
      portable_black_box: 'node-test and python-unittest may spawn a public CLI or call an HTTP endpoint without modifying project files',
      project_native: allowedRunners.filter(runner => !['node-test', 'python-unittest'].includes(runner)),
    },
    output_contract: {
      directory: oracleDir,
      manifest: 'manifest.json',
      assertion_count: { minimum: 1, maximum: 12, rule: 'one assertion per independently observable requirement outcome; do not pad the count' },
      not_applicable_reason_codes: ['no_public_entry', 'unsupported_environment', 'requirement_not_observable'],
    },
  };
  writeFileSync(contextPath, `${JSON.stringify(context, null, 2)}\n`);
  return { status: 'prepared', oracle_dir: oracleDir, context_path: contextPath, manifest_path: manifestPath };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const ideaDir = process.argv[2] ? resolveExistingIdeaDirectory(process.argv[2], process.argv[3] || '.') : '';
  const projectRoot = resolve(process.argv[3] || '.');
  if (!ideaDir) fail('用法: oracle-prepare.mjs <idea-dir> [project-root]');
  console.log(JSON.stringify(prepareOracle(ideaDir, projectRoot)));
}
