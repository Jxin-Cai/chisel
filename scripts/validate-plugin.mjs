#!/usr/bin/env node
/**
 * Offline metadata checks complement Claude Code's strict validator.  Keep the
 * shape deliberately explicit: this catches drift before a networked plugin
 * validator is invoked in CI.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(new URL('..', import.meta.url).pathname);
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

function readJson(file) {
  try {
    return { value: JSON.parse(readFileSync(file, 'utf8')) };
  } catch (error) {
    return { error: `${file}: ${error.message}` };
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function validatePlugin(plugin, root = ROOT) {
  const errors = [];
  const required = ['name', 'description', 'version', 'author', 'homepage', 'repository', 'license'];
  for (const key of required) if (!(key in plugin)) errors.push(`plugin.${key}: required`);
  if (!nonEmptyString(plugin.name)) errors.push('plugin.name: must be a non-empty string');
  if (!nonEmptyString(plugin.description)) errors.push('plugin.description: must be a non-empty string');
  if (!SEMVER.test(String(plugin.version || ''))) errors.push('plugin.version: must be semver');
  if (!isObject(plugin.author) || !nonEmptyString(plugin.author.name)) errors.push('plugin.author: name is required');
  if (!nonEmptyString(plugin.homepage)) errors.push('plugin.homepage: must be a non-empty string');
  if (!nonEmptyString(plugin.repository)) errors.push('plugin.repository: must be a non-empty string');
  if (!nonEmptyString(plugin.license)) errors.push('plugin.license: must be a non-empty string');
  for (const field of ['keywords', 'agents', 'skills']) {
    if (plugin[field] !== undefined && !Array.isArray(plugin[field])) errors.push(`plugin.${field}: must be an array`);
  }
  for (const field of ['agents', 'skills']) {
    for (const path of plugin[field] || []) {
      if (!nonEmptyString(path) || !path.startsWith('./') || !existsSync(join(root, path.slice(2)))) {
        errors.push(`plugin.${field}: referenced path does not exist: ${path}`);
      }
    }
  }
  return errors;
}

function validateMarketplace(marketplace, plugin) {
  const errors = [];
  for (const key of ['name', 'description', 'owner', 'plugins']) if (!(key in marketplace)) errors.push(`marketplace.${key}: required`);
  if (!nonEmptyString(marketplace.name)) errors.push('marketplace.name: must be a non-empty string');
  if (!isObject(marketplace.owner) || !nonEmptyString(marketplace.owner.name)) errors.push('marketplace.owner: name is required');
  if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length === 0) {
    errors.push('marketplace.plugins: must be a non-empty array');
    return errors;
  }
  const entry = marketplace.plugins.find(candidate => candidate?.name === plugin.name);
  if (!entry) {
    errors.push(`marketplace.plugins: missing entry for ${plugin.name}`);
    return errors;
  }
  for (const field of ['name', 'source', 'description', 'version']) {
    if (!nonEmptyString(entry[field])) errors.push(`marketplace.plugins[${plugin.name}].${field}: required`);
  }
  if (entry.source !== './') errors.push(`marketplace.plugins[${plugin.name}].source: expected './'`);
  if (entry.version !== plugin.version) errors.push(`marketplace.plugins[${plugin.name}].version: must match plugin.json (${plugin.version})`);
  for (const [index, candidate] of marketplace.plugins.entries()) {
    if (!isObject(candidate)) errors.push(`marketplace.plugins[${index}]: must be an object`);
    else if (!nonEmptyString(candidate.name)) errors.push(`marketplace.plugins[${index}].name: required`);
  }
  return errors;
}

export function validateMetadata({ root = ROOT } = {}) {
  const pluginFile = join(root, '.claude-plugin', 'plugin.json');
  const marketplaceFile = join(root, '.claude-plugin', 'marketplace.json');
  const errors = [];
  for (const file of [pluginFile, marketplaceFile]) if (!existsSync(file)) errors.push(`${file}: file not found`);
  if (errors.length) return { valid: false, errors };
  const pluginParsed = readJson(pluginFile);
  const marketplaceParsed = readJson(marketplaceFile);
  if (pluginParsed.error) errors.push(pluginParsed.error);
  if (marketplaceParsed.error) errors.push(marketplaceParsed.error);
  if (errors.length) return { valid: false, errors };
  errors.push(...validatePlugin(pluginParsed.value, root));
  errors.push(...validateMarketplace(marketplaceParsed.value, pluginParsed.value));
  return { valid: errors.length === 0, errors, plugin_version: pluginParsed.value.version };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const result = validateMetadata();
  console.log(JSON.stringify(result, null, 2));
  if (!result.valid) process.exit(1);
}
