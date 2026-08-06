import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();

function filesUnder(directory) {
  if (!existsSync(directory)) return [];
  return readdirSync(directory).flatMap(entry => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

function json(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function referenceExists(reference) {
  if (!reference.includes('{')) return existsSync(join(ROOT, reference));
  const escaped = reference
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\\\{[^}]+\\\}/g, '[^/]+');
  return filesUnder(join(ROOT, 'skills'))
    .map(path => relative(ROOT, path).replaceAll('\\', '/'))
    .some(path => new RegExp(`^${escaped}$`).test(path));
}

describe('plugin structure', () => {
  it('uses chisel-core instead of an anonymous _shared skill', () => {
    const sourceFiles = [
      ...filesUnder(join(ROOT, 'skills')),
      ...filesUnder(join(ROOT, 'agents')),
      ...filesUnder(join(ROOT, 'hooks')),
      ...filesUnder(join(ROOT, 'scripts')),
    ];
    const staleReferences = sourceFiles
      .filter(path => /\.(?:md|json|mjs)$/.test(path))
      .filter(path => readFileSync(path, 'utf8').includes('skills/_shared'))
      .map(path => relative(ROOT, path));
    assert.deepEqual(staleReferences, []);
    assert.equal(existsSync(join(ROOT, 'skills/_shared')), false);
    assert.ok(existsSync(join(ROOT, 'skills/chisel-core/SKILL.md')));
    assert.ok(existsSync(join(ROOT, 'skills/chisel-core/references/agent-protocol.md')));
    assert.ok(existsSync(join(ROOT, 'skills/chisel-core/references/iron-rules.md')));
  });

  it('loads the public core skill before shared agent protocols', () => {
    const coreReference = '${CLAUDE_PLUGIN_ROOT}/skills/chisel-core/SKILL.md';
    const consumers = [
      join(ROOT, 'skills/chisel/SKILL.md'),
      ...filesUnder(join(ROOT, 'agents')).filter(path => path.endsWith('.md')),
    ];
    for (const path of consumers) {
      const content = readFileSync(path, 'utf8');
      assert.ok(content.includes(coreReference), `${relative(ROOT, path)} must load chisel-core/SKILL.md`);
    }
  });

  it('resolves every explicit plugin-root skill reference', () => {
    const markdownFiles = [
      ...filesUnder(join(ROOT, 'skills')),
      ...filesUnder(join(ROOT, 'agents')),
    ].filter(path => path.endsWith('.md'));
    const missing = [];
    const referencePattern = /\$\{CLAUDE_PLUGIN_ROOT\}\/((?:skills)\/[^`\s]+)/g;
    for (const source of markdownFiles) {
      const content = readFileSync(source, 'utf8');
      for (const match of content.matchAll(referencePattern)) {
        if (!referenceExists(match[1])) missing.push(`${relative(ROOT, source)} -> ${match[1]}`);
      }
    }
    assert.deepEqual(missing, []);
  });

  it('registers every agent and references only existing agent files', () => {
    const manifest = json(join(ROOT, '.claude-plugin/plugin.json'));
    const registered = new Set(manifest.agents.map(path => path.replace(/^\.\//, '')));
    const available = new Set(filesUnder(join(ROOT, 'agents')).filter(path => path.endsWith('.md')).map(path => relative(ROOT, path)));
    assert.deepEqual([...registered].sort(), [...available].sort());
    for (const path of registered) assert.ok(existsSync(join(ROOT, path)), `${path} is missing`);
  });

  it('keeps marketplace and plugin versions aligned', () => {
    const plugin = json(join(ROOT, '.claude-plugin/plugin.json'));
    const marketplace = json(join(ROOT, '.claude-plugin/marketplace.json'));
    const entry = marketplace.plugins.find(candidate => candidate.name === plugin.name);
    assert.ok(entry, `marketplace entry missing for ${plugin.name}`);
    assert.equal(entry.version, plugin.version);
  });
});
