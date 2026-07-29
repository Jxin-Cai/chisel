#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, extname } from 'node:path';

const DOC_EXTENSIONS = ['.md', '.rst', '.txt', '.adoc'];
const DOC_DIRS = ['docs', 'doc', 'documentation', 'wiki'];

function getBaseRef(ideaDir) {
  const wdPath = join(ideaDir, 'worktree-decision.json');
  if (!existsSync(wdPath)) return null;
  try {
    const wd = JSON.parse(readFileSync(wdPath, 'utf8'));
    return wd.base_ref || wd.base_branch || null;
  } catch { return null; }
}

function getChangedSymbols(baseRef) {
  try {
    const diff = execSync(
      baseRef ? `git diff ${baseRef}...HEAD --unified=0` : 'git diff HEAD~1 --unified=0',
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 5 * 1024 * 1024 }
    );
    const symbols = new Set();
    const funcPattern = /^[-+]\s*(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var|def|func|interface|type)\s+(\w+)/gm;
    let match;
    while ((match = funcPattern.exec(diff)) !== null) {
      if (match[1].length > 2) symbols.add(match[1]);
    }
    return [...symbols];
  } catch { return []; }
}

function findDocFiles(projectRoot) {
  const docs = [];
  const rootReadme = join(projectRoot, 'README.md');
  if (existsSync(rootReadme)) docs.push(rootReadme);

  for (const dir of DOC_DIRS) {
    const fullDir = join(projectRoot, dir);
    if (!existsSync(fullDir)) continue;
    try {
      const walk = (d) => {
        for (const entry of readdirSync(d, { withFileTypes: true })) {
          const full = join(d, entry.name);
          if (entry.isDirectory() && !entry.name.startsWith('.')) walk(full);
          else if (DOC_EXTENSIONS.includes(extname(entry.name))) docs.push(full);
        }
      };
      walk(fullDir);
    } catch { /* skip */ }
  }
  return docs;
}

export function checkDocSync(ideaDir, { baseRef = null } = {}) {
  const ref = baseRef || getBaseRef(ideaDir);
  const changedSymbols = getChangedSymbols(ref);
  if (changedSymbols.length === 0) return { stale_refs: [], note: 'no changed symbols detected' };

  const projectRoot = process.cwd();
  const docFiles = findDocFiles(projectRoot);
  const staleRefs = [];

  for (const docFile of docFiles) {
    const content = readFileSync(docFile, 'utf8');
    const lines = content.split('\n');
    for (const symbol of changedSymbols) {
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(symbol)) {
          staleRefs.push({
            file: docFile.replace(projectRoot + '/', ''),
            line: i + 1,
            ref: symbol,
            reason: `symbol "${symbol}" was modified but doc reference may be stale`,
          });
          break;
        }
      }
    }
  }

  return { stale_refs: staleRefs, checked_symbols: changedSymbols.length, checked_docs: docFiles.length };
}

function main() {
  const args = process.argv.slice(2);
  const ideaDir = args.find(a => !a.startsWith('--'));
  const baseRefIdx = args.indexOf('--base-ref');
  const baseRef = baseRefIdx !== -1 ? args[baseRefIdx + 1] : null;

  if (!ideaDir || args.includes('--help')) {
    console.log('用法: node doc-sync-check.mjs <idea-dir> [--base-ref <ref>]');
    process.exit(0);
  }

  if (!existsSync(ideaDir)) {
    process.stderr.write(`idea-dir not found: ${ideaDir}\n`);
    process.exit(1);
  }

  const result = checkDocSync(ideaDir, { baseRef });
  console.log(JSON.stringify(result, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
