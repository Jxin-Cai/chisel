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
  it('uses chisel-contracts instead of an anonymous _shared skill', () => {
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
    assert.ok(existsSync(join(ROOT, 'skills/chisel-contracts/SKILL.md')));
    assert.ok(existsSync(join(ROOT, 'skills/chisel-contracts/references/protocols/agent-protocol.md')));
    assert.ok(existsSync(join(ROOT, 'skills/chisel-contracts/references/protocols/iron-rules.md')));
  });

  it('loads the public contracts skill before shared agent protocols', () => {
    const coreReference = '${CLAUDE_PLUGIN_ROOT}/skills/chisel-contracts/SKILL.md';
    const sharedProtocol = '${CLAUDE_PLUGIN_ROOT}/skills/chisel-contracts/references/protocols/agent-protocol.md';
    const consumers = [
      join(ROOT, 'skills/chisel/SKILL.md'),
      ...filesUnder(join(ROOT, 'agents')).filter(path => path.endsWith('.md')),
    ];
    for (const path of consumers) {
      const content = readFileSync(path, 'utf8');
      if (!content.includes(sharedProtocol)) continue;
      assert.ok(content.includes(coreReference), `${relative(ROOT, path)} must load chisel-contracts/SKILL.md`);
      assert.ok(content.indexOf(coreReference) < content.indexOf(sharedProtocol), `${relative(ROOT, path)} must load contracts before the shared protocol`);
    }
  });

  it('keeps the coder on its minimal first-hand implementation contract', () => {
    const content = readFileSync(join(ROOT, 'agents/agent-chisel-coder.md'), 'utf8');
    assert.ok(content.includes('skills/chisel-implement/references/coder-instructions.md'));
    assert.equal(content.includes('references/protocols/agent-protocol.md'), false);
  });

  it('keeps the independent oracle small and outside shared workflow protocols', () => {
    const content = readFileSync(join(ROOT, 'agents/agent-chisel-oracle.md'), 'utf8');
    assert.ok(content.split('\n').length <= 30, 'oracle agent must stay within 30 lines');
    assert.equal(content.includes('references/protocols/agent-protocol.md'), false);
    assert.equal(content.includes('HARD-GATE'), false);
    assert.match(content, /只读取 TASK 指定的 `oracle_context_path`/);
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

  it('uses root agent auto-discovery instead of invalid manifest paths', () => {
    const manifest = json(join(ROOT, '.claude-plugin/plugin.json'));
    assert.equal(Object.hasOwn(manifest, 'agents'), false);
    const available = filesUnder(join(ROOT, 'agents')).filter(path => path.endsWith('.md'));
    assert.ok(available.length > 0, 'root agents directory must contain agent definitions');
  });

  it('uses runtime-compatible agent frontmatter', () => {
    for (const path of filesUnder(join(ROOT, 'agents')).filter(path => path.endsWith('.md'))) {
      const content = readFileSync(path, 'utf8');
      assert.match(content, /^model: (?:inherit|sonnet|opus|haiku)$/m, `${relative(ROOT, path)} model`);
      assert.match(content, /^color: (?:blue|cyan|green|yellow|magenta|red)$/m, `${relative(ROOT, path)} color`);
      assert.match(content, /^tools: \[/m, `${relative(ROOT, path)} tools must be a YAML array`);
      assert.equal(/^effort:/m.test(content), false, `${relative(ROOT, path)} has unsupported effort`);
      assert.equal(/^maxTurns:/m.test(content), false, `${relative(ROOT, path)} has unsupported maxTurns`);
    }
  });

  it('keeps marketplace and plugin versions aligned', () => {
    const plugin = json(join(ROOT, '.claude-plugin/plugin.json'));
    const marketplace = json(join(ROOT, '.claude-plugin/marketplace.json'));
    const entry = marketplace.plugins.find(candidate => candidate.name === plugin.name);
    assert.ok(entry, `marketplace entry missing for ${plugin.name}`);
    assert.equal(entry.version, plugin.version);
  });
});
