#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { atomicWriteFile, ensureDir } from './workflow-lib.mjs';

const WIKI_FILES = [
  'index.md',
  'project-overview.md',
  'system-map.md',
  'glossary.md',
  'forbidden-zones.md',
  'weird-but-intentional.md',
  'do-not-refactor-yet.md',
  'hotspot-register.md',
  'adr-index.md'
];

const CATEGORY_TO_WIKI = {
  forbidden_zone: 'forbidden-zones.md',
  weird_but_intentional: 'weird-but-intentional.md',
  smell: 'do-not-refactor-yet.md',
  glossary: 'glossary.md'
};

const RELATION_SECTION = `
## 关联关系

| 关联条目 | 关系类型 | 说明 |
|---------|---------|------|
`;

function wikiDir(projectRoot) {
  return join(projectRoot, '.chisel', 'wiki');
}

function initWiki(projectRoot, pluginRoot) {
  const dir = wikiDir(projectRoot);
  ensureDir(dir);

  const templatePath = pluginRoot
    ? join(pluginRoot, 'skills/chisel-help/references/llm-wiki-index-template.md')
    : null;

  if (templatePath && existsSync(templatePath)) {
    const template = readFileSync(templatePath, 'utf8');
    atomicWriteFile(join(dir, 'index.md'), template);
  } else {
    atomicWriteFile(join(dir, 'index.md'), '# LLM Wiki Index\n\n请参考 llm-wiki-index-template.md 填充。\n');
  }

  for (const file of WIKI_FILES.slice(1)) {
    const filePath = join(dir, file);
    if (!existsSync(filePath)) {
      const title = file.replace('.md', '').split('-').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
      atomicWriteFile(filePath, `# ${title}\n${RELATION_SECTION}`);
    }
  }

  ensureDir(join(dir, 'modules'));
  console.log(JSON.stringify({ status: 'initialized', path: dir }));
}

function nextEntryId(content, prefix) {
  const regex = new RegExp(`### ${prefix}-(\\d+)`, 'g');
  let max = 0;
  let match;
  while ((match = regex.exec(content)) !== null) {
    max = Math.max(max, Number(match[1]));
  }
  return String(max + 1).padStart(3, '0');
}

function mergeCandidate(projectRoot, candidateFile) {
  if (!existsSync(candidateFile)) {
    process.stderr.write(`candidate file not found: ${candidateFile}\n`);
    process.exit(1);
  }

  const candidate = JSON.parse(readFileSync(candidateFile, 'utf8'));
  const category = candidate.category;
  const wikiFile = CATEGORY_TO_WIKI[category];
  if (!wikiFile) {
    process.stderr.write(`unknown category: ${category}\n`);
    process.exit(1);
  }

  const dir = wikiDir(projectRoot);
  const targetPath = join(dir, wikiFile);
  if (!existsSync(targetPath)) {
    process.stderr.write(`wiki file not found: ${targetPath}. Run --init first.\n`);
    process.exit(1);
  }

  let content = readFileSync(targetPath, 'utf8');
  const prefix = basename(wikiFile, '.md').toUpperCase().replace(/-/g, '_');
  const shortPrefix = { FORBIDDEN_ZONES: 'FZ', WEIRD_BUT_INTENTIONAL: 'WBI', DO_NOT_REFACTOR_YET: 'DNR', GLOSSARY: 'TERM' }[prefix] || prefix;
  const entryId = nextEntryId(content, shortPrefix);

  let entry = `\n### ${shortPrefix}-${entryId}\n\n`;
  if (candidate.content) {
    for (const [key, value] of Object.entries(candidate.content)) {
      entry += `**${key}：** ${Array.isArray(value) ? value.join(', ') : value}\n\n`;
    }
  }

  const relationMarker = '## 关联关系';
  if (content.includes(relationMarker)) {
    content = content.replace(relationMarker, entry + relationMarker);
  } else {
    content += entry + RELATION_SECTION;
  }

  atomicWriteFile(targetPath, content);
  console.log(JSON.stringify({ status: 'merged', file: wikiFile, entry_id: `${shortPrefix}-${entryId}` }));
}

function listEntries(projectRoot) {
  const dir = wikiDir(projectRoot);
  if (!existsSync(dir)) {
    console.log(JSON.stringify({ entries: [], status: 'wiki not initialized' }));
    return;
  }

  const entries = [];
  for (const [, wikiFile] of Object.entries(CATEGORY_TO_WIKI)) {
    const filePath = join(dir, wikiFile);
    if (!existsSync(filePath)) continue;
    const content = readFileSync(filePath, 'utf8');
    const regex = /### ([A-Z_]+-\d+)/g;
    let match;
    while ((match = regex.exec(content)) !== null) {
      entries.push({ id: match[1], file: wikiFile });
    }
  }
  console.log(JSON.stringify(entries, null, 2));
}

function addLink(projectRoot, file, entryId, relatedFile, relatedId, relationType) {
  const dir = wikiDir(projectRoot);
  const filePath = join(dir, file);
  if (!existsSync(filePath)) {
    process.stderr.write(`file not found: ${filePath}\n`);
    process.exit(1);
  }

  let content = readFileSync(filePath, 'utf8');
  const newRow = `| ${relatedFile}#${relatedId} | ${relationType} | — |\n`;

  if (content.includes('## 关联关系')) {
    const lines = content.split('\n');
    const sectionIdx = lines.indexOf('## 关联关系');
    let insertIdx = lines.length;
    for (let i = sectionIdx + 1; i < lines.length; i++) {
      if (lines[i].startsWith('|')) {
        insertIdx = i + 1;
      } else if (lines[i].trim() !== '' && !lines[i].startsWith('|')) {
        break;
      }
    }
    lines.splice(insertIdx, 0, newRow.trimEnd());
    content = lines.join('\n');
  } else {
    content += RELATION_SECTION + newRow;
  }

  atomicWriteFile(filePath, content);
  console.log(JSON.stringify({ status: 'linked', file, entry: entryId, related: `${relatedFile}#${relatedId}` }));
}

function main() {
  const args = process.argv.slice(2);
  const command = args[0];

  if (!command) {
    process.stderr.write('用法: wiki-manage.mjs <--init|--merge|--list|--link> [args...]\n');
    process.exit(1);
  }

  switch (command) {
    case '--init': {
      const projectRoot = args[1] || '.';
      const pluginRoot = args[2] || process.env.CLAUDE_PLUGIN_ROOT || '';
      initWiki(projectRoot, pluginRoot);
      break;
    }
    case '--merge': {
      const projectRoot = args[1] || '.';
      const candidateFile = args[2];
      if (!candidateFile) {
        process.stderr.write('用法: wiki-manage.mjs --merge <project-root> <candidate-file.json>\n');
        process.exit(1);
      }
      mergeCandidate(projectRoot, candidateFile);
      break;
    }
    case '--list': {
      const projectRoot = args[1] || '.';
      listEntries(projectRoot);
      break;
    }
    case '--link': {
      const [, projectRoot, file, entryId, relatedFile, relatedId, relationType] = args;
      if (!file || !entryId || !relatedFile || !relatedId || !relationType) {
        process.stderr.write('用法: wiki-manage.mjs --link <project-root> <file> <entry-id> <related-file> <related-id> <relation-type>\n');
        process.exit(1);
      }
      addLink(projectRoot, file, entryId, relatedFile, relatedId, relationType);
      break;
    }
    default:
      process.stderr.write(`unknown command: ${command}\n`);
      process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
