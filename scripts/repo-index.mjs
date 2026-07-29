#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, extname, basename, relative } from 'node:path';

const CODE_EXTENSIONS = ['.js', '.mjs', '.ts', '.tsx', '.jsx', '.vue', '.svelte', '.java', '.kt', '.py', '.go', '.rs', '.rb', '.php'];

const COMPONENT_PATTERNS = [
  { regex: /export\s+(?:default\s+)?(?:class|function)\s+(\w+)/g, type: 'export' },
  { regex: /export\s+const\s+(\w+)/g, type: 'export' },
  { regex: /@(?:Controller|RestController|RequestMapping)\s*\(['"]([^'"]+)['"]\)/g, type: 'route' },
  { regex: /(?:router|app)\.(get|post|put|delete|patch)\s*\(\s*['"]([^'"]+)['"]/g, type: 'route' },
  { regex: /@(?:Get|Post|Put|Delete|Patch)\s*\(['"]([^'"]+)['"]\)/g, type: 'route' },
  { regex: /path:\s*['"]([^'"]+)['"]/g, type: 'route' },
];

function indexFile(filePath, projectRoot) {
  const content = readFileSync(filePath, 'utf8');
  const relPath = relative(projectRoot, filePath);
  const components = [];

  for (const pattern of COMPONENT_PATTERNS) {
    const regex = new RegExp(pattern.regex.source, pattern.regex.flags);
    let match;
    while ((match = regex.exec(content)) !== null) {
      const name = pattern.type === 'route'
        ? (match[2] || match[1])
        : match[1];
      if (name && name.length > 1 && name.length < 80) {
        const line = content.substring(0, match.index).split('\n').length;
        components.push({ name, type: pattern.type, file: relPath, line });
      }
    }
  }
  return components;
}

function getAllCodeFiles(dir, exclude = ['.chisel', 'node_modules', '.git', 'dist', 'build', 'vendor']) {
  const results = [];
  function walk(d) {
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (exclude.includes(entry.name)) continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) { walk(full); }
      else if (CODE_EXTENSIONS.includes(extname(entry.name))) { results.push(full); }
    }
  }
  walk(dir);
  return results;
}

function getChangedFilesSince(sha) {
  try {
    return execSync(`git diff --name-only ${sha}..HEAD`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] })
      .trim().split('\n').filter(Boolean);
  } catch { return []; }
}

function getCurrentSha() {
  try { return execSync('git rev-parse HEAD', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim(); }
  catch { return null; }
}

export function buildIndex(projectRoot, { incremental = false, indexPath = null } = {}) {
  const outPath = indexPath || join(projectRoot, '.chisel/repo-index.json');
  let existing = { version: 1, updated_at: null, indexed_sha: null, components: [] };

  if (incremental && existsSync(outPath)) {
    try { existing = JSON.parse(readFileSync(outPath, 'utf8')); } catch { /* fresh start */ }
  }

  let filesToIndex;
  if (incremental && existing.indexed_sha) {
    const changed = getChangedFilesSince(existing.indexed_sha);
    filesToIndex = changed
      .filter(f => CODE_EXTENSIONS.includes(extname(f)))
      .map(f => join(projectRoot, f))
      .filter(f => existsSync(f));
    existing.components = existing.components.filter(c => !changed.includes(c.file));
  } else {
    filesToIndex = getAllCodeFiles(projectRoot);
    existing.components = [];
  }

  for (const file of filesToIndex) {
    existing.components.push(...indexFile(file, projectRoot));
  }

  existing.updated_at = new Date().toISOString();
  existing.indexed_sha = getCurrentSha();
  existing.version = 1;

  const outDir = join(outPath, '..');
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, JSON.stringify(existing, null, 2));
  return { indexed_files: filesToIndex.length, total_components: existing.components.length, path: outPath };
}

export function searchIndex(projectRoot, query, { indexPath = null } = {}) {
  const outPath = indexPath || join(projectRoot, '.chisel/repo-index.json');
  if (!existsSync(outPath)) return { results: [], note: 'index not found, run with --build first' };

  const index = JSON.parse(readFileSync(outPath, 'utf8'));
  const q = query.toLowerCase();
  const results = index.components.filter(c =>
    c.name.toLowerCase().includes(q) || c.file.toLowerCase().includes(q)
  ).slice(0, 30);

  return { results, total_matches: results.length };
}

function main() {
  const args = process.argv.slice(2);
  const projectRoot = process.cwd();

  if (args.includes('--help')) {
    console.log('用法: node repo-index.mjs [--build|--incremental|--search <query>]');
    process.exit(0);
  }

  if (args.includes('--build')) {
    const result = buildIndex(projectRoot);
    console.log(JSON.stringify(result, null, 2));
  } else if (args.includes('--incremental')) {
    const result = buildIndex(projectRoot, { incremental: true });
    console.log(JSON.stringify(result, null, 2));
  } else if (args.includes('--search')) {
    const idx = args.indexOf('--search');
    const query = args[idx + 1];
    if (!query) { process.stderr.write('--search requires a query\n'); process.exit(1); }
    const result = searchIndex(projectRoot, query);
    console.log(JSON.stringify(result, null, 2));
  } else {
    const result = buildIndex(projectRoot);
    console.log(JSON.stringify(result, null, 2));
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
