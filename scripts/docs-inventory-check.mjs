#!/usr/bin/env node
/**
 * Keep the public README inventory honest.  This is intentionally a small,
 * dependency-free check so it can run in CI and from an offline checkout.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
const READMES = ['README.md', 'README_zh.md'];
const COMPLEXITIES = ['hotfix', 'minor', 'trivial', 'moderate', 'standard', 'complex'];
const FORBIDDEN_DOC_TERMS = ['chisel-wiki', 'wiki-manage.mjs', '知识沉淀'];

function filesUnder(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

function collectInventory() {
  const scripts = new Set(filesUnder(join(ROOT, 'scripts'))
    .filter(file => file.endsWith('.mjs'))
    .map(file => relative(ROOT, file).replaceAll('\\', '/')));
  const skills = new Set(readdirSync(join(ROOT, 'skills'), { withFileTypes: true })
    .filter(entry => entry.isDirectory() && existsSync(join(ROOT, 'skills', entry.name, 'SKILL.md')))
    .map(entry => `skills/${entry.name}`));
  const agents = new Set(filesUnder(join(ROOT, 'agents'))
    .filter(file => file.endsWith('.md'))
    .map(file => relative(ROOT, file).replaceAll('\\', '/')));
  return { scripts, skills, agents };
}

function checkDocs({ root = ROOT } = {}) {
  const errors = [];
  const inventory = collectInventory();
  for (const readme of READMES) {
    const file = join(root, readme);
    if (!existsSync(file)) {
      errors.push(`${readme}: file missing`);
      continue;
    }
    const text = readFileSync(file, 'utf8');
    for (const term of FORBIDDEN_DOC_TERMS) {
      if (text.includes(term)) errors.push(`${readme}: stale reference '${term}'`);
    }

    // Backtick-delimited script names in the inventory must exist in scripts/.
    for (const match of text.matchAll(/`([A-Za-z0-9_-]+\.mjs)`/g)) {
      const name = match[1];
      if (!inventory.scripts.has(`scripts/${name}`)) errors.push(`${readme}: references missing scripts/${name}`);
    }
    // The skills table uses slash-prefixed public skill names.
    for (const match of text.matchAll(/`\/(chisel(?:-[a-z0-9-]+)?)`/g)) {
      const path = `skills/${match[1]}`;
      if (!inventory.skills.has(path)) errors.push(`${readme}: references missing ${path}`);
    }
    for (const complexity of COMPLEXITIES) {
      if (!new RegExp(`\\|\\s*\`${complexity}\`\\s*\\|`).test(text)) {
        errors.push(`${readme}: missing complexity row '${complexity}'`);
      }
    }
    // A six-level table should not claim that standard is the only default.
    if (/\|\s*`standard`\s*\|\s*Default\s*\|/i.test(text)) {
      errors.push(`${readme}: complexity table still describes standard as the only level`);
    }
  }
  return {
    valid: errors.length === 0,
    errors,
    inventory: {
      scripts: [...inventory.scripts].sort(),
      skills: [...inventory.skills].sort(),
      agents: [...inventory.agents].sort(),
    },
  };
}

export { checkDocs, collectInventory, COMPLEXITIES };

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = checkDocs();
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) process.exit(1);
}
